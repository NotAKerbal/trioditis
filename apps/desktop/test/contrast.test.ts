import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Text tokens against the surfaces they're drawn on, in both themes: WCAG AA wants 4.5:1 for
// body text, and the sidebar's times and an outgoing bubble's text once fell short of it.

const css = readFileSync(new URL('../../../packages/ui/src/styles/tokens.css', import.meta.url), 'utf8')

const hex = (c: number[]) =>
  `#${c
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
const rgb = (value: string) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255)

/** A theme's colours as hex. A translucent one (`rgb(r g b / a)`) is laid over its `--surface`. */
function block(selector: string, base: Record<string, string> = {}): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  const body = css.slice(start, css.indexOf('\n}', start))
  const out: Record<string, string> = { ...base }
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/g)) out[m[1]!] = m[2]!
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\);/g)) {
    const under = rgb(out.surface!)
    const alpha = Number(m[5])
    out[m[1]!] = hex([m[2], m[3], m[4]].map((v, i) => (Number(v) / 255) * alpha + under[i]! * (1 - alpha)))
  }
  return out
}

const light = block(':root')
const dark = block(":root[data-theme='dark']", light)
const luminance = (c: number[]) => {
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
/** The contrast of `fg` drawn at `alpha` over `bg`. */
export function contrast(fg: string, bg: string, alpha = 1) {
  const b = rgb(bg)
  const f = rgb(fg).map((v, i) => v * alpha + b[i]! * (1 - alpha))
  const [hi, lo] = [luminance(f), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

const SURFACES = ['bg', 'surface', 'surface-2', 'rail', 'rail-hover']
// [text, background, opacity]: each text token on every surface, and text on coloured fills.
const PAIRS: [string, string, number][] = [
  ...['fg', 'fg-muted', 'fg-subtle', 'accent', 'warning', 'danger'].flatMap((fg) =>
    SURFACES.map((bg): [string, string, number] => [fg, bg, 1]),
  ),
  // An outgoing bubble: its text, and its time and ticks at 90%.
  ['accent-fg', 'accent', 1],
  ['accent-fg', 'accent', 0.9],
  ['accent-ink', 'accent-soft', 1],
  ['warning-ink', 'warning-soft', 1],
]

describe.each([
  ['light', light],
  ['dark', dark],
])('%s theme text contrast', (_, tokens) => {
  it.each(PAIRS)('%s on %s at %s reads at 4.5:1 or more', (fg, bg, alpha) => {
    expect(tokens[fg], fg).toBeDefined()
    expect(tokens[bg], bg).toBeDefined()
    expect(contrast(tokens[fg]!, tokens[bg]!, alpha)).toBeGreaterThanOrEqual(4.5)
  })
})

it('measures contrast as WCAG does', () => {
  expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
  expect(contrast('#94a3b8', '#f4f5f7')).toBeCloseTo(2.35, 1)
})
