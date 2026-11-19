// One account at a time in this browser profile: its tabs share one cookie, so when any tab signs
// in or out, every other tab of the app reloads, to start again as whoever is signed in now.
// Nothing here then has to cope with one tab's session being swapped for another mid-way: a
// screen, a save or a sign-out always belongs to the session its page opened with
// (features/auth/app-gate.tsx reloads too if it sees the session change some other way).

const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('trioditis-account')
channel?.addEventListener('message', () => window.location.reload())

/** Tells every other tab of the app that who's signed in here has changed. */
export function announceAccountChange() {
  channel?.postMessage('changed')
}
