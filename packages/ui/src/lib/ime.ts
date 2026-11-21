/**
 * Whether an Escape that would close a dialog is the IME's instead: one that cancels a
 * candidate (key code 229 is how Safari marks it), or a repeat of one held through the
 * composition's end. A held Escape's repeats never close anything; its first press already did.
 */
export function imeEscape(e: { isComposing: boolean; keyCode: number; repeat: boolean }): boolean {
  return e.isComposing || e.keyCode === 229 || e.repeat
}
