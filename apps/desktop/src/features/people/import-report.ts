// What an import tells the person when it's done: how many it saved, and everything it had to
// change to save them, so nothing goes missing without a word.

export interface ImportReport {
  /** Cards written. */
  written: number
  /** Cards that were all here already, as the file has them. */
  unchanged?: boolean
  /** Photos that couldn't be read as pictures, and were left out. */
  unreadablePhotos: number
  /** Photos made smaller than usual, for cards that were too large. */
  smallerPhotos: number
  /** Photos left out of cards too large even with a tiny one. */
  droppedPhotos: number
  /** The names on cards whose note was cut to fit. */
  cutNotes: string[]
  /** The names on entries left out because each matched more than one person here. */
  ambiguous: string[]
}

export const emptyReport = (): ImportReport => ({
  written: 0,
  unreadablePhotos: 0,
  smallerPhotos: 0,
  droppedPhotos: 0,
  cutNotes: [],
  ambiguous: [],
})

const people = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'person' : 'people'}`
/** "1 photo was", "2 photos were". */
const photos = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'photo was' : 'photos were'}`

/** The import's result as sentences, the first saying how many were imported. */
export function importSummary(report: ImportReport): string {
  const lines = [
    report.written
      ? `Imported ${people(report.written)}.`
      : report.unchanged
        ? 'Everyone in that file is here already.'
        : 'Nothing was imported.',
  ]
  if (report.unreadablePhotos) lines.push(`${photos(report.unreadablePhotos)} unreadable and left out.`)
  if (report.smallerPhotos) lines.push(`${photos(report.smallerPhotos)} made smaller to fit.`)
  if (report.droppedPhotos) lines.push(`${photos(report.droppedPhotos)} left out of cards too large for them.`)
  if (report.cutNotes.length) {
    const [first, ...rest] = report.cutNotes
    lines.push(
      rest.length
        ? `Notes on ${first} and ${people(rest.length)} more were too long and were shortened.`
        : `The note on ${first} was too long and was shortened.`,
    )
  }
  if (report.ambiguous.length) {
    const [first, ...rest] = report.ambiguous
    lines.push(
      rest.length
        ? `${first} and ${people(rest.length)} more weren’t imported: each matches more than one person here.`
        : `${first} wasn’t imported: they match more than one person here.`,
    )
  }
  return lines.join(' ')
}

/** What to say when an import stopped after saving some of the file. */
export function partlyImported(written: number, total: number, reason: string): string {
  return (
    `Imported ${written.toLocaleString()} of ${people(total)} before it stopped: ${reason} ` +
    'Import the file again to add the rest; those already imported won’t be added twice.'
  )
}
