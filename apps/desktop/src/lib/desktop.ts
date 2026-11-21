// What the desktop app (apps/desktop/electron) adds to the page when it shows this server's web
// app. Undefined in a browser, where the same code runs without it.

export interface DesktopBridge {
  /** The dock or launcher badge: unread chats, 0 to clear it. */
  setBadge(count: number): void
  /** Bring the app's window to the front, for a clicked notification. */
  focus(): void
  /** Node's name for the system: `darwin`, `win32`, `linux`. */
  platform: string
  /**
   * Open the app's server picker, as File → Change Server… does. Optional: the server's web
   * app can be newer than the installed desktop app, which may not have it.
   */
  changeServer?: () => void
}

export const desktop = (window as { trioditisDesktop?: DesktopBridge }).trioditisDesktop

/**
 * Which server a signed-out screen is on, and how to pick another: only in a desktop app that
 * can open its picker. A browser changes servers by going to another address, so it gets null.
 */
export function serverSwitcher(
  bridge: DesktopBridge | undefined,
  location: { host: string },
): { host: string; change: () => void } | null {
  const changeServer = bridge?.changeServer
  if (typeof changeServer !== 'function') return null
  // Called with nothing, never handed the click: an event can't cross into the app's preload.
  return { host: location.host, change: () => changeServer() }
}

/**
 * Why passkeys can't be used in the desktop app here, or null where they can (and always in a
 * browser). An unsigned Electron app can't reach the Mac's own passkeys (iCloud Keychain), and
 * Electron can't ask a security key for its PIN, which every passkey use here requires. On
 * Windows the system asks, so they work, as long as the page has WebAuthn at all.
 */
export function passkeysUnavailableIn(bridge: DesktopBridge | undefined, webAuthn: boolean): string | null {
  if (!bridge) return null
  if (bridge.platform !== 'win32')
    return `Passkeys don’t work in the desktop app on ${{ darwin: 'a Mac', linux: 'Linux' }[bridge.platform] ?? 'this system'} yet.`
  return webAuthn ? null : 'Passkeys don’t work in the desktop app on this system.'
}

/**
 * Said wherever a passkey is used, and its buttons are disabled with it: a passkey prompt that
 * can never finish would leave the person waiting on nothing.
 */
export const passkeysUnavailable = passkeysUnavailableIn(
  desktop,
  typeof (window as { PublicKeyCredential?: unknown }).PublicKeyCredential === 'function',
)

/**
 * The same invitation as a `trioditis://` link, which an installed desktop app opens
 * (apps/desktop/electron/links.ts), or null where the app couldn't reach this server from it:
 * the app takes a server on this machine as plain http and any other as https. Never in the
 * desktop app itself, which is already here.
 */
export function desktopInvitation(
  bridge: DesktopBridge | undefined,
  location: { protocol: string; hostname: string; host: string },
  email: string,
  token: string,
): string | null {
  if (bridge) return null
  const loopback = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(location.hostname)
  if (location.protocol !== (loopback ? 'http:' : 'https:')) return null
  return `trioditis://${location.host}/invite?${new URLSearchParams({ email })}#token=${encodeURIComponent(token)}`
}
