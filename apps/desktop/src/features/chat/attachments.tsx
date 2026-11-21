import type { Attachment, Network } from '@trioditis/core'
import { Avatar } from '@trioditis/ui/avatar'
import { Button } from '@trioditis/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@trioditis/ui/dialog'
import { cn } from '@trioditis/ui/lib/utils'
import { Download, FileIcon, Play } from 'lucide-react'
import { useEffect, useState, type ComponentProps } from 'react'
import type { Chat } from '~/data/chats.ts'
import { isAudio, isImage, isVideo, loadsByItself, playable, saveMedia, useMedia } from '~/data/media.ts'
import { useSession } from '~/lib/session.tsx'

// A message's pictures and files, and avatars with their pictures, decrypted here (data/media.ts).

/** An Avatar showing its picture once it's decrypted, and initials until then or without one. */
export function MediaAvatar({
  network,
  picture,
  ...props
}: Omit<ComponentProps<typeof Avatar>, 'src'> & { network: Network; picture: Attachment | undefined }) {
  const media = useMedia(network, picture, !!picture && isImage(picture))
  return <Avatar {...props} src={media.url} />
}

/**
 * A chat's avatar: a direct chat's person's own People picture when their card has one, else
 * the picture the network gives the chat. People get circles, groups rounded squares.
 */
export function ChatAvatar({
  chat,
  ...props
}: Omit<ComponentProps<typeof Avatar>, 'src' | 'name' | 'shape'> & { chat: Chat }) {
  const shape = chat.row.kind === 'dm' ? 'circle' : 'square'
  if (chat.person?.photo) return <Avatar {...props} name={chat.name} shape={shape} src={chat.person.photo} />
  return <MediaAvatar {...props} network={chat.network} picture={chat.avatar} name={chat.name} shape={shape} />
}

const sizeFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${sizeFormat.format(bytes / 1024)} KB`
  return `${sizeFormat.format(bytes / (1024 * 1024))} MB`
}

/** The largest a picture is shown in a message, in CSS pixels. */
const MAX_W = 320
const MAX_H = 320

/** The shapes of pictures the network didn't give one for, once they've loaded here. */
const loadedShapes = new Map<string, { width: number; height: number }>()

/**
 * A picture's box, before it loads and after: its own shape when the network said it (or it has
 * loaded here before), scaled to fit, so a picture let go offscreen keeps its place in the list.
 */
function boxOf(a: Attachment) {
  const known = a.width && a.height && a.width > 0 && a.height > 0 ? { width: a.width, height: a.height } : undefined
  const shape = known ?? loadedShapes.get(a.mediaId)
  if (!shape) return undefined
  const scale = Math.min(1, MAX_W / shape.width, MAX_H / shape.height)
  // A very narrow or flat picture still gets a box that can be seen and clicked.
  return {
    width: Math.max(64, Math.round(shape.width * scale)),
    height: Math.max(64, Math.round(shape.height * scale)),
  }
}
const UNKNOWN_BOX = { width: 240, height: 180 }

/**
 * How far beyond the message list's edges a picture is loaded ahead, and kept. Further off, it's
 * let go, so a long chat of pictures holds only those near the view (the cache in data/media.ts
 * brings them back quickly).
 */
const NEAR_MARGIN = '1500px 0px'

/** Whether an element is near the view of the scroller it's in (`data-scroll-root`). */
function useNear() {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    if (!el) return
    const observer = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), {
      root: el.closest<HTMLElement>('[data-scroll-root]'),
      rootMargin: NEAR_MARGIN,
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])
  return [setEl, near] as const
}

export function Attachments({
  network,
  attachments,
  className,
}: {
  network: Network
  attachments: Attachment[]
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {attachments.map((a, i) =>
        a.failed ? (
          // A failed file has no media ID, so it's told apart by its place in the message.
          <UnavailableTile key={`failed-${i}`} attachment={a} />
        ) : isImage(a) ? (
          <Picture key={a.mediaId} network={network} attachment={a} />
        ) : (
          <FileTile key={a.mediaId} network={network} attachment={a} />
        ),
      )}
    </div>
  )
}

function Picture({ network, attachment }: { network: Network; attachment: Attachment }) {
  const [ref, near] = useNear()
  const [open, setOpen] = useState(false)
  // A picture too large to fetch by itself waits to be asked for.
  const [asked, setAsked] = useState(false)
  const wanted = loadsByItself(attachment) || asked
  const media = useMedia(network, attachment, wanted, near || open)
  // The file arrived, but this browser can't draw it (a HEIC from an iPhone, say, or a broken
  // file): it can still be saved and opened elsewhere.
  const [undrawable, setUndrawable] = useState<string | null>(null)
  const box = boxOf(attachment)
  const name = attachment.name || 'Photo'
  if (media.state === 'ready' && undrawable === media.url) {
    return <FileTile network={network} attachment={attachment} note="Can’t be shown here" />
  }
  if (!wanted || media.state === 'failed') {
    return (
      <Button
        ref={ref}
        variant="bare"
        type="button"
        onClick={() => (wanted ? media.load() : setAsked(true))}
        style={box ?? UNKNOWN_BOX}
        className="flex flex-col items-center justify-center gap-0.5 rounded-[14px] bg-muted px-3 text-sm text-muted-foreground hover:text-foreground"
      >
        {wanted ? (
          <>
            <span>The photo couldn’t be opened.</span>
            <span className="font-medium">Try again</span>
          </>
        ) : (
          `Show photo · ${fileSize(attachment.size)}`
        )}
      </Button>
    )
  }
  if (media.state !== 'ready') {
    return (
      <span
        ref={ref}
        role="img"
        aria-label={near ? `${name}, loading` : name}
        aria-busy={near}
        style={box ?? UNKNOWN_BOX}
        className={cn('block rounded-[14px] bg-muted', near && 'animate-pulse motion-reduce:animate-none')}
      />
    )
  }
  return (
    <>
      <Button
        ref={ref}
        variant="bare"
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open ${name}`}
        className="block overflow-hidden rounded-[14px] p-0"
      >
        <img
          src={media.url}
          alt={name}
          style={box ?? { maxWidth: MAX_W, maxHeight: MAX_H }}
          onError={() => setUndrawable(media.url)}
          onLoad={(e) => {
            const { naturalWidth: width, naturalHeight: height } = e.currentTarget
            if (!box && width && height) loadedShapes.set(attachment.mediaId, { width, height })
          }}
          className="block object-cover"
        />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="flex max-w-[calc(100vw-48px)] flex-col items-center gap-3 bg-surface p-4 pt-14"
          closeLabel="Close photo"
        >
          <DialogTitle className="absolute top-5 left-5 max-w-[calc(100%-6rem)] truncate text-md">{name}</DialogTitle>
          <img
            src={media.url}
            alt={name}
            className="max-h-[calc(100vh-160px)] max-w-[calc(100vw-80px)] rounded-[10px] object-contain"
          />
          <SaveButton network={network} attachment={attachment} name={name} label="Save" />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Saves a file under its own name, fetching and decrypting it again for the download. */
function SaveButton({
  network,
  attachment,
  name,
  label,
  className,
}: {
  network: Network
  attachment: Attachment
  name: string
  label?: string
  className?: string
}) {
  const session = useSession()
  const [state, setState] = useState<'idle' | 'saving' | 'failed'>('idle')
  const save = () => {
    setState('saving')
    saveMedia(session.userId, network, attachment, name).then(
      () => setState('idle'),
      () => setState('failed'),
    )
  }
  return (
    <Button
      variant="bare"
      type="button"
      aria-label={label ? undefined : `Save ${name}`}
      title={state === 'failed' ? 'It couldn’t be saved. Try again.' : undefined}
      disabled={state === 'saving'}
      onClick={save}
      className={cn(
        'inline-flex items-center gap-1.5 text-sm hover:text-foreground disabled:opacity-50',
        state === 'failed' ? 'text-danger' : label ? 'text-primary-ink' : 'text-muted-foreground',
        className,
      )}
    >
      <Download className={label ? 'size-3.5' : 'size-4'} />
      {label ? (state === 'failed' ? 'Try again' : state === 'saving' ? 'Saving…' : label) : null}
    </Button>
  )
}

/** What a file's tile says under its name: why it isn't shown, how it's doing, or its size. */
export function tileStatus({
  note,
  cantPlay,
  state,
  size,
}: {
  note?: string
  cantPlay: boolean
  state: 'idle' | 'loading' | 'ready' | 'failed'
  size: number
}) {
  if (note) return note
  if (cantPlay) return 'Can’t be played here'
  if (state === 'failed') return 'Couldn’t be opened'
  if (state === 'loading') return 'Opening…'
  return fileSize(size)
}

/**
 * Any other file: its name and size, and what can be done with it. Video and sound small enough
 * play in place when asked, and can be saved too; anything else is saved. `note` replaces the
 * size, for a picture shown as a file because it can't be drawn.
 */
function FileTile({ network, attachment, note }: { network: Network; attachment: Attachment; note?: string }) {
  const canPlay = playable(attachment) && !note
  const media = useMedia(network, canPlay ? attachment : undefined, false)
  // Played media this browser can't decode (a codec it lacks, or a broken file) falls back to
  // the tile, which says so and keeps Save.
  const [undecodable, setUndecodable] = useState<string | null>(null)
  const name = attachment.name || (isVideo(attachment) ? 'Video' : isAudio(attachment) ? 'Audio' : 'File')
  const cantPlay = media.state === 'ready' && undecodable === media.url

  if (media.state === 'ready' && !cantPlay && isVideo(attachment)) {
    return (
      <span className="flex flex-col items-start gap-1">
        <video
          src={media.url}
          controls
          autoPlay
          onError={() => setUndecodable(media.url)}
          className="max-h-[360px] max-w-[min(100%,480px)] rounded-[14px]"
        />
        <SaveButton network={network} attachment={attachment} name={name} label="Save" />
      </span>
    )
  }
  if (media.state === 'ready' && !cantPlay && isAudio(attachment)) {
    return (
      <span className="flex flex-col items-start gap-1">
        <audio src={media.url} controls autoPlay onError={() => setUndecodable(media.url)} className="max-w-full" />
        <SaveButton network={network} attachment={attachment} name={name} label="Save" />
      </span>
    )
  }
  const broken = media.state === 'failed'
  return (
    <span className="flex max-w-[320px] items-center gap-3 rounded-[14px] bg-surface px-3 py-2.5 text-foreground shadow-[0_0_0_1px_var(--border)]">
      <FileIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block text-xs text-subtle-foreground">
          {tileStatus({ note, cantPlay, state: media.state, size: attachment.size })}
        </span>
      </span>
      {canPlay && !cantPlay ? (
        <Button
          variant="bare"
          type="button"
          aria-label={`Play ${name}`}
          title={broken ? 'Try again' : undefined}
          disabled={media.state === 'loading'}
          onClick={media.load}
          className="flex size-7 items-center justify-center rounded-full text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <Play className="size-4" />
        </Button>
      ) : null}
      <SaveButton
        network={network}
        attachment={attachment}
        name={name}
        className="size-7 justify-center rounded-full"
      />
    </span>
  )
}

/**
 * A file that arrived but the bridge host couldn't keep: its name says what was sent, and there's
 * nothing to open, play or save, so it offers none of those.
 */
function UnavailableTile({ attachment }: { attachment: Attachment }) {
  const name =
    attachment.name ||
    (isImage(attachment) ? 'Photo' : isVideo(attachment) ? 'Video' : isAudio(attachment) ? 'Audio' : 'File')
  return (
    <span className="flex max-w-[320px] items-center gap-3 rounded-[14px] bg-surface px-3 py-2.5 text-foreground shadow-[0_0_0_1px_var(--border)]">
      <FileIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block text-xs text-subtle-foreground">Not available</span>
      </span>
    </span>
  )
}
