// Windows has no badge count on the taskbar, only an overlay picture on the app's button: a dot
// says there are unread chats. Drawn here as raw pixels, with no Electron in it, so it can be
// tested in Node and needs no image file in the package.

/** A red dot, `size` pixels square, as BGRA bytes (what nativeImage.createFromBitmap takes). */
export function dotBitmap(size: number): Buffer {
  const pixels = Buffer.alloc(size * size * 4)
  const centre = size / 2
  const radius = size / 2 - 0.5
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - centre, y + 0.5 - centre)
      // A pixel's coverage of the circle's edge, so the dot isn't jagged.
      const alpha = Math.max(0, Math.min(1, radius - distance + 0.5))
      if (alpha === 0) continue
      const i = (y * size + x) * 4
      // Premultiplied, as Chromium's bitmaps are: #dc2626.
      pixels[i] = Math.round(0x26 * alpha)
      pixels[i + 1] = Math.round(0x26 * alpha)
      pixels[i + 2] = Math.round(0xdc * alpha)
      pixels[i + 3] = Math.round(0xff * alpha)
    }
  }
  return pixels
}
