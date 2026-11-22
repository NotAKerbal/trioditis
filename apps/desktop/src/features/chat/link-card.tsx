import type { Attachment, Network } from '@trioditis/core'
import { cn } from '@trioditis/ui/lib/utils'
import {
  ClipboardList,
  CodeXml,
  FileText,
  Globe,
  HardDrive,
  MapPin,
  Presentation,
  Sheet,
  SquarePlay,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'
import { isImage, loadsByItself, useMedia } from '~/data/media.ts'
import { useNear } from './attachments.tsx'
import type { LinkCard as Card, ServiceIcon, ServiceTone } from './link-preview.ts'

// A link's card under a message's text (link-preview.ts says which). The whole card opens the
// link, in a new tab or the system's browser in the desktop app, as the link in the text does.

const ICONS: Record<ServiceIcon, LucideIcon> = {
  slides: Presentation,
  doc: FileText,
  sheet: Sheet,
  form: ClipboardList,
  drive: HardDrive,
  video: SquarePlay,
  code: CodeXml,
  map: MapPin,
  web: Globe,
}

const TONES: Record<ServiceTone, string> = {
  amber: 'bg-label-amber',
  blue: 'bg-label-blue',
  green: 'bg-label-green',
  violet: 'bg-label-violet',
  pink: 'bg-label-pink',
  slate: 'bg-label-slate',
}

export function LinkCards({ cards, network, self }: { cards: Card[]; network: Network; self: boolean }) {
  return (
    <span className="my-1 flex flex-col gap-1.5 whitespace-normal">
      {cards.map((card, i) => (
        <a
          key={`${i}-${card.href}`}
          href={card.href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            'block w-[20rem] max-w-full overflow-hidden rounded-[12px] text-foreground no-underline transition-shadow',
            // On the person's own coloured bubble the card is the page's surface; on someone
            // else's, a shade off it.
            self
              ? 'bg-surface hover:shadow-[0_0_0_1px_var(--border-strong)]'
              : 'bg-surface-2 shadow-[0_0_0_1px_var(--border)] hover:shadow-[0_0_0_1px_var(--border-strong)]',
          )}
        >
          {card.kind === 'preview' ? <PreviewCard card={card} network={network} /> : <AddressCard card={card} />}
        </a>
      ))}
    </span>
  )
}

function PreviewCard({ card, network }: { card: Extract<Card, { kind: 'preview' }>; network: Network }) {
  const image = card.image && isImage(card.image) ? card.image : undefined
  // A wide picture runs across the top, as the page's own card does elsewhere; a small or
  // square one (a logo, an avatar) sits beside the words.
  const wide = !!image && !!image.width && !!image.height && image.width / image.height >= 1.3 && image.width >= 300
  const words = (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2">
      {/* Where the card goes, whole and on its own line: nothing the network sent (a long site
        name, a title) can push it out of view, so a card never hides where it opens. */}
      <span className="text-xs font-medium break-all text-subtle-foreground">{card.host}</span>
      {card.title ? <span className="line-clamp-2 text-sm leading-snug font-semibold">{card.title}</span> : null}
      {card.description ? (
        <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">{card.description}</span>
      ) : null}
    </span>
  )
  if (!image) return words
  return wide ? (
    <span className="flex flex-col">
      <PreviewImage network={network} image={image} className="aspect-[1.91] w-full" />
      {words}
    </span>
  ) : (
    <span className="flex items-stretch">
      <PreviewImage network={network} image={image} className="w-[72px] shrink-0 self-stretch" />
      {words}
    </span>
  )
}

/**
 * A preview's picture, decrypted as a message's pictures are (data/media.ts), and only near the
 * view. Until then, or if it can't be opened, its place is a plain block: the words say enough.
 */
function PreviewImage({ network, image, className }: { network: Network; image: Attachment; className: string }) {
  const [ref, near] = useNear()
  // A picture too large to load by itself (as for a message's own pictures) isn't loaded at all:
  // the preview's words are enough.
  const media = useMedia(network, image, loadsByItself(image), near)
  const [broken, setBroken] = useState<string | null>(null)
  const ready = media.state === 'ready' && broken !== media.url
  return (
    <span ref={ref} aria-hidden className={cn('relative block min-h-[72px] bg-muted', className)}>
      {ready ? (
        <img
          src={media.url}
          alt=""
          onError={() => setBroken(media.url ?? null)}
          className="absolute inset-0 size-full object-cover"
        />
      ) : null}
    </span>
  )
}

function AddressCard({ card }: { card: Extract<Card, { kind: 'address' }> }) {
  const Icon = ICONS[card.service.icon]
  const known = card.service.icon !== 'web'
  // A known service is named by it; anywhere else, by the site, with the page's path under it.
  const detail = known ? [card.detail, card.host].filter(Boolean).join(' · ') : card.detail
  return (
    <span className="flex items-center gap-3 px-3 py-2.5">
      <span
        aria-hidden
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-[10px] text-on-color',
          TONES[card.service.tone],
        )}
      >
        <Icon className="size-5" />
      </span>
      <span className="flex min-w-0 flex-col">
        {/* A site named by its host shows it whole, wrapping, never cut short. */}
        <span className={cn('text-sm font-semibold', known ? 'truncate' : 'break-all')}>{card.service.name}</span>
        {detail ? <span className="truncate text-xs text-muted-foreground">{detail}</span> : null}
      </span>
    </span>
  )
}
