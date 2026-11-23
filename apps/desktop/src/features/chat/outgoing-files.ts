import { useSyncExternalStore } from 'react'
import { MAX_SEND_BYTES, messageTypeOf } from '~/data/media.ts'

// Files waiting in a chat's composer to be sent, dropped or pasted in. They're kept here, by
// chat, not in the composer, so a send that finishes after the person moved to another chat
// takes them out of the right one. Only in memory: a reload forgets them, as it would a file
// picked in any page, and nothing of them is saved anywhere.

export interface OutgoingFile {
  id: string
  file: File
  /** A picture's own preview, from the file the person chose. */
  preview?: string
  /** Being sent: it can't be removed, and goes once it has. */
  sending: boolean
}

/** Files one message can hold at once in the composer; each goes as a message of its own. */
export const MAX_FILES = 10

const store = new Map<string, OutgoingFile[]>()
const listeners = new Set<() => void>()
const NONE: OutgoingFile[] = []

function set(chatId: string, files: OutgoingFile[]) {
  if (files.length) store.set(chatId, files)
  else store.delete(chatId)
  for (const listener of listeners) listener()
}

export const filesOf = (chatId: string) => store.get(chatId) ?? NONE

/** Adds files to a chat's composer. Returns why some weren't, to say, or null. */
export function addFiles(chatId: string, files: readonly File[]): string | null {
  const now = filesOf(chatId)
  const room = MAX_FILES - now.length
  const fit = files.filter((f) => f.size <= MAX_SEND_BYTES)
  const added = fit.slice(0, Math.max(0, room)).map((file) => ({
    id: crypto.randomUUID(),
    file,
    ...(messageTypeOf(file.type) === 'image' ? { preview: URL.createObjectURL(file) } : {}),
    sending: false,
  }))
  if (added.length) set(chatId, [...now, ...added])
  if (fit.length < files.length)
    return files.length === 1 ? 'That file is over 100 MB.' : 'Files over 100 MB were left out.'
  if (added.length < fit.length) return `Up to ${MAX_FILES} files at a time.`
  return null
}

export function removeFile(chatId: string, id: string) {
  const now = filesOf(chatId)
  const gone = now.find((f) => f.id === id)
  if (!gone) return
  if (gone.preview) URL.revokeObjectURL(gone.preview)
  set(
    chatId,
    now.filter((f) => f !== gone),
  )
}

export function setSending(chatId: string, ids: readonly string[], sending: boolean) {
  set(
    chatId,
    filesOf(chatId).map((f) => (ids.includes(f.id) ? { ...f, sending } : f)),
  )
}

export function useOutgoingFiles(chatId: string): OutgoingFile[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => filesOf(chatId),
  )
}

/**
 * The files a paste carries, to attach, or none when it's text. Copying from a spreadsheet or
 * a document gives a picture of it beside the text, and copying a file gives its name as text:
 * so files are taken unless there's text other than their names.
 */
export function pastedFiles(data: DataTransfer | null): File[] {
  if (!data) return []
  const files = [...data.files]
  if (!files.length) return []
  const text = data.getData('text/plain').trim()
  if (!text) return files
  const names = files.map((f) => f.name)
  return text.split(/\r?\n/).every((line) => names.includes(line.trim())) ? files : []
}

/** Whether a drag carries files, as opposed to text or a link. */
export const draggingFiles = (data: DataTransfer | null) => !!data && [...data.types].includes('Files')
