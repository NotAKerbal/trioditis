# Brand

_Trioditis_ means "of the three roads": a crossroads for all of your conversations. The mark is
that crossroads, drawn like a transit map. Three routes come in from beyond the edge of the tile
and meet at one interchange, the way every network meets in one inbox.

![The Trioditis lockup](../assets/brand/lockup.svg)

## The pieces

| File                                      | What it is                                                     | Use it for                                       |
| ----------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| `assets/brand/icon.svg`                   | The mark on its blue tile                                      | App icon, favicon, avatars, anywhere square      |
| `assets/brand/icon-mono.svg`              | The tile in `currentColor` with the routes cut out             | Tray and notification icons, one-colour printing |
| `assets/brand/wordmark.svg`, `-dark.svg`  | "Trioditis" in DM Sans Bold, outlined, with accent i-dots      | Where the name stands alone                      |
| `assets/brand/lockup.svg`, `-dark.svg`    | The icon and wordmark together                                 | Headers, the README, docs                        |
| `assets/brand/social-card.png` (and .svg) | 1200 × 630 lockup and tagline                                  | Link previews                                    |
| `assets/brand/png/icon-*.png`             | The icon at 16–1024 px                                         | Stores, installers, Electron, PWA manifests      |
| `assets/brand/favicon.ico`                | 16, 32 and 48 px                                               | Browsers that don't take an SVG favicon          |
| `@trioditis/ui/wordmark`                  | The wordmark as a component: text colour plus the theme accent | The app; it follows light and dark mode          |

The `-dark` files are for dark backgrounds. The icon is the same in both themes: its blue tile reads
on either.

## The wordmark

The name is set in DM Sans Bold at -0.01em, as the app sets it. "Trioditis" has three i's, and their
dots are the accent colour, one for each road. Everything else is ink. Don't retype the wordmark in a
live font for a logo; use the files or the component, which have the dots split out.

In a lockup the wordmark is 60% of the icon's height and sits 30% of that height away from it.

## Colour

The brand colours are the app's tokens in `packages/ui/src/styles/tokens.css`.

| Role        | Light     | Dark      |
| ----------- | --------- | --------- |
| Accent      | `#0284c7` | `#38bdf8` |
| Ink         | `#0f172a` | `#e9ebf0` |
| Icon routes | `#ffffff` | `#ffffff` |

## Keep it recognisable

- Leave clear space around the icon of at least a quarter of its width.
- Don't recolour the tile, rotate the mark or redraw the routes. For one colour, use
  `icon-mono.svg`.
- Don't put the mark inside another shape or add shadows, outlines or gradients.
- Don't use the mark without its tile: the routes need the tile's edges to read as a map.

## Changing it

Every file here comes from `packages/brand/generate.mjs`, which holds the geometry and colours. Edit
it, then run:

```sh
pnpm --filter @trioditis/brand generate
```

It rewrites the files in `assets/brand/`, the icons the web app, the project site and the desktop
app serve (`apps/desktop/public/`, `apps/site/`, `apps/desktop/electron/`) and
`packages/ui/src/components/wordmark.tsx`. Commit them together.
