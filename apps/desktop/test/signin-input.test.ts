import { imeEscape } from '@trioditis/ui/lib/ime'
import { describe, expect, it } from 'vitest'
import {
  buttonName,
  clickCounter,
  frameBox,
  imeKeys,
  keyMessage,
  modifierBits,
  pageHost,
  parseFrame,
  signinSocketUrl,
  withGeneration,
  toViewport,
  wheelPixels,
} from '../src/features/settings/signin-input.ts'

const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
const key = (k: string, code: string, mods: Partial<typeof none> = {}) => ({ ...none, ...mods, key: k, code })

describe('the sign-in browser’s socket', () => {
  it('is on the page’s own origin, secure when the page is', () => {
    expect(signinSocketUrl({ protocol: 'https:', host: 'chat.example' }, 'p.1.m')).toBe(
      'wss://chat.example/login-browser?admission=p.1.m',
    )
    expect(signinSocketUrl({ protocol: 'http:', host: 'localhost:5180' }, 'a+b')).toBe(
      'ws://localhost:5180/login-browser?admission=a%2Bb',
    )
  })
})

describe('modifier bits', () => {
  it('are CDP’s: Alt 1, Ctrl 2, Meta 4, Shift 8', () => {
    expect(modifierBits(none, false)).toBe(0)
    expect(modifierBits({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true }, false)).toBe(15)
  })

  it('send a Mac’s Cmd as Ctrl, since the browser runs on Linux', () => {
    expect(modifierBits({ ...none, metaKey: true }, true)).toBe(2)
    expect(modifierBits({ ...none, metaKey: true, shiftKey: true }, true)).toBe(10)
    expect(modifierBits({ ...none, metaKey: true }, false)).toBe(4)
  })
})

describe('pointer coordinates', () => {
  const viewport = { width: 800, height: 600, scale: 2 }

  it('fit the frame in the area, centred', () => {
    expect(frameBox({ width: 400, height: 600 }, viewport)).toEqual({ x: 0, y: 150, width: 400, height: 300 })
    expect(frameBox({ width: 800, height: 600 }, viewport)).toEqual({ x: 0, y: 0, width: 800, height: 600 })
  })

  it('map a point on the drawn frame to the page’s viewport', () => {
    const area = { width: 400, height: 600 }
    expect(toViewport({ x: 200, y: 300 }, area, viewport)).toEqual({ x: 400, y: 300 })
    expect(toViewport({ x: 0, y: 150 }, area, viewport)).toEqual({ x: 0, y: 0 })
    expect(toViewport({ x: 400, y: 450 }, area, viewport)).toEqual({ x: 800, y: 600 })
  })

  it('are nothing off the frame', () => {
    expect(toViewport({ x: 200, y: 100 }, { width: 400, height: 600 }, viewport)).toBeNull()
  })

  it('name buttons as CDP does', () => {
    expect([0, 1, 2, 3].map(buttonName)).toEqual(['left', 'middle', 'right', 'none'])
  })

  it('turn wheel lines and pages into pixels', () => {
    expect(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 600)).toEqual({ deltaX: 0, deltaY: 48 })
    expect(wheelPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 600)).toEqual({ deltaX: 0, deltaY: 600 })
    expect(wheelPixels({ deltaX: 5, deltaY: -7, deltaMode: 0 }, 600)).toEqual({ deltaX: 5, deltaY: -7 })
  })

  it('count a quick second press in the same place as a double click', () => {
    const count = clickCounter()
    expect(count(10, 10, 0)).toBe(1)
    expect(count(11, 10, 200)).toBe(2)
    expect(count(11, 11, 400)).toBe(3)
    expect(count(11, 11, 2000)).toBe(1)
    expect(count(50, 50, 2100)).toBe(1)
  })
})

describe('keys', () => {
  it('leave an IME’s presses with it, held and released, after its composition ends', () => {
    const enter = (isComposing: boolean, repeat = false, keyCode = 13) => ({
      isComposing,
      keyCode,
      code: 'Enter',
      repeat,
    })
    const ime = imeKeys()
    expect(ime.down(enter(true))).toBe(true)
    // Held past the candidate it confirmed: its repeats and release are still the IME's.
    expect(ime.down(enter(false, true))).toBe(true)
    expect(ime.up(enter(false))).toBe(true)
    expect(ime.down(enter(false))).toBe(false)
    expect(ime.up(enter(false))).toBe(false)
    // Safari marks the key that ends a composition with 229 instead.
    expect(ime.down(enter(false, false, 229))).toBe(true)
    // A press whose release never came doesn't take the next one's.
    expect(ime.down(enter(false))).toBe(false)
    expect(ime.up(enter(false))).toBe(false)
  })

  it('keep an Escape held through a composition from closing the dialog', () => {
    const escape = (isComposing: boolean, repeat = false, keyCode = 27) => ({ isComposing, keyCode, repeat })
    expect(imeEscape(escape(true))).toBe(true)
    expect(imeEscape(escape(false, false, 229))).toBe(true)
    // The composition ended under the held key: its repeats still aren't a press of its own.
    expect(imeEscape(escape(false, true))).toBe(true)
    expect(imeEscape(escape(false))).toBe(false)
  })

  it('leave text to the input it’s typed into', () => {
    expect(keyMessage(key('a', 'KeyA'), 'down', false)).toBeNull()
    expect(keyMessage(key('A', 'KeyA', { shiftKey: true }), 'down', false)).toBeNull()
    expect(keyMessage(key('é', 'KeyE', { altKey: true }), 'down', true)).toBeNull()
  })

  it('send special keys down raw and up, with their key codes', () => {
    expect(keyMessage(key('Backspace', 'Backspace'), 'down', false)).toEqual({
      type: 'key',
      event: 'rawKeyDown',
      key: 'Backspace',
      code: 'Backspace',
      keyCode: 8,
      modifiers: 0,
    })
    expect(keyMessage(key('Tab', 'Tab', { shiftKey: true }), 'up', false)).toEqual({
      type: 'key',
      event: 'keyUp',
      key: 'Tab',
      code: 'Tab',
      keyCode: 9,
      modifiers: 8,
    })
    expect(keyMessage(key('ArrowDown', 'ArrowDown'), 'down', false)?.keyCode).toBe(40)
  })

  it('send Enter down with its text, which submits a form', () => {
    expect(keyMessage(key('Enter', 'Enter'), 'down', false)).toMatchObject({
      event: 'keyDown',
      keyCode: 13,
      text: '\r',
    })
  })

  it('pass editing shortcuts on, with a Mac’s Cmd as Ctrl', () => {
    expect(keyMessage(key('a', 'KeyA', { ctrlKey: true }), 'down', false)).toEqual({
      type: 'key',
      event: 'rawKeyDown',
      key: 'a',
      code: 'KeyA',
      keyCode: 65,
      modifiers: 2,
    })
    expect(keyMessage(key('z', 'KeyZ', { metaKey: true, shiftKey: true }), 'down', true)).toMatchObject({
      keyCode: 90,
      modifiers: 10,
    })
    // Cmd on anything but a Mac isn't a shortcut here.
    expect(keyMessage(key('a', 'KeyA', { metaKey: true }), 'down', false)).toBeNull()
  })

  it('leave paste to the paste event, which has the clipboard’s text', () => {
    expect(keyMessage(key('v', 'KeyV', { ctrlKey: true }), 'down', false)).toBeNull()
    expect(keyMessage(key('v', 'KeyV', { metaKey: true }), 'down', true)).toBeNull()
  })
})

describe('the page’s address', () => {
  it('shows its host', () => {
    expect(pageHost('https://www.facebook.com/login/?next=x')).toBe('facebook.com')
    expect(pageHost('https://accounts.google.com/')).toBe('accounts.google.com')
    expect(pageHost('not a url')).toBe('')
  })
})

describe('page generations', () => {
  it('reads a frame’s generation and JPEG', () => {
    const data = new Uint8Array([0, 0, 1, 2, 0xff, 0xd8, 0xff])
    const { gen, jpeg } = parseFrame(data.buffer)
    expect(gen).toBe(258)
    expect([...new Uint8Array(jpeg)]).toEqual([0xff, 0xd8, 0xff])
  })

  it('puts the generation on input only', () => {
    expect(withGeneration({ type: 'text', text: 'a' }, 7)).toEqual({ type: 'text', text: 'a', gen: 7 })
    expect(withGeneration({ type: 'mouse', event: 'mouseMoved' }, 7)).toMatchObject({ gen: 7 })
    expect(withGeneration({ type: 'viewport', width: 1 }, 7)).toEqual({ type: 'viewport', width: 1 })
    expect(withGeneration({ type: 'ticket', ticket: 't' }, 7)).toEqual({ type: 'ticket', ticket: 't' })
  })
})
