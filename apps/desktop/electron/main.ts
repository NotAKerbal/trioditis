import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { dotBitmap } from './badge.ts'
import { invitationFrom, linkArgument, PROTOCOL, type Invitation } from './links.ts'
import {
  isExternalAllowed,
  normalizeServer,
  pageIsReady,
  proxyCouldNotReach,
  quitsWhenAllClosed,
  sameOrigin,
  serverKind,
  TOO_OLD,
  unreachableMessage,
} from './server.ts'

// The desktop app: a window onto one Trioditis server's web app, with native notifications,
// a dock badge and a menu. Nothing from the server runs with Node: its pages are sandboxed and
// reach the app only through the preload's calls, each checked here.

app.setName('Trioditis')
app.setPath('userData', path.join(app.getPath('appData'), 'Trioditis'))
// Windows shows notifications only for an app with an ID.
if (process.platform === 'win32') app.setAppUserModelId('org.trioditis.desktop')
// Invitation links (links.ts). An installed app declares the scheme in its package on a Mac and
// Linux (electron-builder.yml); Windows' installer doesn't, so the app claims it as it starts.
// Never from a development run, which would point the system at node_modules.
if (process.platform === 'win32' && app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL)

const here = import.meta.dirname
const preload = path.join(here, 'preload.cjs')
const connectPage = path.join(here, '../electron/connect.html')
const webPreferences = { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false }
// Windows open at once, in the theme's background (the tokens' --bg), rather than waiting for
// ready-to-show: on some Wayland compositors a hidden window never paints, so it never fires.
const background = () => (nativeTheme.shouldUseDarkColors ? '#0f1115' : '#ffffff')

interface Settings {
  server?: string
}

let settings: Settings = {}
let serverWindow: BrowserWindow | null = null
let serverOrigin: string | null = null
let connectWindow: BrowserWindow | null = null
/** Counts connect attempts; cancelling or closing the picker starts a new count. */
let attempt = 0
/** A checked server is being saved and opened: from here the picker can't be cancelled or closed. */
let committing = false
let quitting = false
/** Set while the app closes the server's window to change servers: told if the person stays. */
let onStay: (() => void) | null = null
/** That window, which a Mac must close rather than hide. */
let leaving: BrowserWindow | null = null
/** Set once the app has opened its first window: a link before then waits for it. */
let started = false
let waitingLink: Invitation | null = null

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')

async function loadSettings(): Promise<Settings> {
  try {
    const saved = JSON.parse(await readFile(settingsFile(), 'utf8')) as Settings
    return typeof saved.server === 'string' ? { server: saved.server } : {}
  } catch {
    return {}
  }
}

async function saveSettings(next: Settings) {
  const file = settingsFile()
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  // Written beside and renamed into place, so a crash never leaves half a file.
  await writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 })
  await rename(`${file}.tmp`, file)
  settings = next
}

/** A command-line server (`--server <url>`), for development: used for this run, not saved. */
function serverArgument(): string | undefined {
  const args = process.argv
  const i = args.findIndex((a) => a === '--server' || a.startsWith('--server='))
  if (i < 0) return undefined
  const arg = args[i]!
  return arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[i + 1]
}

// Each server gets its own session, so cookies and storage never cross between servers.
const prepared = new Set<string>()
const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen'])

function partitionFor(origin: string): string {
  const partition = `persist:server-${createHash('sha256').update(origin).digest('hex').slice(0, 16)}`
  if (!prepared.has(partition)) {
    prepared.add(partition)
    // No HTTP cache: nothing a server sends is written to disk for reuse. The web app already
    // keeps decrypted files in memory only (src/data/media.ts) and fetches media uncached, but
    // a server's other answers (sign-in, its pages) aren't the app's to judge. Older versions
    // cached, so what they left is cleared.
    const ses = session.fromPartition(partition, { cache: false })
    void ses.clearCache()
    ses.setPermissionRequestHandler((_contents, permission, callback, details) =>
      callback(ALLOWED_PERMISSIONS.has(permission) && sameOrigin(details.requestingUrl, origin)),
    )
    ses.setPermissionCheckHandler(
      (_contents, permission, requestingOrigin) =>
        ALLOWED_PERMISSIONS.has(permission) && sameOrigin(requestingOrigin, origin),
    )
  }
  return partition
}

function openExternal(target: string) {
  if (isExternalAllowed(target)) void shell.openExternal(target)
}

/**
 * The server's pages stay on its origin, frames included. A link elsewhere opens in the
 * system's browser; a frame that would load another origin doesn't load.
 */
function keepOnOrigin(contents: WebContents, origin: string) {
  contents.on('will-frame-navigate', (event) => {
    if (sameOrigin(event.url, origin)) return
    event.preventDefault()
    if (event.isMainFrame) openExternal(event.url)
  })
  contents.on('will-redirect', (event) => {
    if (!sameOrigin(event.url, origin)) event.preventDefault()
  })
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
}

/** The unread badge: a count in the Dock or launcher, and a dot on Windows' taskbar button. */
function showBadge(count: number) {
  app.setBadgeCount(count)
  if (process.platform !== 'win32' || !serverWindow || serverWindow.isDestroyed()) return
  const dot = count > 0 ? nativeImage.createFromBitmap(dotBitmap(32), { width: 32, height: 32, scaleFactor: 2 }) : null
  serverWindow.setOverlayIcon(dot, count > 0 ? `${count} unread` : '')
}

/**
 * A page that crashes or hangs: the person is told and can reload it, rather than looking at a
 * blank or frozen window. Logged by reason only, never the page's address, which can hold an
 * invitation's token.
 */
function watchPage(win: BrowserWindow, name: string) {
  let restarting = false
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`The ${name} page stopped (${details.reason}, exit code ${details.exitCode}).`)
    if (restarting || details.reason === 'clean-exit' || win.isDestroyed()) return
    void dialog
      .showMessageBox(win, {
        type: 'error',
        buttons: ['Reload', 'Close'],
        defaultId: 0,
        cancelId: 1,
        message: 'Trioditis stopped working',
        detail: 'The window stopped unexpectedly. Reload it to carry on. Messages you hadn’t sent are lost.',
      })
      .then(({ response }) => {
        if (win.isDestroyed()) return
        if (response === 0) win.webContents.reload()
        else win.close()
      })
  })
  let waiting: AbortController | null = null
  win.on('unresponsive', () => {
    if (waiting || win.isDestroyed()) return
    console.error(`The ${name} page stopped responding.`)
    waiting = new AbortController()
    void dialog
      .showMessageBox(win, {
        type: 'warning',
        buttons: ['Wait', 'Reload'],
        defaultId: 0,
        cancelId: 0,
        message: 'Trioditis isn’t responding',
        detail: 'You can wait for it, or reload the window. Reloading loses messages you haven’t sent.',
        signal: waiting.signal,
      })
      .then(({ response }) => {
        waiting = null
        if (response !== 1 || win.isDestroyed()) return
        // A hung page can't run its own unload, so it is stopped first; that isn't a crash to
        // ask about again.
        restarting = true
        win.webContents.forcefullyCrashRenderer()
        win.webContents.reload()
        win.webContents.once('did-finish-load', () => (restarting = false))
      })
  })
  // Came back by itself: the question is moot.
  win.on('responsive', () => {
    waiting?.abort()
    waiting = null
  })
}

function openServer(origin: string, url = `${origin}/`) {
  const previous = serverWindow
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: 'Trioditis',
    backgroundColor: background(),
    webPreferences: { ...webPreferences, partition: partitionFor(origin), spellcheck: true },
  })
  serverWindow = win
  serverOrigin = origin
  keepOnOrigin(win.webContents, origin)
  watchPage(win, 'server')
  let loaded = false
  // The status of the page now loading, so a server's error page (mid-update, say) or the
  // network's (offline) isn't taken for an old web app. Each load starts with none; a failed
  // one shows an error page without ever getting one.
  let status = 0
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) status = 0
  })
  win.webContents.on('did-navigate', (_event, _url, code) => (status = code))
  win.webContents.on('did-finish-load', () => {
    // A proxy's error page for a server that's down loads like any page: at start, it's the picker
    // with Retry, as when the server can't be reached at all.
    if (!loaded && proxyCouldNotReach(status) && serverWindow === win) {
      serverWindow = null
      showConnect(unreachableMessage(origin, `it answered ${status}`))
      win.destroy()
      return
    }
    loaded = true
    if (status < 200 || status >= 300) return
    // The picker checked the server, but a saved one, `--server` or a reload can bring an older
    // web app, which would lose unsent text without asking: back to the picker before anything
    // is typed.
    void win.webContents
      .executeJavaScript(pageIsReady)
      .catch(() => true)
      .then((ready) => {
        if (ready || serverWindow !== win) return
        serverWindow = null
        showConnect(TOO_OLD)
        win.destroy()
      })
  })
  // The page holds unsent text (src/features/shell/keep-unsent.ts), and is being reloaded,
  // closed or left for another server: the person decides.
  win.webContents.on('will-prevent-unload', (event) => {
    reveal(win)
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      message: 'Leave without sending?',
      detail: 'You have messages you haven’t sent. If you leave, they’re lost.',
    })
    if (choice === 0) return event.preventDefault()
    // Staying also stops a quit, and a change of server.
    quitting = false
    onStay?.()
  })
  // A server that can't be reached at start: back to the picker, saying why. Once the app has
  // loaded, a failed reload stays put; the person can reload when the server is back.
  win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) status = 0
    // -3 is a navigation replaced by another, not a failure.
    if (!isMainFrame || loaded || code === -3 || serverWindow !== win) return
    serverWindow = null
    // The picker opens first: with no window left for a moment, the app would quit.
    showConnect(unreachableMessage(origin, description))
    win.destroy()
  })
  // On a Mac, closing the window keeps the app running for notifications, as Mac apps do.
  win.on('close', (event) => {
    if (process.platform === 'darwin' && !quitting && serverWindow === win && leaving !== win) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    if (serverWindow === win) serverWindow = null
  })
  void win.loadURL(url)
  showBadge(0)
  previous?.destroy()
}

/** Closes the server's window, if its page lets it go: false if the person chose to stay. */
function closeServer(win: BrowserWindow): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (left: boolean) => {
      onStay = null
      leaving = null
      win.off('closed', closed)
      resolve(left)
    }
    const closed = () => finish(true)
    onStay = () => finish(false)
    // Still the server's window until it's gone, so the Dock or a second launch shows it
    // rather than opening another.
    leaving = win
    win.once('closed', closed)
    win.close()
  })
}

function showConnect(error?: string) {
  const query = error ? { error } : undefined
  if (connectWindow) {
    // Reloaded only to say why, and never while a server is being saved: a reload would offer
    // Connect again mid-save.
    if (query && !committing) void connectWindow.loadFile(connectPage, { query })
    connectWindow.show()
    connectWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 480,
    height: 440,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Connect to a server',
    backgroundColor: background(),
    webPreferences,
  })
  connectWindow = win
  watchPage(win, 'connect')
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.on('close', (event) => {
    if (!committing) return
    event.preventDefault()
    // That also stops a quit.
    quitting = false
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('closed', () => {
    attempt++
    if (connectWindow === win) connectWindow = null
  })
  void win.loadFile(connectPage, query ? { query } : {})
}

/** Why `origin` isn't a Trioditis server the app can use, or null when it is. */
async function probe(origin: string): Promise<string | null> {
  // Redirects are refused, not followed: the window would refuse to leave the origin anyway,
  // and Electron's fetch doesn't say where a followed one ended up.
  const get = (url: string) =>
    net.fetch(url, { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  try {
    const page = await get(`${origin}/`)
    if (proxyCouldNotReach(page.status)) return unreachableMessage(origin, `it answered ${page.status}`)
    const html = page.ok ? await page.text() : undefined
    if (serverKind({ html }) === 'ready') return null
    // The self-hosted bundle publishes /config.json, from before the desktop app too.
    const config = await get(`${origin}/config.json`)
    const json: unknown =
      config.ok && config.headers.get('content-type')?.includes('json') ? await config.json().catch(() => null) : null
    if (serverKind({ html, config: json }) === 'old') return TOO_OLD
    return 'That address answered, but it isn’t a Trioditis server.'
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (/redirect/i.test(message))
      return 'That address sends you somewhere else. Enter the address you end up at in a browser.'
    return `Couldn’t reach that address (${message}).`
  }
}

const fromConnectPage = (event: IpcMainEvent | IpcMainInvokeEvent) =>
  !!connectWindow && event.sender === connectWindow.webContents && event.senderFrame === event.sender.mainFrame

const fromServerPage = (event: IpcMainEvent | IpcMainInvokeEvent) =>
  !!serverWindow &&
  !!serverOrigin &&
  event.sender === serverWindow.webContents &&
  event.senderFrame === event.sender.mainFrame &&
  sameOrigin(event.senderFrame.url, serverOrigin)

// The address to start from, and whether a server's window is open behind the picker to go back to.
ipcMain.handle('connect:current', (event) =>
  fromConnectPage(event)
    ? { address: serverOrigin ?? settings.server ?? null, open: !!serverWindow }
    : { address: null, open: false },
)

/**
 * Checks `origin` is a Trioditis server, then leaves the server open now for it, at `url` (its
 * home page by default). Gives up, changing nothing, if another check starts meanwhile.
 */
async function switchServer(origin: string, url?: string): Promise<{ error?: string }> {
  const mine = ++attempt
  const problem = await probe(origin)
  // Cancelled, closed or tried again while the server was being checked: this one is moot.
  if (mine !== attempt) return {}
  if (problem) return { error: problem }
  // Already open: nothing to change, beyond the page asked for.
  if (serverWindow && origin === serverOrigin) {
    connectWindow?.close()
    if (url) void serverWindow.loadURL(url).catch(() => undefined)
    reveal(serverWindow)
    return {}
  }
  // The one point of no return: nothing after it can be cancelled.
  committing = true
  const previous = serverOrigin
  try {
    // The server being left goes first, since its page may hold unsent text and keep it.
    if (serverWindow && !(await closeServer(serverWindow)))
      return { error: 'You stayed, so the server wasn’t changed. Send or clear your messages first.' }
    try {
      await saveSettings({ ...settings, server: origin })
    } catch {
      if (previous) openServer(previous)
      return { error: 'That server couldn’t be saved. Try again.' }
    }
    openServer(origin, url)
  } finally {
    committing = false
    // Nothing left open, which only a failure with no server to go back to could do: the
    // picker, rather than an app with no window.
    if (BrowserWindow.getAllWindows().length === 0) showConnect()
  }
  connectWindow?.close()
  return {}
}

ipcMain.handle('connect:connect', async (event, address: unknown) => {
  if (!fromConnectPage(event) || typeof address !== 'string') return { error: 'That request isn’t allowed.' }
  if (committing) return { error: 'Another server is being saved. Try again in a moment.' }
  const parsed = normalizeServer(address)
  if ('error' in parsed) return parsed
  return switchServer(parsed.origin)
})

/**
 * An invitation link the system handed the app. On the server already open it just opens there;
 * one for another server, or with none open yet, asks first, naming the server, since anyone
 * can send a link and the app would otherwise move to their server unasked.
 */
async function openInvitation(link: Invitation) {
  if (!started) {
    waitingLink = link
    return
  }
  if (serverWindow && serverOrigin === link.origin) {
    reveal(serverWindow)
    // A page holding unsent text asks first, as a reload does.
    void serverWindow.loadURL(link.url).catch(() => undefined)
    return
  }
  if (committing) return
  const host = new URL(link.origin).host
  const options = {
    type: 'question' as const,
    buttons: ['Open Invitation', 'Open in Browser', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: `Open an invitation to ${host}?`,
    detail: serverOrigin
      ? `The app is connected to ${new URL(serverOrigin).host}. Opening the invitation connects it to ${host} instead.`
      : `The app connects to ${host} to open it.`,
  }
  const parent = serverWindow ?? connectWindow
  const { response } = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))
  if (response === 1) return openExternal(link.url)
  if (response !== 0 || committing) return
  const { error } = await switchServer(link.origin, link.url)
  if (error) showConnect(error)
}

/** A link from the system: an invitation is opened, anything else just shows the app. */
function openLink(link: string | undefined) {
  const invitation = link ? invitationFrom(link) : null
  if (invitation) void openInvitation(invitation)
  else if (started) reveal(serverWindow ?? connectWindow)
}

ipcMain.on('connect:cancel', (event) => {
  if (!fromConnectPage(event) || !serverWindow || committing) return
  attempt++
  connectWindow?.close()
})

ipcMain.on('desktop:badge', (event, count: unknown) => {
  if (fromServerPage(event) && Number.isInteger(count) && (count as number) >= 0)
    showBadge(Math.min(count as number, 999))
})

ipcMain.on('desktop:focus', (event) => {
  if (fromServerPage(event)) reveal(serverWindow)
})

// The sign-in page's Change link. It only opens the picker, as the File menu does: the person
// still types the address and the picker checks it, so a page can't move the app anywhere.
// Only from a window the person is using: the preload also asks for a click, but this is the
// guard, so a hidden window can't keep taking focus.
ipcMain.on('desktop:change-server', (event) => {
  if (fromServerPage(event) && serverWindow?.isFocused()) showConnect()
})

function reveal(win: BrowserWindow | null) {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function buildMenu() {
  const mac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Change Server…', click: () => showConnect() },
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      // Reload acts on the server's window only: reloading the picker mid-save would offer
      // Connect again.
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => serverWindow?.webContents.reload() },
        {
          label: 'Force Reload',
          accelerator: 'Shift+CmdOrCtrl+R',
          click: () => serverWindow?.webContents.reloadIgnoringCache(),
        },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault())
})

// A Mac hands links to the running app, from before it's ready.
app.on('open-url', (event, url) => {
  event.preventDefault()
  openLink(url)
})

// No HTTP cache anywhere, not only in the servers' sessions (partitionFor): the default session,
// which shows the server picker, would otherwise keep one in the app's data folder too. It has to
// be set before the app is ready.
app.commandLine.appendSwitch('disable-http-cache')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Windows and Linux start the app again with the link; this, the first, takes it.
  app.on('second-instance', (_event, argv) => openLink(linkArgument(argv)))
  app.on('before-quit', () => (quitting = true))
  // Not while changing server: an invitation link can close the only window before the new
  // server's opens, and that isn't the person quitting.
  app.on('window-all-closed', () => {
    if (quitsWhenAllClosed(process.platform, committing)) app.quit()
  })
  app.on('activate', () => {
    if (serverWindow) reveal(serverWindow)
    // Mid-change of server, or picking one: the picker, never the server being left.
    else if (connectWindow) reveal(connectWindow)
    else if (serverOrigin) openServer(serverOrigin)
    else showConnect()
  })
  void app.whenReady().then(async () => {
    // What the default session cached before the switch above is cleared.
    void session.defaultSession.clearCache()
    buildMenu()
    settings = await loadSettings()
    const asked = serverArgument()
    const parsed = normalizeServer(asked ?? settings.server ?? '')
    const launchLink = linkArgument(process.argv)
    const link = waitingLink ?? (launchLink ? invitationFrom(launchLink) : null)
    waitingLink = null
    started = true
    // An invitation to the server the app opens anyway goes straight to it; any other is asked
    // about over the usual window, so cancelling it still leaves the app open.
    if ('origin' in parsed && link?.origin === parsed.origin) return openServer(parsed.origin, link.url)
    if ('origin' in parsed) openServer(parsed.origin)
    else showConnect(asked !== undefined ? parsed.error : undefined)
    if (link) void openInvitation(link)
  })
}
