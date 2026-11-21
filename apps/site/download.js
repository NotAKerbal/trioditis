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
// More than one means the browser can't tell which, and the visitor chooses. The system
// versions follow the requirements on the page: Electron 44 and later need macOS 13 and
// Windows 10.
function fittingFiles(os, files, hints, agent, touchPoints) {
  const version = parseInt(hints.platformVersion, 10)
  if (os === 'mac') {
    // Chromium gives the macOS version. Safari's user agent stops at 10.15, but Safari 18 and
    // later don't run on macOS 12; Firefox's says nothing that helps.
    const safari = /Version\/(\d+)[\d.]* Safari\//.exec(agent)
    const supported = hints.platformVersion ? version >= 13 : Boolean(safari) && Number(safari[1]) >= 18
    if (!supported) return null
    // Chromium also says which processor a Mac has; Safari doesn't.
    const match = files.filter((file) => file.dataset.arch === hints.architecture)
    return match.length ? match : files
  }
  if (os === 'windows') {
    // Chromium's platform version is 1 to 10 for Windows 10 and 13 or later for 11, and 0 for
    // anything older. The installer is x64: 32-bit Windows can't run it, nor can Windows 10 on
    // Arm, though Windows 11 runs it on Arm by emulation.
    const nt = /Windows NT (\d+)/.exec(agent)
    const supported = hints.platformVersion ? version >= 1 : Boolean(nt) && Number(nt[1]) >= 10
    const is64 = hints.bitness ? hints.bitness === '64' : /Win64|WOW64/.test(agent)
    if (!supported || !is64) return null
    if (hints.architecture === 'arm' && !(version >= 13)) return null
    return files
  }
  if (os === 'linux') {
    // Only Chromium can be believed here: its user agent and Firefox's both say x86_64 whatever
    // the processor. Chrome on an Android tablet in desktop mode reports Linux on x86_64 too, so
    // a touch screen rules it out.
    if (touchPoints > 0) return null
    return hints.architecture === 'x86' && hints.bitness === '64' ? files : null
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

void showPick()
