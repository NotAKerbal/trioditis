/** An invitation link made on this page: the server gives each one only once. */
export type MadeLink = { invitationId: string; email: string; link: string }

export type ListedInvitation = { _id: string; expiresAt: number }

/**
 * The links still worth showing. The list holds only invitations nobody has joined with yet; a
 * link whose invitation is in it shows until it expires. One not in it was joined or revoked, once
 * every page has loaded (`complete`); until then it may be on a page not loaded yet, so it stays.
 * Before the list loads (`listed` undefined), every link shows.
 */
export function linksToShow(
  links: readonly MadeLink[],
  listed: readonly ListedInvitation[] | undefined,
  complete: boolean,
  now = Date.now(),
): MadeLink[] {
  if (!listed) return [...links]
  return links.filter((made) => {
    const invitation = listed.find((i) => i._id === made.invitationId)
    return invitation ? invitation.expiresAt >= now : !complete
  })
}
