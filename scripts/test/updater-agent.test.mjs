// The updater's agent (deploy/scripts/updater-agent.mjs): the report it makes from the updater's
// variables, with the release notes, and how it gets that report through to a backend, an updater
// or a backend from before release notes among them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reportArgs, sendReport } from '../../deploy/scripts/updater-agent.mjs'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const latest = {
  UPDATER_LATEST: B,
  UPDATER_LATEST_CHANNEL: 'nightly',
  UPDATER_LATEST_AT: '2',
  UPDATER_LATEST_SUBJECT: 'Merge',
  UPDATER_BEHIND: '3',
  UPDATER_AHEAD: '0',
  UPDATER_CHECKED_AT: '4',
}

void test('a report carries the notes on offer and those of the update just installed', () => {
  const args = reportArgs(
    {
      UPDATER_STATE: 'idle',
      UPDATER_MESSAGE: 'Updated to aaaaaaa.',
      UPDATER_DONE: 'req1',
      ...latest,
      UPDATER_LATEST_NOTES: 'New\tAdd one\nnot a note\nOdd\tlabel\nFixed\t \nFixed\tMend one',
      UPDATER_INSTALLED_FROM: A,
      UPDATER_INSTALLED_TO: B,
      UPDATER_INSTALLED_NOTES: 'Security\tClose a hole',
    },
    'secret',
  )
  assert.deepEqual(args.latest.notes, [
    { label: 'new', text: 'Add one' },
    { label: 'fixed', text: 'Mend one' },
  ])
  assert.equal(args.latest.checkedAt, 4000)
  assert.deepEqual(args.installed, { from: A, to: B, notes: [{ label: 'security', text: 'Close a hole' }] })
  assert.equal(args.done, 'req1')
})

void test('no notes, no fields for them, so the report fits an older backend', () => {
  const args = reportArgs({ UPDATER_STATE: 'idle', ...latest, UPDATER_LATEST_NOTES: '' }, 'secret')
  assert.equal('notes' in args.latest, false)
  assert.equal('installed' in args, false)
  // Nor an installed update whose ends aren't both commits.
  const half = reportArgs({ UPDATER_STATE: 'idle', UPDATER_LATEST_NOTES: '', UPDATER_INSTALLED_TO: B }, 's')
  assert.equal('installed' in half, false)
})

void test('the end of an update reported by an updater from before release notes is left for the next one', () => {
  // That updater passes none of the notes' variables.
  const old = {
    UPDATER_STATE: 'idle',
    UPDATER_MESSAGE: `Updated to ${B.slice(0, 7)}.`,
    UPDATER_DONE: 'req1',
    ...latest,
  }
  assert.equal(reportArgs(old, 'secret'), null)
  // An automatic update's, which names no request, too.
  assert.equal(reportArgs({ ...old, UPDATER_DONE: '' }, 'secret'), null)
  // Its other reports go through as before.
  assert.equal(reportArgs({ ...old, UPDATER_MESSAGE: 'Already up to date.' }, 'secret').state, 'idle')
  assert.equal(
    reportArgs({ ...old, UPDATER_STATE: 'failed', UPDATER_MESSAGE: 'The update failed.' }, 's').state,
    'failed',
  )
  // This version's updater sends it.
  assert.equal(reportArgs({ ...old, UPDATER_LATEST_NOTES: '' }, 'secret').done, 'req1')
})

void test('a backend that refuses the notes gets the report again without them', async () => {
  const args = reportArgs(
    {
      UPDATER_STATE: 'failed',
      ...latest,
      UPDATER_LATEST_NOTES: 'New\tAdd one',
      UPDATER_INSTALLED_FROM: A,
      UPDATER_INSTALLED_TO: B,
      UPDATER_INSTALLED_NOTES: '',
    },
    'secret',
  )
  const sent = []
  await sendReport(async (a) => {
    sent.push(a)
    if (sent.length === 1)
      throw new Error('ArgumentValidationError: Object contains extra field `notes` that is not in the validator.')
  }, args)
  assert.equal(sent.length, 2)
  assert.equal('notes' in sent[1].latest, false)
  assert.equal('installed' in sent[1], false)
  assert.equal(sent[1].latest.commit, B)

  // Any other failure is the updater's to retry, and a report without notes isn't sent twice.
  await assert.rejects(
    sendReport(async () => {
      throw new Error('That request was cancelled.')
    }, args),
    /cancelled/,
  )
  let calls = 0
  await assert.rejects(
    sendReport(
      async () => {
        calls++
        throw new Error('Object contains extra field `x`')
      },
      { secret: 's', state: 'idle' },
    ),
    /extra field/,
  )
  assert.equal(calls, 1)
})
