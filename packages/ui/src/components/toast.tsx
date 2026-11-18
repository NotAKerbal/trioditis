import { useEffect, useState, useSyncExternalStore } from 'react'

// A small, app-wide toast: one message at a time, at the bottom centre, gone after a few seconds.
type Toast = { id: number; message: string; action?: { label: string; onClick: () => void } }

let current: Toast | null = null
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function toast(message: string, action?: Toast['action']) {
  current = { id: nextId++, message, ...(action ? { action } : {}) }
  emit()
}

function Toaster() {
  const value = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
  const [shown, setShown] = useState<Toast | null>(null)
  useEffect(() => {
    setShown(value)
    if (!value) return
    const timer = setTimeout(() => setShown(null), 3600)
    return () => clearTimeout(timer)
  }, [value])
  if (!shown) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 left-1/2 z-[60] flex h-10 -translate-x-1/2 items-center gap-3 rounded-[11px] bg-foreground px-4 text-sm font-medium whitespace-nowrap text-background shadow-popover"
    >
      {shown.message}
      {shown.action ? (
        <button
          type="button"
          className="font-semibold text-primary-soft underline-offset-2 hover:underline"
          onClick={shown.action.onClick}
        >
          {shown.action.label}
        </button>
      ) : null}
    </div>
  )
}

export { toast, Toaster }
