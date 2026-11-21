import {
  decodeRecoveryKey,
  fromBase64Url,
  newPasswordParams,
  openSealedBox,
  passwordKey,
  ready,
  toBase64Url,
  unwrapIdentityKey,
  wrapIdentityKey,
  type PasswordParams,
} from '@trioditis/crypto'

/** What `account.resetInfo` answers for a reset link. */
export interface ResetInfo {
  userId: string
  email: string
  key: null | {
    kid: string
    publicKey: string
    recovery: null | { nonce: string; ct: string }
    passwordParams: null | PasswordParams
  }
}

/** The server calls a reset makes, signed out (account.ts). */
export interface ResetServer {
  info(token: string): Promise<ResetInfo | null>
  challenge(token: string): Promise<{ sealed: string }>
  reset(args: {
    token: string
    newAuthPassword: string
    newWrap?: { nonce: string; ct: string; params: PasswordParams }
    proof?: string
  }): Promise<null>
}

/** A reset that can't go ahead, saying why to the person. */
export class ResetRefused extends Error {}

/**
 * Resets a forgotten password with a reset link's `token`: opens the identity key with the
 * recovery key, wraps it again with the new password (never with weaker settings than the backup
 * it replaces), proves the key to the server, and sets the new sign-in password, all in one
 * server transaction (account.resetPassword). `derive` is `authPassword`, given so the busy state
 * can paint first. Answers the account's email, to sign in with.
 */
export async function resetPassword(
  server: ResetServer,
  token: string,
  { recoveryKey, newPassword }: { recoveryKey: string; newPassword: string },
  derive: (password: string, email: string) => Promise<string>,
): Promise<string> {
  await ready()
  const info = await server.info(token)
  if (!info) throw new ResetRefused('This reset link has expired or was already used. Ask your admin for a new one.')
  const newAuthPassword = await derive(newPassword, info.email)
  if (!info.key) {
    await server.reset({ token, newAuthPassword })
    return info.email
  }
  if (!info.key.recovery) {
    throw new ResetRefused('Your key has no recovery key backup, so its password can’t be reset this way.')
  }
  let bytes: Uint8Array
  try {
    bytes = decodeRecoveryKey(recoveryKey)
  } catch (e) {
    throw new ResetRefused(`${e instanceof Error && e.message ? e.message : 'That isn’t a recovery key'}. Check it.`)
  }
  const context = { userId: info.userId, kid: info.key.kid }
  let keyPair
  try {
    keyPair = unwrapIdentityKey(
      info.key.recovery,
      bytes,
      { ...context, kind: 'recovery' },
      fromBase64Url(info.key.publicKey),
    )
  } catch {
    throw new ResetRefused('That recovery key doesn’t match your account. Check it and try again.')
  }
  const fresh = newPasswordParams()
  const old = info.key.passwordParams
  const params = {
    ...fresh,
    opslimit: Math.max(fresh.opslimit, old?.opslimit ?? 0),
    memlimit: Math.max(fresh.memlimit, old?.memlimit ?? 0),
  }
  const wrappingKey = passwordKey(newPassword, params)
  const wrap = wrapIdentityKey(keyPair.privateKey, wrappingKey, { ...context, kind: 'password' })
  // Opened again before it's sent: the server can't check a wrap.
  unwrapIdentityKey(wrap, wrappingKey, { ...context, kind: 'password' }, keyPair.publicKey)
  const { sealed } = await server.challenge(token)
  const proof = toBase64Url(openSealedBox(fromBase64Url(sealed), keyPair))
  await server.reset({ token, newAuthPassword, newWrap: { ...wrap, params }, proof })
  return info.email
}
