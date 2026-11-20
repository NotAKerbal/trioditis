import type { Attachment, Network } from '@trioditis/core'
import { Avatar } from '@trioditis/ui/avatar'
import { Button } from '@trioditis/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@trioditis/ui/dialog'
import { cn } from '@trioditis/ui/lib/utils'
import { Download, FileIcon, Play } from 'lucide-react'
import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { isAudio, isImage, isVideo, useMedia } from '~/data/media.ts'

// A message's pictures and files, and avatars with their pictures, decrypted here (data/media.ts).

/** An Avatar showing its picture once it's decrypted, and initials until then or without one. */
export function MediaAvatar({
  network,
  picture,
  ...props
}: Omit<ComponentProps<typeof Avatar>, 'src'> & { network: Network; picture: Attachment | undefined }) {
  const media = useMedia(network, picture, !!picture && isImage(picture))
  return <Avatar {...props} src={media.url} />
}

const sizeFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${sizeFormat.format(bytes / 1024)} KB`
  return `${sizeFormat.format(bytes / (1024 * 1024))} MB`
}

/** The largest a picture is shown in a message, in CSS pixels. */
const MAX_W = 320
const MAX_H = 320

/** A picture's box before it loads: its own shape when the network said it, scaled to fit. */
function boxOf(a: Attachment) {
  const w = a.width && a.width > 0 ? a.width : 0
  const h = a.height && a.height > 0 ? a.height : 0
  if (!w || !h) return { width: 240, height: 180 }
  const scale = Math.min(1, MAX_W / w, MAX_H / h)
  // A very narrow or flat picture still gets a box that can be seen and clicked.
  return { width: Math.max(64, Math.round(w * scale)), height: Math.max(64, Math.round(h * scale)) }
}

export function Attachments({
  network,
  attachments,
  className,
}: {
  network: Network
  attachments: Attachment[]
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {attachments.map((a) =>
        isImage(a) ? (
          <Picture key={a.mediaId} network={network} attachment={a} />
        ) : (
          <FileTile key={a.mediaId} network={network} attachment={a} />
        ),
      )}
    </div>
  )
}

function Picture({ network, attachment }: { network: Network; attachment: Attachment }) {
  const media = useMedia(network, attachment)
  const [open, setOpen] = useState(false)
  const box = boxOf(attachment)
  const name = attachment.name || 'Photo'
  if (media.state === 'idle' || media.state === 'failed') {
    // Too large to fetch without asking, or it didn't come.
    return (
      <Button
        variant="bare"
        type="button"
        onClick={media.load}
        style={box}
        className="flex flex-col items-center justify-center gap-0.5 rounded-[14px] bg-muted px-3 text-sm text-muted-foreground hover:text-foreground"
      >
        {media.state === 'failed' ? (
          <>
            <span>The photo couldn’t be opened.</span>
            <span className="font-medium">Try again</span>
          </>
        ) : (
          `Show photo · ${fileSize(attachment.size)}`
        )}
      </Button>
    )
  }
  if (media.state !== 'ready') {
    return (
      <span
        role="img"
        aria-label={`${name}, loading`}
        aria-busy="true"
        style={box}
        className="block animate-pulse rounded-[14px] bg-muted motion-reduce:animate-none"
      />
    )
  }
  return (
    <>
      <Button
        variant="bare"
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open ${name}`}
        className="block overflow-hidden rounded-[14px] p-0"
      >
        <img
          src={media.url}
          alt={name}
          style={attachment.width && attachment.height ? box : { maxWidth: MAX_W, maxHeight: MAX_H }}
          className="block object-cover"
        />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="flex max-w-[calc(100vw-48px)] flex-col items-center gap-3 bg-surface p-4 pt-14"
          closeLabel="Close photo"
        >
          <DialogTitle className="absolute top-5 left-5 max-w-[calc(100%-6rem)] truncate text-md">{name}</DialogTitle>
          <img
            src={media.url}
            alt={name}
            className="max-h-[calc(100vh-160px)] max-w-[calc(100vw-80px)] rounded-[10px] object-contain"
          />
          <SaveLink url={media.url} name={name} />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Saves a decrypted file under its own name. */
function SaveLink({ url, name }: { url: string; name: string }) {
  return (
    <a
      href={url}
      download={name}
      className="inline-flex items-center gap-1.5 text-sm text-primary-ink underline-offset-2 hover:underline"
    >
      <Download className="size-3.5" /> Save
    </a>
  )
}

/**
 * Any other file: its name and size, and what can be done with it once it's fetched. Video and
 * sound play in place; anything else is saved.
 */
function FileTile({ network, attachment }: { network: Network; attachment: Attachment }) {
  const media = useMedia(network, attachment, false)
  const playable = isVideo(attachment) || isAudio(attachment)
  const name = attachment.name || (isVideo(attachment) ? 'Video' : isAudio(attachment) ? 'Audio' : 'File')
  const saving = useRef(false)
  const save = useRef<HTMLAnchorElement>(null)

  // A file asked to be saved is saved once it's here.
  useEffect(() => {
    if (media.state === 'ready' && saving.current && !playable) {
      saving.current = false
      save.current?.click()
    }
  }, [media.state, playable])

  if (media.state === 'ready' && isVideo(attachment)) {
    return <video src={media.url} controls autoPlay className="max-h-[360px] max-w-[min(100%,480px)] rounded-[14px]" />
  }
  if (media.state === 'ready' && isAudio(attachment)) {
    return <audio src={media.url} controls autoPlay className="max-w-full" />
  }
  const broken = media.state === 'failed'
  return (
    <span className="flex max-w-[320px] items-center gap-3 rounded-[14px] bg-surface px-3 py-2.5 text-foreground shadow-[0_0_0_1px_var(--border)]">
      <FileIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block text-xs text-subtle-foreground">
          {broken ? 'Couldn’t be opened' : media.state === 'loading' ? 'Opening…' : fileSize(attachment.size)}
        </span>
      </span>
      {media.state === 'ready' ? (
        <a
          ref={save}
          href={media.url}
          download={name}
          aria-label={`Save ${name}`}
          className="text-muted-foreground hover:text-foreground"
        >
          <Download className="size-4" />
        </a>
      ) : (
        <Button
          variant="bare"
          type="button"
          aria-label={playable ? `Play ${name}` : `Save ${name}`}
          title={broken ? 'Try again' : undefined}
          disabled={media.state === 'loading'}
          onClick={() => {
            saving.current = true
            media.load()
          }}
          className="flex size-7 items-center justify-center rounded-full text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {playable ? <Play className="size-4" /> : <Download className="size-4" />}
        </Button>
      )}
    </span>
  )
}
