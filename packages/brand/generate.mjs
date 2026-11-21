// Generates every Trioditis brand asset from the geometry and colours below:
//   pnpm --filter @trioditis/brand generate
// The outputs are committed, so this only needs to run when the brand changes. See docs/brand.md.
import fs from 'node:fs'
import path from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import opentype from 'opentype.js'
import pngToIco from 'png-to-ico'

const root = path.resolve(import.meta.dirname, '../..')

// The same values as the accent and ink tokens in packages/ui/src/styles/tokens.css.
const C = {
  accent: '#0284c7',
  accentDark: '#38bdf8',
  ink: '#0f172a',
  inkDark: '#e9ebf0',
  mutedDark: '#94a3b8',
  white: '#ffffff',
}

// The mark: three routes meeting at an interchange, on a 64-unit rounded tile. The routes run off
// the tile's edges, like a crop of a transit map, so they are clipped to it.
const ROUTES = ['M37 -4C37 14 30 20 30 34', 'M-4 31C10 31 18 32 30 34', 'M61 68C56 52 41 47 30 34']
const HUB = { cx: 30, cy: 34, r: 10.5, hole: 4.5 }
const ROUTE_WIDTH = 7

const tile = (
  tileColour,
  lineColour,
) => `<clipPath id="trioditis-tile"><rect width="64" height="64" rx="14"/></clipPath>
  <rect width="64" height="64" rx="14" fill="${tileColour}"/>
  <g clip-path="url(#trioditis-tile)" fill="none" stroke="${lineColour}" stroke-width="${ROUTE_WIDTH}">
${ROUTES.map((d) => `    <path d="${d}"/>`).join('\n')}
  </g>
  <circle cx="${HUB.cx}" cy="${HUB.cy}" r="${HUB.r}" fill="${lineColour}"/>
  <circle cx="${HUB.cx}" cy="${HUB.cy}" r="${HUB.hole}" fill="${tileColour}"/>`

const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  ${tile(C.accent, C.white)}
</svg>
`

// One colour, for places that tint an icon themselves: the tile in currentColor with the routes cut
// out, so it reads on any background without a second colour.
const iconMono = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <mask id="trioditis-cut">
    <rect width="64" height="64" fill="#fff"/>
    <g fill="none" stroke="#000" stroke-width="${ROUTE_WIDTH}">
${ROUTES.map((d) => `      <path d="${d}"/>`).join('\n')}
    </g>
    <circle cx="${HUB.cx}" cy="${HUB.cy}" r="${HUB.r}" fill="#000"/>
    <circle cx="${HUB.cx}" cy="${HUB.cy}" r="${HUB.hole}" fill="#fff"/>
  </mask>
  <rect width="64" height="64" rx="14" fill="currentColor" mask="url(#trioditis-cut)"/>
</svg>
`

// Text is set as outlines from DM Sans, the app's typeface, so the files look the same on machines
// without it.
const fonts = new Map()
function font(weight) {
  if (!fonts.has(weight)) {
    const file = path.join(
      import.meta.dirname,
      `node_modules/@fontsource/dm-sans/files/dm-sans-latin-${weight}-normal.woff`,
    )
    fonts.set(weight, opentype.loadSync(file))
  }
  return fonts.get(weight)
}

const round = (n) => Math.round(n * 100) / 100
const pathData = (commands) =>
  commands
    .map((c) =>
      c.type === 'Z'
        ? 'Z'
        : c.type +
          [c.x1, c.y1, c.x2, c.y2, c.x, c.y]
            .filter((v) => v !== undefined)
            .map(round)
            .join(' '),
    )
    .join('')

/**
 * Sets a line of text at 100 units to the em. With `splitDots`, the dot of each i comes back on its
 * own, which is how the wordmark colours its three i-dots, one for each road.
 */
function setText(text, { weight, tracking = 0, splitDots = false }) {
  const size = 100
  const f = font(weight)
  const glyphs = f.stringToGlyphs(text)
  let x = 0
  let body = ''
  let dots = ''
  const box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }
  glyphs.forEach((glyph, i) => {
    const p = glyph.getPath(x, 0, size)
    if (p.commands.length) {
      const b = p.getBoundingBox()
      box.x1 = Math.min(box.x1, b.x1)
      box.y1 = Math.min(box.y1, b.y1)
      box.x2 = Math.max(box.x2, b.x2)
      box.y2 = Math.max(box.y2, b.y2)
    }
    if (splitDots && text[i] === 'i') {
      const contours = []
      for (const c of p.commands) {
        if (c.type === 'M') contours.push([])
        contours.at(-1).push(c)
      }
      // The dot is whichever contour reaches highest.
      const top = (contour) => Math.min(...contour.filter((c) => c.y !== undefined).map((c) => c.y))
      const dot = contours.reduce((a, b) => (top(a) < top(b) ? a : b))
      for (const contour of contours) {
        if (contour === dot) dots += pathData(contour)
        else body += pathData(contour)
      }
    } else {
      body += pathData(p.commands)
    }
    x += (glyph.advanceWidth / f.unitsPerEm) * size + tracking * size
    if (i < glyphs.length - 1) x += (f.getKerningValue(glyph, glyphs[i + 1]) / f.unitsPerEm) * size
  })
  return { body, dots, x: box.x1, y: box.y1, w: box.x2 - box.x1, h: box.y2 - box.y1 }
}

// The app sets its name in DM Sans Bold at -0.01em, so the wordmark does too.
const word = setText('Trioditis', { weight: 700, tracking: -0.01, splitDots: true })
const wordViewBox = [word.x, word.y, word.w, word.h].map(round).join(' ')

const wordmark = (ink, dot) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${wordViewBox}">
  <path fill="${ink}" d="${word.body}"/>
  <path fill="${dot}" d="${word.dots}"/>
</svg>
`

/** The icon, then the wordmark at 60% of its height and 30% of it away, centred on it. */
function lockup(ink, dot, height = 64) {
  const scale = (height * 0.6) / word.h
  const gap = height * 0.3
  const width = height + gap + word.w * scale
  const top = (height - word.h * scale) / 2
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(width)} ${height}">
  <g transform="scale(${height / 64})">
  ${tile(C.accent, C.white)}
  </g>
  <g transform="translate(${round(height + gap - word.x * scale)} ${round(top - word.y * scale)}) scale(${round(scale * 1e4) / 1e4})">
    <path fill="${ink}" d="${word.body}"/>
    <path fill="${dot}" d="${word.dots}"/>
  </g>
</svg>
`
  return { width, svg }
}

/** The link preview image, 1200 × 630: the lockup and the tagline on ink. */
function socialCard() {
  const mark = lockup(C.inkDark, C.accentDark, 128)
  const tagline = setText('A crossroads for all of your conversations.', { weight: 500, tracking: -0.005 })
  const taglineScale = 0.34
  const left = (1200 - mark.width) / 2
  const top = 230
  const taglineLeft = (1200 - tagline.w * taglineScale) / 2 - tagline.x * taglineScale
  const taglineTop = top + 128 + 70 - tagline.y * taglineScale
  const inner = mark.svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${C.ink}"/>
  <g transform="translate(${round(left)} ${top})">${inner}</g>
  <path fill="${C.mutedDark}" transform="translate(${round(taglineLeft)} ${round(taglineTop)}) scale(${taglineScale})" d="${tagline.body}"/>
</svg>
`
}

// The app draws the wordmark inline, so it can take the theme's colours instead of fixed ones.
const wordmarkComponent = `import type * as React from 'react'
import { cn } from '../lib/utils.ts'

/*
 * The Trioditis wordmark, DM Sans Bold set as outlines so it looks the same without the font. The
 * letters take the text colour and the three i-dots take the accent, so it follows the theme.
 * Generated by packages/brand/generate.mjs; see docs/brand.md.
 */
const LETTERS =
  '${word.body}'
const DOTS =
  '${word.dots}'

/** The wordmark. Size it by height, e.g. \`className="h-5"\`. */
function Wordmark({ className, ...props }: React.ComponentProps<'svg'>) {
  return (
    <svg
      data-slot="wordmark"
      role="img"
      aria-label="Trioditis"
      viewBox="${wordViewBox}"
      className={cn('w-auto', className)}
      {...props}
    >
      <path fill="currentColor" d={LETTERS} />
      <path className="fill-primary" d={DOTS} />
    </svg>
  )
}

export { Wordmark }
`

const png = (svg, width) => new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng()

function write(file, data) {
  const target = path.join(root, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, data)
  console.log(`wrote ${file}`)
}

write('assets/brand/icon.svg', icon)
write('assets/brand/icon-mono.svg', iconMono)
write('assets/brand/wordmark.svg', wordmark(C.ink, C.accent))
write('assets/brand/wordmark-dark.svg', wordmark(C.inkDark, C.accentDark))
write('assets/brand/lockup.svg', lockup(C.ink, C.accent).svg)
write('assets/brand/lockup-dark.svg', lockup(C.inkDark, C.accentDark).svg)
const card = socialCard()
write('assets/brand/social-card.svg', card)
write('assets/brand/social-card.png', png(card, 1200))
for (const size of [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024]) {
  write(`assets/brand/png/icon-${size}.png`, png(icon, size))
}
const favicon = await pngToIco([16, 32, 48].map((size) => png(icon, size)))
write('assets/brand/favicon.ico', favicon)

// The web app serves its own copies from its public directory.
write('apps/desktop/public/icon.svg', icon)
write('apps/desktop/public/favicon.ico', favicon)
write('apps/desktop/public/apple-touch-icon.png', png(icon, 180))
write('packages/ui/src/components/wordmark.tsx', wordmarkComponent)
