import { describe, expect, it } from 'vitest'
import { forgetFragmentToken, takeFragmentToken, type FragmentEnv } from '../src/lib/fragment.ts'

/** A tab at `url`, with its own sessionStorage, that replaceState really changes. */
function tab(url: string, storage: Map<string, string> = new Map()) {
  const location = new URL(url)
  const env: FragmentEnv = {
    location,
    history: {
      state: null,
      replaceState: (_state: unknown, _unused: string, next?: string | URL | null) => {
        const replaced = new URL(String(next), location)
        location.hash = replaced.hash
        location.search = replaced.search
      },
    },
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, value),
      removeItem: (key) => void storage.delete(key),
    },
  }
  return { env, location, storage }
}

describe('a token in the link’s fragment', () => {
  it('is taken out of the address bar, and still there when the page reloads', () => {
    const first = tab('https://t.test/invite?email=sam%40x.test#token=abc')
    expect(takeFragmentToken('invite:sam@x.test', first.env)).toBe('abc')
    expect(first.location.hash).toBe('')
    expect(first.location.search).toBe('?email=sam%40x.test')
    // The reload: the address no longer has it, the tab's storage does.
    const reloaded = tab(first.location.href, first.storage)
    expect(takeFragmentToken('invite:sam@x.test', reloaded.env)).toBe('abc')
  })

  it('is gone once used, and never handed to another invitation’s page', () => {
    const first = tab('https://t.test/invite?email=sam%40x.test#token=abc')
    takeFragmentToken('invite:sam@x.test', first.env)
    expect(takeFragmentToken('invite:other@x.test', tab('https://t.test/invite', first.storage).env)).toBe('')
    forgetFragmentToken('invite:sam@x.test', first.env)
    expect(takeFragmentToken('invite:sam@x.test', tab('https://t.test/invite', first.storage).env)).toBe('')
  })

  it('takes a newer link’s token over the one remembered', () => {
    const storage = new Map<string, string>()
    takeFragmentToken('setup', tab('https://t.test/setup#token=old', storage).env)
    expect(takeFragmentToken('setup', tab('https://t.test/setup#token=new', storage).env)).toBe('new')
    expect(takeFragmentToken('setup', tab('https://t.test/setup', storage).env)).toBe('new')
  })

  it('still works for the page when the browser refuses storage', () => {
    const { env } = tab('https://t.test/invite#token=abc')
    const refusing: FragmentEnv = {
      ...env,
      storage: {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('denied')
        },
        removeItem: () => {
          throw new Error('denied')
        },
      },
    }
    expect(takeFragmentToken('invite:a', refusing)).toBe('abc')
    expect(takeFragmentToken('invite:a', refusing)).toBe('')
    expect(() => forgetFragmentToken('invite:a', refusing)).not.toThrow()
  })

  it('is kept nowhere without a name to remember it by', () => {
    const { env, storage } = tab('https://t.test/x#token=abc')
    expect(takeFragmentToken(undefined, env)).toBe('abc')
    expect(storage.size).toBe(0)
  })
})
