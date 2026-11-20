// The install commands' Copy button. It stays hidden where the clipboard isn't available, so
// it never offers something that can't work.
if (navigator.clipboard) {
  for (const button of document.querySelectorAll('[data-copy]')) {
    const source = document.getElementById(button.dataset.copy)
    if (!source) continue
    button.hidden = false
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(source.textContent ?? '')
        button.textContent = 'Copied'
      } catch {
        button.textContent = 'Copy failed'
      }
      setTimeout(() => (button.textContent = 'Copy'), 1600)
    })
  }
}
