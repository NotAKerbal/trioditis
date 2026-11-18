import type * as React from 'react'
import { cn } from '../lib/utils.ts'

const NETWORK_STYLE: Record<string, { className: string; letter: string }> = {
  whatsapp: { className: 'bg-net-whatsapp', letter: 'W' },
  signal: { className: 'bg-net-signal', letter: 'S' },
  gmessages: { className: 'bg-net-gmessages', letter: 'G' },
  telegram: { className: 'bg-net-telegram', letter: 'T' },
  meta: { className: 'bg-net-messenger', letter: 'M' },
  instagram: { className: 'bg-net-instagram', letter: 'I' },
  discord: { className: 'bg-net-discord', letter: 'D' },
  agents: { className: 'bg-net-agents', letter: '✦' },
}

/** A network's small square mark. `label` is its name, for screen readers and the tooltip. */
function NetworkBadge({
  network,
  label,
  size = 16,
  className,
  ...props
}: { network: string; label: string; size?: number } & React.ComponentProps<'span'>) {
  const style = NETWORK_STYLE[network] ?? { className: 'bg-net-fake', letter: label.slice(0, 1).toUpperCase() }
  return (
    <span
      data-slot="network-badge"
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[4px] font-bold text-on-color',
        style.className,
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }}
      {...props}
    >
      {style.letter}
    </span>
  )
}

export { NetworkBadge }
