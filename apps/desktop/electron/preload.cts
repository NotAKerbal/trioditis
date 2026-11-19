import { contextBridge, ipcRenderer } from 'electron'

// The only things a page can ask of the desktop app. The server's page gets the badge and
// focus (src/lib/desktop.ts); the app's own connect page gets the server picker. The main
// process checks which page sent each request again, so this split is a convenience, not the
// guard.

if (window.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('trioditisConnect', {
    current: (): Promise<{ address: string | null; open: boolean }> => ipcRenderer.invoke('connect:current'),
    connect: (address: string): Promise<{ error?: string }> => ipcRenderer.invoke('connect:connect', address),
    cancel: (): void => ipcRenderer.send('connect:cancel'),
  })
} else {
  contextBridge.exposeInMainWorld('trioditisDesktop', {
    setBadge: (count: number): void => ipcRenderer.send('desktop:badge', count),
    focus: (): void => ipcRenderer.send('desktop:focus'),
    platform: process.platform,
  })
}
