// The connect page: asks for a server's address and hands it to the main process, which checks
// it's a Trioditis server before saving it and opening it (main.ts).

const bridge = window.trioditisConnect
const form = document.getElementById('form')
const input = document.getElementById('address')
const error = document.getElementById('error')
const submit = document.getElementById('submit')
const cancel = document.getElementById('cancel')

function showError(message) {
  error.textContent = message ?? ''
  error.hidden = !message
}

showError(new URLSearchParams(window.location.search).get('error'))

void bridge.current().then(({ address, open }) => {
  if (address && !input.value) input.value = address
  // Changing servers: the current one is still open behind this window.
  cancel.hidden = !open
})

cancel.addEventListener('click', () => bridge.cancel())

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  showError(null)
  submit.disabled = true
  submit.textContent = 'Connecting…'
  try {
    const result = await bridge.connect(input.value)
    if (result.error) showError(result.error)
  } catch {
    showError('Something went wrong. Try again.')
  } finally {
    submit.disabled = false
    submit.textContent = 'Connect'
  }
})
