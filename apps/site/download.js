// The download page's button for the visitor's own system. It's built from that system's links
// in the list below it, so the file names live in one place, and it stays hidden where the system
// can't be told or has no desktop app, leaving the full list.

function detectOs() {
  const platform = navigator.userAgentData?.platform
  const agent = navigator.userAgent
  if (platform) {
    if (platform === 'macOS') return 'mac'
    if (platform === 'Windows') return 'windows'
    if (platform === 'Linux') return 'linux'
    return null
  }
  // Phones, tablets and Chromebooks name a desktop system in their user agent too.
  if (/Android|iPhone|iPad|iPod|CrOS/.test(agent)) return null
  if (/Macintosh/.test(agent)) {
    // iPadOS Safari reports itself as a Mac; only the iPad has a touch screen.
    return navigator.maxTouchPoints > 1 ? null : 'mac'
  }
  if (/Windows/.test(agent)) return 'windows'
  if (/Linux/.test(agent)) return 'linux'
  return null
}

// Only Chromium browsers say which processor a Mac has. Elsewhere this is null and the page
// offers Apple silicon first, with Intel beside it.
async function detectArch() {
  try {
    const values = await navigator.userAgentData?.getHighEntropyValues(['architecture'])
    return values?.architecture || null
  } catch {
    return null
  }
}

async function showPick() {
  const os = detectOs()
  const platform = os && document.querySelector(`.platform[data-os="${os}"]`)
  if (!platform) return

  let files = [...platform.querySelectorAll('.file')]
  if (os === 'mac') {
    const arch = await detectArch()
    const match = files.find((file) => file.dataset.arch === arch)
    if (match) files = [match, ...files.filter((file) => file !== match)]
  }
  const [first, ...others] = files

  const main = document.getElementById('pick-main')
  const variant = files.length > 1 ? ` (${first.dataset.pick})` : ''
  main.textContent = `Download for ${platform.dataset.name}${variant}`
  main.href = first.href

  for (const file of others) {
    const other = document.createElement('a')
    other.className = 'button'
    other.href = file.href
    other.textContent = file.dataset.pick
    main.parentElement.append(other)
  }
  main.parentElement.hidden = false
}

showPick()
