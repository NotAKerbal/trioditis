import { api } from '@trioditis/backend/api'
import type { Id } from '@trioditis/backend/dataModel'
import { Button } from '@trioditis/ui/button'
import { Textarea } from '@trioditis/ui/textarea'
import { useMutation } from 'convex/react'
import { AlertCircle, ChevronLeft, Loader2, Lock, RotateCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { errorMessage, sessionChanged } from '~/lib/errors.ts'
import { useSession } from '~/lib/session.tsx'
import {
  buttonName,
  clickCounter,
  keyMessage,
  MAX_TEXT,
  modifierBits,
  pageHost,
  CLOSE_REASONS,
  parseFrame,
  withGeneration,
  signinSocketUrl,
  toViewport,
  frameBox,
  wheelPixels,
  type Viewport,
} from './signin-input.ts'

// What an `error` message's code means for the person.
const ERRORS: Record<string, string> = {
  unsupported: 'This server can’t show the sign-in page.',
  busy: 'You already have a sign-in page open. Close it, then try again.',
}

const mac = /Mac|iPhone|iPad/.test(navigator.userAgent)

type State = { kind: 'connecting' } | { kind: 'live' } | { kind: 'done' } | { kind: 'failed'; message: string }

/**
 * The network's sign-in page, running in a browser on the server and shown here live: the
 * person signs in as they would anywhere, and the bridge host collects what the network needs.
 * See docs/architecture/signin-browser.md.
 */
export function SigninBrowser({
  loginSessionId,
  stepId,
  onPaste,
}: {
  loginSessionId: Id<'loginSessions'>
  stepId: string
  onPaste: () => void
}) {
  const session = useSession()
  const openBrowser = useMutation(api.logins.openBrowser)
  const [state, setState] = useState<State>({ kind: 'connecting' })
  const [page, setPage] = useState<{ url: string; loading: boolean } | null>(null)
  const [framed, setFramed] = useState(false)
  // Bumped by Try again: a new ticket and a new socket.
  const [attempt, setAttempt] = useState(0)
  const socket = useRef<WebSocket | null>(null)
  const area = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const typing = useRef<HTMLTextAreaElement>(null)
  // The page's viewport as the server applied it; input is in its coordinates.
  const viewport = useRef<Viewport | null>(null)
  const frame = useRef<ImageBitmap | null>(null)
  // The generation of the page in the frame shown: input names it, so it only reaches the page
  // the person saw, not one that has replaced it since.
  const shownGen = useRef(0)

  const send = <T extends { type: string }>(message: T) => {
    const ws = socket.current
    if (ws?.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(withGeneration(message, shownGen.current)))
  }

  // Draws the latest frame to fit the area, at the screen's resolution.
  const draw = () => {
    const el = canvas.current
    const image = frame.current
    const vp = viewport.current
    if (!el || !image || !vp) return
    const rect = el.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const width = Math.round(rect.width * dpr)
    const height = Math.round(rect.height * dpr)
    if (el.width !== width || el.height !== height) {
      el.width = width
      el.height = height
    }
    const ctx = el.getContext('2d')
    if (!ctx) return
    const box = frameBox(rect, vp)
    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(image, box.x * dpr, box.y * dpr, box.width * dpr, box.height * dpr)
  }

  useEffect(() => {
    let over = false
    let ws: WebSocket | null = null
    setState({ kind: 'connecting' })
    setPage(null)
    setFramed(false)
    viewport.current = null
    const fail = (message: string) => {
      if (!over) setState({ kind: 'failed', message })
    }
    // Frames decode out of order sometimes; only a newer one replaces what's shown.
    let decoded = 0
    let received = 0

    openBrowser({ loginSessionId, stepId, sessionId: session.sessionId }).then(
      ({ ticket, admission }) => {
        if (over) return
        ws = new WebSocket(signinSocketUrl(window.location, admission))
        ws.binaryType = 'arraybuffer'
        socket.current = ws
        ws.onopen = () => {
          ws?.send(JSON.stringify({ type: 'ticket', ticket }))
          sendViewport()
          typing.current?.focus({ preventScroll: true })
        }
        ws.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            const seq = ++received
            const { gen, jpeg } = parseFrame(event.data)
            createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' })).then(
              (image) => {
                if (over || seq < decoded) return image.close()
                decoded = seq
                frame.current?.close()
                frame.current = image
                shownGen.current = gen
                setFramed(true)
                draw()
              },
              () => undefined,
            )
            return
          }
          let message: { type?: string; [key: string]: unknown }
          try {
            message = JSON.parse(String(event.data))
          } catch {
            return
          }
          if (message.type === 'viewport') {
            viewport.current = {
              width: Number(message.width),
              height: Number(message.height),
              scale: Number(message.scale),
            }
            setState((s) => (s.kind === 'connecting' ? { kind: 'live' } : s))
            draw()
          } else if (message.type === 'page' && typeof message.url === 'string') {
            setPage({ url: message.url, loading: message.loading === true })
          } else if (message.type === 'done') {
            setState({ kind: 'done' })
          } else if (message.type === 'error') {
            fail(ERRORS[String(message.error)] ?? 'The sign-in page stopped working.')
          }
        }
        ws.onclose = (event) => {
          setState((s) =>
            over || s.kind === 'done' || s.kind === 'failed'
              ? s
              : { kind: 'failed', message: CLOSE_REASONS[event.code] ?? 'The sign-in page closed.' },
          )
        }
      },
      (e: unknown) => {
        if (sessionChanged(e)) return window.location.reload()
        fail(errorMessage(e, 'The sign-in page couldn’t open.'))
      },
    )

    // The page is as big as the area it's shown in, resized (shortly after) when that changes.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const sendViewport = () => {
      const rect = area.current?.getBoundingClientRect()
      if (!rect || rect.width === 0) return
      send({
        type: 'viewport',
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        scale: Math.min(2, window.devicePixelRatio || 1),
      })
    }
    const observer = new ResizeObserver(() => {
      draw()
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(sendViewport, 150)
    })
    if (area.current) observer.observe(area.current)

    return () => {
      over = true
      observer.disconnect()
      clearTimeout(resizeTimer)
      ws?.close()
      socket.current = null
      frame.current?.close()
      frame.current = null
    }
    // A new step or a retry is a new browser; the rest is read through refs.
  }, [loginSessionId, stepId, attempt])

  // Mouse, touch and wheel on the frame, in the page's coordinates.
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const at = (e: { clientX: number; clientY: number }) => {
      const vp = viewport.current
      if (!vp) return null
      const rect = el.getBoundingClientRect()
      return toViewport({ x: e.clientX - rect.left, y: e.clientY - rect.top }, rect, vp)
    }
    const count = clickCounter()
    let clicks = 1
    // A finger drags the page rather than selecting on it: a drag scrolls, a tap clicks.
    let touch: { x: number; y: number; moved: boolean } | null = null
    let pendingMove: PointerEvent | null = null
    let moveFrame = 0

    const mouse = (event: string, e: PointerEvent, point: { x: number; y: number }, extra: object = {}) =>
      send({
        type: 'mouse',
        event,
        x: point.x,
        y: point.y,
        button: 'none',
        buttons: e.buttons,
        clickCount: 0,
        deltaX: 0,
        deltaY: 0,
        modifiers: modifierBits(e, mac),
        ...extra,
      })

    const down = (e: PointerEvent) => {
      typing.current?.focus({ preventScroll: true })
      const point = at(e)
      if (!point) return
      e.preventDefault()
      el.setPointerCapture(e.pointerId)
      if (e.pointerType === 'touch') {
        touch = { x: e.clientX, y: e.clientY, moved: false }
        return
      }
      clicks = count(point.x, point.y, e.timeStamp)
      mouse('mousePressed', e, point, { button: buttonName(e.button), clickCount: clicks })
    }
    const up = (e: PointerEvent) => {
      const point = at(e)
      if (e.pointerType === 'touch') {
        const tap = touch && !touch.moved
        touch = null
        if (!tap || !point) return
        const left = { button: 'left', buttons: 1, clickCount: 1 }
        mouse('mousePressed', e, point, left)
        mouse('mouseReleased', e, point, { ...left, buttons: 0 })
        return
      }
      if (!point) return
      mouse('mouseReleased', e, point, { button: buttonName(e.button), clickCount: clicks })
    }
    const move = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        if (!touch) return
        const dx = touch.x - e.clientX
        const dy = touch.y - e.clientY
        if (!touch.moved && Math.hypot(dx, dy) < 8) return
        touch = { x: e.clientX, y: e.clientY, moved: true }
        const point = at(e)
        if (point) mouse('mouseWheel', e, point, { deltaX: dx, deltaY: dy })
        return
      }
      // At most one move a frame: the page doesn't need more, and the socket shouldn't queue them.
      pendingMove = e
      if (moveFrame) return
      moveFrame = requestAnimationFrame(() => {
        moveFrame = 0
        const last = pendingMove
        const point = last && at(last)
        if (last && point) mouse('mouseMoved', last, point)
      })
    }
    // Not passive, so the dialog doesn't scroll as well.
    const wheel = (e: WheelEvent) => {
      const point = at(e)
      if (!point) return
      e.preventDefault()
      send({
        type: 'mouse',
        event: 'mouseWheel',
        x: point.x,
        y: point.y,
        button: 'none',
        buttons: e.buttons,
        clickCount: 0,
        ...wheelPixels(e, viewport.current?.height ?? 600),
        modifiers: modifierBits(e, mac),
      })
    }
    // Nothing on the frame is the person's own browser's to act on: no menu, and no press that
    // takes focus from the input keys are read from.
    const menu = (e: Event) => e.preventDefault()
    el.addEventListener('pointerdown', down)
    el.addEventListener('mousedown', menu)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointermove', move)
    el.addEventListener('wheel', wheel, { passive: false })
    el.addEventListener('contextmenu', menu)
    return () => {
      cancelAnimationFrame(moveFrame)
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('contextmenu', menu)
      el.removeEventListener('mousedown', menu)
    }
    // send reads the socket through its ref.
  }, [])

  // Text typed or pasted into the hidden input goes to the page as text, then the input empties.
  const flushText = (el: HTMLTextAreaElement) => {
    if (el.value) send({ type: 'text', text: el.value.slice(0, MAX_TEXT) })
    el.value = ''
  }

  const host = page ? pageHost(page.url) : ''
  const live = state.kind === 'live'

  return (
    <div>
      <div className="overflow-hidden rounded-lg shadow-[0_0_0_1px_var(--border)] focus-within:shadow-[0_0_0_2px_var(--accent-ring)]">
        <div className="flex h-10 items-center gap-1 bg-surface-2 px-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Back"
            disabled={!live}
            onClick={() => send({ type: 'navigate', action: 'back' })}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Reload"
            disabled={!live}
            onClick={() => send({ type: 'navigate', action: 'reload' })}
          >
            {page?.loading ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
          </Button>
          {host ? (
            <span className="ml-1 flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
              <Lock className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate" aria-label={`Signing in on ${host}`}>
                {host}
              </span>
            </span>
          ) : null}
          {state.kind === 'connecting' || state.kind === 'live' ? (
            <Button
              variant="link"
              size="sm"
              className="ml-auto shrink-0 font-medium text-muted-foreground"
              onClick={onPaste}
            >
              Paste cookies instead
            </Button>
          ) : null}
        </div>
        {/* As tall as the settings dialog leaves room for, so its content doesn't scroll. */}
        <div ref={area} className="relative h-[440px] bg-surface">
          <canvas
            ref={canvas}
            className="absolute inset-0 size-full touch-none"
            aria-label={host ? `Sign-in page on ${host}` : 'Sign-in page'}
            role="img"
          />
          <Textarea
            ref={typing}
            variant="bare"
            aria-label="Type into the sign-in page"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="pointer-events-none absolute top-0 left-0 size-px min-w-0 opacity-0"
            onKeyDown={(e) => {
              const message = keyMessage(e, 'down', mac)
              if (!message) return
              e.preventDefault()
              send(message)
            }}
            onKeyUp={(e) => {
              const message = keyMessage(e, 'up', mac)
              if (message) send(message)
            }}
            onInput={(e) => {
              // Mid-composition (an IME, a dead key) the text isn't final yet.
              if (!(e.nativeEvent as InputEvent).isComposing) flushText(e.currentTarget)
            }}
            onCompositionEnd={(e) => flushText(e.currentTarget)}
            onPaste={(e) => {
              e.preventDefault()
              const text = e.clipboardData.getData('text/plain')
              if (text) send({ type: 'text', text: text.slice(0, MAX_TEXT) })
            }}
          />
          {state.kind === 'failed' ? (
            <div className="absolute inset-0 flex items-center justify-center bg-surface/95 p-6">
              <div className="text-center text-sm">
                <p className="flex items-start justify-center gap-2 text-danger">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" /> {state.message}
                </p>
                <div className="mt-3 flex justify-center gap-2">
                  <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
                    Try again
                  </Button>
                  <Button size="sm" variant="ghost" onClick={onPaste}>
                    Paste instead
                  </Button>
                </div>
              </div>
            </div>
          ) : state.kind === 'done' ? (
            <div
              className="absolute inset-0 flex items-center justify-center gap-2 bg-surface/90 text-sm"
              aria-live="polite"
            >
              <Loader2 className="size-4 animate-spin" /> Signing in…
            </div>
          ) : !framed ? (
            <div className="absolute inset-0 flex items-center justify-center" aria-busy="true">
              <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Opening the sign-in page" />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
