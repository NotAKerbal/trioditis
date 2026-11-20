// Release notes: every pull request adds a file to release-notes/ saying what it changes, which
// the updater shows admins before and after an update (Admin settings → Updates). See
// docs/CONTRIBUTING.md, Release notes.
//
//   node scripts/release-notes.mjs check
//     Checks every file in release-notes/ against the format.
//   node scripts/release-notes.mjs added <base>
//     Fails unless the changes from <base> to HEAD add a release note. A new file, since the
//     updater shows only the notes an update adds, not edits to ones a server already has.
//
// The updater reads the same format in deploy/updater/updater.sh (release_notes); keep the two
// in step.
import { spawnSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NOTES_DIR = 'release-notes'
/** The labels a note's line may start with, in the order the app shows them. */
export const LABELS = ['New', 'Improved', 'Fixed', 'Security', 'Internal']
/** The longest a line's text may be, in characters. */
export const MAX_TEXT = 200
/** The most lines one file may have. */
export const MAX_LINES = 8
/** What a note's file is called: a short slug, such as the branch's name. */
export const FILE_NAME = /^[a-z0-9][a-z0-9-]{0,79}\.md$/

const LINE = new RegExp(`^(${LABELS.join('|')}): (.+)$`)
// Control characters, tabs included: the updater passes notes on as tab-separated lines.
// oxlint-disable-next-line no-control-regex -- control characters are what it looks for
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * A note's lines as `{ label, text }`, or the problems that keep it from being one. Every
 * non-blank line is `<Label>: <text>`.
 */
export function parseNote(content) {
  const notes = []
  const problems = []
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  lines.forEach((line, i) => {
    if (line.trim() === '') return
    const match = LINE.exec(line)
    if (!match) {
      problems.push(`line ${i + 1} doesn't start with one of ${LABELS.map((l) => `"${l}: "`).join(', ')}`)
      return
    }
    const text = match[2]
    if (CONTROL.test(text)) problems.push(`line ${i + 1} has a tab or another control character`)
    else if (text.trim() !== text) problems.push(`line ${i + 1} has space at its start or end`)
    else if (Array.from(text).length > MAX_TEXT) problems.push(`line ${i + 1} is longer than ${MAX_TEXT} characters`)
    else notes.push({ label: match[1], text })
  })
  if (!problems.length && notes.length === 0) problems.push('it has no lines')
  if (notes.length > MAX_LINES) problems.push(`it has more than ${MAX_LINES} lines`)
  return { notes, problems }
}

/** Every problem with the notes in `dir`, as `<file>: <problem>`. */
export function checkNotes(dir) {
  const problems = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    // A plain file: the updater reads notes from git, where a symlink is only its target's name.
    if (!FILE_NAME.test(name) || !lstatSync(path).isFile()) {
      problems.push(`${name}: a note is a file named like "my-change.md" (lowercase letters, digits and dashes)`)
      continue
    }
    const content = readFileSync(path, 'utf8')
    if (content.includes('\r')) {
      problems.push(`${name}: it has carriage returns`)
      continue
    }
    for (const problem of parseNote(content).problems) problems.push(`${name}: ${problem}`)
  }
  return problems
}

/** The release notes the changes from `base` to HEAD add, in `cwd`'s repository. */
export function addedNotes(base, cwd) {
  const result = spawnSync(
    'git',
    ['diff', '--name-only', '--no-renames', '--diff-filter=A', base, 'HEAD', '--', `${NOTES_DIR}/`],
    { cwd, encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(`git diff from ${base} failed: ${result.stderr.trim()}`)
  return result.stdout.split('\n').filter(Boolean)
}

function main() {
  const root = resolve(fileURLToPath(import.meta.url), '../..')
  const [command, base] = process.argv.slice(2)
  if (command === 'check') {
    const problems = checkNotes(join(root, NOTES_DIR))
    for (const problem of problems) console.error(`${NOTES_DIR}/${problem}`)
    if (problems.length) process.exit(1)
    console.log('Release notes: all in order.')
  } else if (command === 'added' && base) {
    if (addedNotes(base, root).length === 0) {
      console.error(
        `This change adds no release note. Add a file to ${NOTES_DIR}/ saying what it changes (docs/CONTRIBUTING.md, Release notes).`,
      )
      process.exit(1)
    }
    console.log('Release notes: this change has one.')
  } else {
    console.error('usage: release-notes.mjs check | added <base>')
    process.exit(2)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
