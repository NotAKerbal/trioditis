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
