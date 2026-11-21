// The download page's buttons for the visitor's own system. They're built from that system's
// links in the list below them, so the file names live in one place. Where the browser doesn't
// say enough to know an installer will run, they stay hidden and the full list is the choice.

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

// Only Chromium browsers give these; elsewhere they're all missing and the user agent decides.
async function detectHints() {
  try {
    return (await navigator.userAgentData?.getHighEntropyValues(['architecture', 'bitness', 'platformVersion'])) ?? {}
  } catch {
    return {}
  }
}

// The files for this system that will run on this computer, or null if that can't be known.
// More than one means the browser can't tell which, and the visitor chooses.
function fittingFiles(os, files, hints, agent, touchPoints) {
  if (os === 'mac') {
    // Chromium says which processor a Mac has; Safari and Firefox don't.
    const match = files.filter((file) => file.dataset.arch === hints.architecture)
    return match.length ? match : files
  }
  if (os === 'windows') {
    // The installer is x64. 32-bit Windows can't run it, nor can Windows 10 on Arm; Windows 11
    // (platform version 13 or later) runs it on Arm by emulation.
    const is64 = hints.bitness ? hints.bitness === '64' : /Win64|WOW64/.test(agent)
    if (!is64) return null
    if (hints.architecture === 'arm' && !(parseInt(hints.platformVersion, 10) >= 13)) return null
    return files
  }
  if (os === 'linux') {
    // Chrome on an Android tablet in desktop mode reports Linux on x86_64, so a touch screen
    // rules it out. Chromium's user agent always says x86_64, whatever the processor.
    if (touchPoints > 0) return null
    const isX64 = hints.architecture
      ? hints.architecture === 'x86' && hints.bitness === '64'
      : /x86_64|amd64/.test(agent)
    return isX64 ? files : null
  }
  return null
}

async function showPick() {
  const os = detectOs()
  const platform = os && document.querySelector(`.platform[data-os="${os}"]`)
  if (!platform) return

  const all = [...platform.querySelectorAll('.file')]
  const files = fittingFiles(os, all, await detectHints(), navigator.userAgent, navigator.maxTouchPoints)
  if (!files) return

  const pick = document.getElementById('pick')
  for (const file of files) {
    const button = document.createElement('a')
    button.className = 'button primary'
    button.href = file.href
    button.textContent = file.dataset.button
    pick.append(button)
  }
  pick.hidden = false
}

showPick()
