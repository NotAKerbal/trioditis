import type { Attachment, Network } from '@trioditis/core'
import { AvatarCollage, AvatarTile } from '@trioditis/ui/avatar'
import type { ReactNode } from 'react'
import type { Chat } from '~/data/chats.ts'
import { useContacts } from '~/data/contacts.ts'
import { isImage, useMedia } from '~/data/media.ts'
import { MediaAvatar } from './attachments.tsx'

/**
 * A chat's picture: its own, or for a group with none, a collage of the members its metadata
 * names (Chat.collage), each with their contact's picture or initials. One member it knows shows
 * alone; with none, the group's initials stand in, as before.
 */
export function ChatAvatar({
  chat,
  name = chat.name,
  size,
  badge,
  className,
}: {
  chat: Chat
  name?: string
  size: number
  badge?: ReactNode
  className?: string
}) {
  const wanted = chat.avatar ? [] : chat.collage
  const contacts = useContacts(chat.network, wanted)
  const members = wanted.flatMap((ghostId) => {
    const profile = contacts.get(ghostId)
    return profile ? [{ ghostId, name: profile.name || profile.handle || '', avatar: profile.avatar }] : []
  })
  if (members.length > 0) {
    return (
      <AvatarCollage size={size} badge={badge} className={className}>
        {members.map((m) => (
          <MemberTile
            key={m.ghostId}
            network={chat.network}
            name={m.name}
            picture={m.avatar}
            size={size}
            alone={members.length === 1}
          />
        ))}
      </AvatarCollage>
    )
  }
  return (
    <MediaAvatar
      network={chat.network}
      picture={chat.avatar}
      name={name}
      size={size}
      shape={chat.row.kind === 'dm' ? 'circle' : 'square'}
      badge={badge}
      className={className}
    />
  )
}

function MemberTile({
  network,
  name,
  picture,
  size,
  alone,
}: {
  network: Network
  name: string
  picture: Attachment | undefined
  size: number
  alone: boolean
}) {
  const media = useMedia(network, picture, !!picture && isImage(picture))
  return <AvatarTile name={name} src={media.url} size={size} alone={alone} />
}
