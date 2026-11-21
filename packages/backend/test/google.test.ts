import { describe, expect, it } from 'vitest'
import { api } from '../convex/_generated/api'
import { setup, signIn } from './setup'

const CLIENT_ID = '123456789012-abcdefghij0123456789abcdefghij01.apps.googleusercontent.com'

describe('Google Contacts', () => {
  it('lets an admin set the client ID, which every member reads', async () => {
    const t = setup()
    const admin = await signIn(t, 'admin', 'admin')
    const member = await signIn(t, 'sam')
    expect(await member.query(api.google.contacts, {})).toEqual({ clientId: null })

    await expect(member.mutation(api.google.setContacts, { clientId: CLIENT_ID })).rejects.toThrow(/admin/)
    await expect(admin.mutation(api.google.setContacts, { clientId: 'GOCSPX-a-secret' })).rejects.toThrow(/client ID/)

    await admin.mutation(api.google.setContacts, { clientId: ` ${CLIENT_ID} ` })
    expect(await member.query(api.google.contacts, {})).toEqual({ clientId: CLIENT_ID })
    await admin.mutation(api.google.setContacts, { clientId: null })
    expect(await member.query(api.google.contacts, {})).toEqual({ clientId: null })
    // Removing it again is nothing to do.
    await admin.mutation(api.google.setContacts, { clientId: null })

    const actions = await t.run(async (ctx) => (await ctx.db.query('auditLog').collect()).map((r) => r.action))
    expect(actions.filter((a) => a.startsWith('google.'))).toEqual(['google.contacts.set', 'google.contacts.clear'])
  })

  it('is only for members', async () => {
    const t = setup()
    await expect(t.query(api.google.contacts, {})).rejects.toThrow()
  })
})
