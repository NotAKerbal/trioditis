import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
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
import { isExternalAllowed, normalizeServer, pageIsReady, sameOrigin, serverKind, TOO_OLD } from './server.ts'

// The desktop app: a window onto one Trioditis server's web app, with native notifications,
// a dock badge and a menu. Nothing from the server runs with Node: its pages are sandboxed and
// reach the app only through the preload's calls, each checked here.

app.setName('Trioditis')
app.setPath('userData', path.join(app.getPath('appData'), 'Trioditis'))
// Windows shows notifications only for an app with an ID.
if (process.platform === 'win32') app.setAppUserModelId('org.trioditis.desktop')

const here = import.meta.dirname
const preload = path.join(here, 'preload.cjs')
const connectPage = path.join(here, '../electron/connect.html')
// The window and taskbar icon on Linux and Windows; macOS takes the dock icon from the app bundle.
const icon = path.join(here, '../electron/icon.png')
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
    const ses = session.fromPartition(partition)
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

function openServer(origin: string) {
  const previous = serverWindow
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: 'Trioditis',
    icon,
    backgroundColor: background(),
    webPreferences: { ...webPreferences, partition: partitionFor(origin), spellcheck: true },
  })
  serverWindow = win
  serverOrigin = origin
  keepOnOrigin(win.webContents, origin)
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
    showConnect(`Couldn’t open ${origin} (${description}).`)
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
  void win.loadURL(`${origin}/`)
  app.setBadgeCount(0)
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
    icon,
    backgroundColor: background(),
    webPreferences,
  })
  connectWindow = win
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

ipcMain.handle('connect:connect', async (event, address: unknown) => {
  if (!fromConnectPage(event) || typeof address !== 'string') return { error: 'That request isn’t allowed.' }
  if (committing) return { error: 'Another server is being saved. Try again in a moment.' }
  const parsed = normalizeServer(address)
  if ('error' in parsed) return parsed
  const mine = ++attempt
  const problem = await probe(parsed.origin)
  // Cancelled, closed or tried again while the server was being checked: this one is moot.
  if (mine !== attempt) return {}
  if (problem) return { error: problem }
  // Already open: nothing to change.
  if (serverWindow && parsed.origin === serverOrigin) {
    connectWindow?.close()
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
      await saveSettings({ ...settings, server: parsed.origin })
    } catch {
      if (previous) openServer(previous)
      return { error: 'That server couldn’t be saved. Try again.' }
    }
  } finally {
    committing = false
  }
  openServer(parsed.origin)
  connectWindow?.close()
  return {}
})

ipcMain.on('connect:cancel', (event) => {
  if (!fromConnectPage(event) || !serverWindow || committing) return
  attempt++
  connectWindow?.close()
})

ipcMain.on('desktop:badge', (event, count: unknown) => {
  if (fromServerPage(event) && Number.isInteger(count) && (count as number) >= 0)
    app.setBadgeCount(Math.min(count as number, 999))
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

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => reveal(serverWindow ?? connectWindow))
  app.on('before-quit', () => (quitting = true))
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (serverWindow) reveal(serverWindow)
    // Mid-change of server, or picking one: the picker, never the server being left.
    else if (connectWindow) reveal(connectWindow)
    else if (serverOrigin) openServer(serverOrigin)
    else showConnect()
  })
  void app.whenReady().then(async () => {
    buildMenu()
    settings = await loadSettings()
    const asked = serverArgument()
    const parsed = normalizeServer(asked ?? settings.server ?? '')
    if ('origin' in parsed) openServer(parsed.origin)
    else showConnect(asked !== undefined ? parsed.error : undefined)
  })
}
