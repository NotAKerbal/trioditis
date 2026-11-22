/**
 * The things fetched ahead, most recently wanted first, at most `max` of them: wanting one again
 * moves it to the front, and the one beyond `max` is let go. Listeners hear of every change.
 */
export function warmList<T extends { id: string }>(max: number) {
  let items: readonly T[] = []
  const listeners = new Set<() => void>()
  return {
    add: (item: T) => {
      if (items[0]?.id === item.id) return
      items = [item, ...items.filter((i) => i.id !== item.id)].slice(0, max)
      listeners.forEach((l) => l())
    },
    get: () => items,
    subscribe: (onChange: () => void) => {
      listeners.add(onChange)
      return () => void listeners.delete(onChange)
    },
  }
}
