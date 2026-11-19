// What the desktop app (apps/desktop/electron) adds to the page when it shows this server's web
// app. Undefined in a browser, where the same code runs without it.

export interface DesktopBridge {
  /** The dock or launcher badge: unread chats, 0 to clear it. */
  setBadge(count: number): void
  /** Bring the app's window to the front, for a clicked notification. */
  focus(): void
  /** Node's name for the system: `darwin`, `win32`, `linux`. */
  platform: string
}

export const desktop = (window as { trioditisDesktop?: DesktopBridge }).trioditisDesktop

/**
 * Said wherever a passkey is used, in the desktop app on a Mac or Linux, where passkeys don't
 * work. An unsigned Electron app can't reach the Mac's own passkeys (iCloud Keychain), and
 * Electron can't ask a security key for its PIN, which every passkey use here requires. On
 * Windows the system asks, so they work.
 */
export const passkeysUnavailable =
  desktop && desktop.platform !== 'win32'
    ? `Passkeys don’t work in the desktop app on ${{ darwin: 'a Mac', linux: 'Linux' }[desktop.platform] ?? 'this system'} yet.`
    : null
