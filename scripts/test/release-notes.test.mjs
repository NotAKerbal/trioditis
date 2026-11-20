// Release notes (scripts/release-notes.mjs): the format each pull request's note must follow,
// and the check that a pull request adds one.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addedNotes, checkNotes, parseNote } from '../release-notes.mjs'

void test('a note is labelled lines', () => {
  assert.deepEqual(parseNote('New: Add a thing.\n\nFixed: Mend a thing.\n'), {
    notes: [
      { label: 'New', text: 'Add a thing.' },
      { label: 'Fixed', text: 'Mend a thing.' },
    ],
    problems: [],
  })
  // Without a final newline too.
  assert.deepEqual(parseNote('Internal: Tidy up.').notes, [{ label: 'Internal', text: 'Tidy up.' }])
})

void test('a note that doesn’t fit the format is refused', () => {
  const problems = (content) => parseNote(content).problems
  assert.match(problems('Added a thing.\n')[0], /line 1 doesn't start with/)
  assert.match(problems('new: lowercase label\n')[0], /doesn't start with/)
  assert.match(problems('New:no space\n')[0], /doesn't start with/)
  assert.match(problems('New: a\ttab\n')[0], /control character/)
  assert.match(problems('New: trailing \n')[0], /space at its start or end/)
  assert.match(problems(`New: ${'x'.repeat(201)}\n`)[0], /longer than 200/)
  assert.deepEqual(problems(`New: ${'é'.repeat(200)}\n`), [])
  assert.match(problems('\n\n')[0], /no lines/)
  assert.match(problems('Fixed: x\n'.repeat(9))[0], /more than 8 lines/)
})

void test('the check looks at every file in the directory, and their names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-notes-'))
  try {
    writeFileSync(join(dir, 'good-one.md'), 'New: Fine.\n')
    writeFileSync(join(dir, 'Bad Name.md'), 'New: Fine.\n')
    writeFileSync(join(dir, 'crlf.md'), 'New: Fine.\r\n')
    writeFileSync(join(dir, 'broken.md'), 'Fine.\n')
    mkdirSync(join(dir, 'nested.md'))
    symlinkSync('good-one.md', join(dir, 'alias.md'))
    assert.deepEqual(checkNotes(dir), [
      'Bad Name.md: a note is a file named like "my-change.md" (lowercase letters, digits and dashes)',
      'alias.md: a note is a file named like "my-change.md" (lowercase letters, digits and dashes)',
      'broken.md: line 1 doesn\'t start with one of "New: ", "Improved: ", "Fixed: ", "Security: ", "Internal: "',
      'crlf.md: it has carriage returns',
      'nested.md: a note is a file named like "my-change.md" (lowercase letters, digits and dashes)',
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('a change counts as having a note only when it adds a line no note had', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-notes-git-'))
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
      cwd: dir,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  try {
    git('init', '-q')
    mkdirSync(join(dir, 'release-notes'))
    writeFileSync(join(dir, 'release-notes', 'first.md'), 'New: One.\n')
    git('add', '-A')
    git('commit', '-qm', 'one')
    const base = git('rev-parse', 'HEAD')
    writeFileSync(join(dir, 'code.txt'), 'code\n')
    git('add', '-A')
    git('commit', '-qm', 'code only')
    assert.deepEqual(addedNotes(base, dir), [])
    // A blank line added to a note says nothing new.
    writeFileSync(join(dir, 'release-notes', 'first.md'), 'New: One.\n\n')
    git('commit', '-qam', 'edit a note')
    assert.deepEqual(addedNotes(base, dir), [])
    writeFileSync(join(dir, 'release-notes', 'second.md'), 'Fixed: Two.\n')
    git('add', '-A')
    git('commit', '-qm', 'add a note')
    assert.deepEqual(addedNotes(base, dir), ['Fixed: Two.'])
    const added = git('rev-parse', 'HEAD')
    // Nor does renaming a note, or moving its line into another.
    git('mv', 'release-notes/first.md', 'release-notes/renamed.md')
    git('commit', '-qm', 'rename a note')
    assert.deepEqual(addedNotes(added, dir), [])
    writeFileSync(join(dir, 'release-notes', 'second.md'), 'Fixed: Two.\nNew: One.\n')
    git('rm', '-q', 'release-notes/renamed.md')
    git('commit', '-qam', 'merge two notes')
    assert.deepEqual(addedNotes(added, dir), [])
    // A new line beside a rewritten one counts.
    writeFileSync(join(dir, 'release-notes', 'third.md'), 'Improved: Three.\n')
    writeFileSync(join(dir, 'release-notes', 'second.md'), 'Fixed: Two, again.\n')
    git('add', '-A')
    git('commit', '-qm', 'add and rewrite')
    assert.deepEqual(addedNotes(added, dir), ['Fixed: Two, again.', 'Improved: Three.'])
    const rewritten = git('rev-parse', 'HEAD')
    git('rm', '-q', 'release-notes/second.md')
    git('commit', '-qm', 'remove it')
    // Removing a note isn't writing one.
    assert.deepEqual(addedNotes(rewritten, dir), [])
    assert.throws(() => addedNotes('no-such-ref', dir), /git grep at no-such-ref failed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
