import type * as React from 'react'

/** The frame for signed-out screens: one task per card, centred. */
export function AuthCard({ title, description, children, footer }: { title: string; description?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <main className="flex min-h-full items-center justify-center bg-rail px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 flex items-center gap-2.5">
          <img src="/icon.svg" alt="" className="size-8" />
          <span className="text-md font-bold tracking-[-0.01em]">Trioditis</span>
        </div>
        <section className="rounded-xl bg-surface p-6 shadow-raised ring-1 ring-border">
          <h1 className="text-xl font-bold tracking-[-0.015em]">{title}</h1>
          {description ? <p className="mt-1.5 text-base text-muted-foreground">{description}</p> : null}
          <div className="mt-5">{children}</div>
        </section>
        {footer ? <div className="mt-4 text-center text-sm text-muted-foreground">{footer}</div> : null}
      </div>
    </main>
  )
}

/** A labelled field. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="mb-4 block">
      <span className="mb-1.5 block text-sm font-semibold">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-sm text-muted-foreground">{hint}</span> : null}
    </label>
  )
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p role="alert" className="mb-4 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
      {message}
    </p>
  )
}

/** Turns whatever an auth call or a Convex function threw into a sentence for the person. */
export function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const e = error as { data?: unknown; message?: unknown }
    if (typeof e.data === 'string') return e.data
    if (typeof e.message === 'string' && e.message) return e.message
  }
  return fallback
}
