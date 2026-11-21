// Where Google's sign-in for Google Contacts comes back to (src/lib/google-sign-in.ts). The
// token is in the fragment, which never reaches a server; it's taken off the address at once,
// and passed only to the app that asked, by the state it asked with: a state starting `w` is a
// browser tab's popup, answered over a BroadcastChannel; `d` is the desktop app, answered with
// a trioditis:// link the app checks.
;(() => {
  const answer = new URLSearchParams(location.hash.slice(1))
  history.replaceState(null, '', location.pathname)
  const state = answer.get('state') || ''
  const token = answer.get('access_token')
  const reply = new URLSearchParams({ state })
  if (token) reply.set('access_token', token)
  else reply.set('error', /^[a-z_]{1,64}$/.test(answer.get('error') || '') ? answer.get('error') : 'failed')
  const status = document.getElementById('status')
  if (/^d[A-Za-z0-9_-]{16,128}$/.test(state)) {
    status.textContent = 'You can go back to Trioditis.'
    location.replace(`trioditis://${location.host}/google-contacts#${reply}`)
  } else if (/^w[A-Za-z0-9_-]{16,128}$/.test(state)) {
    const channel = new BroadcastChannel('trioditis-google-contacts')
    channel.postMessage(Object.fromEntries(reply.entries()))
    channel.close()
    status.textContent = 'You can close this window.'
    // A moment for the message to go before the window does.
    setTimeout(() => window.close(), 100)
  } else {
    status.textContent = 'This sign-in wasn’t asked for here.'
  }
})()
