// The run's report, as Markdown for people (and the CI job summary) and the same numbers as
// JSON for comparing runs. Pure: everything it shows is passed in.
import { fmt, summarize } from './stats.mjs'

const ms = (v) => (v === null || v === undefined ? '–' : `${fmt(v)} ms`)
const n = (v, digits = 0) => (v === null || v === undefined ? '–' : Number(v).toFixed(digits))
const row = (cells) => `| ${cells.join(' | ')} |`

function table(head, rows) {
  return [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n')
}

export function markdownReport(r) {
  const lines = []
  lines.push(`# Load test: ${r.verdict.passed ? 'PASSED' : 'FAILED'}`)
  lines.push('')
  lines.push(
    `Revision \`${r.revision}\` · ${r.date} · profile **${r.profile}** · backend held to **${r.cpus} CPUs** (\`docker update --cpus\`) · ${r.loadMinutes} min under load · ${r.clients} client${r.clients === 1 ? '' : 's'}`,
  )
  lines.push('')
  lines.push(`Image \`${r.images.backend}\`, on \`${r.images.postgres.split('@')[0]}\`. Host: ${r.host}.`)
  lines.push('')
  lines.push('## Checks')
  lines.push('')
  lines.push(
    table(
      ['Check', 'Result', 'Detail'],
      r.verdict.checks.map((c) => [c.name, c.passed ? 'pass' : '**FAIL**', c.detail.replaceAll('|', '\\|')]),
    ),
  )
  lines.push('')
  lines.push('## Load')
  lines.push('')
  const s = r.inbox
  lines.push(
    `Inbox: **${s.chats.toLocaleString('en')} chats** (${Object.entries(s.chatsByNetwork)
      .map(([k, v]) => `${k} ${v}`)
      .join(
        ', ',
      )}; ${s.groups} groups), **${s.messages.toLocaleString('en')} messages** (largest chat ${s.biggestChat.toLocaleString('en')}), ${s.reactions.toLocaleString('en')} reactions, ${s.attachments.toLocaleString('en')} attachments, ${s.contacts.toLocaleString('en')} contacts, ${s.people} People cards, ${s.labels} labels; ${s.unreadChats} unread, ${s.pinned} pinned, ${s.archived} archived, ${s.snoozed} snoozed, ${s.muted} muted, ${s.requests} requests. Seeded in ${n(r.seedSeconds)} s through the bridge ingestion path; database ${r.databaseSize || '?'}.`,
  )
  lines.push('')
  const t = r.traffic
  lines.push(
    `Writes while measured: ${r.rates.backfillPerMinute}/min backfill on ${r.rates.backfillNetwork}, ${r.rates.livePerMinute}/min live across every network. Sent: ${t.backfill} backfilled and ${t.live} live messages, ${t.typing} typing, ${t.reactions} reactions, ${t.receipts} receipts, ${t.edits} edits. Bridge pushes: ${r.bridges.pushes} (${r.bridges.failedPushes} failed), p95 ${ms(r.bridges.pushMs.p95)}; backlog left at the end ${r.bridges.backlogAtEnd}. Commands delivered: ${
      Object.entries(r.bridges.commands)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'none'
    }.`,
  )
  lines.push('')
  lines.push(
    `Clients: ${
      Object.entries(r.client.actions)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ') || 'no clicks'
    }; up to ${r.client.peakSubscriptions} live queries each. Backend CPU while measured: mean ${n(r.cpu.mean)}%, peak ${n(r.cpu.max)}% (of ${r.cpus * 100}%).`,
  )
  lines.push('')
  lines.push('## What people would notice')
  lines.push('')
  lines.push(
    table(
      ['What', 'Count', 'p50', 'p95', 'p99', 'Max'],
      [
        ['Opening a chat, until its messages show', ...stat(r.client.opens)],
        ['A live message, from its bridge host to an open or warm chat', ...stat(r.client.visible)],
        ['A bridge host push acknowledged', ...stat(r.bridges.pushMsAll)],
        ['A click, start to finish', ...stat(r.client.actionMs)],
      ],
    ),
  )
  lines.push('')
  lines.push('## Most expensive functions')
  lines.push('')
  lines.push(
    'Ranked by total execution time while measured, the share of the backend each took. Cached answers are counted in Calls but not timed.',
  )
  lines.push('')
  lines.push(
    table(
      [
        '#',
        'Function',
        'Type',
        'Calls',
        '/min',
        'Cached',
        'Total s',
        'Share',
        'p50',
        'p95',
        'p99',
        'Max',
        'Timeouts',
        'Errors',
        'Docs read',
      ],
      r.functions
        .slice(0, r.top)
        .map((f, i) => [
          i + 1,
          `\`${f.fn}\``,
          f.type,
          f.calls,
          n(f.perMinute),
          f.cached,
          n(f.totalMs / 1000, 1),
          `${n(f.share * 100, 1)}%`,
          fmt(f.p50),
          fmt(f.p95),
          fmt(f.p99),
          fmt(f.max),
          f.timeouts || '',
          f.errors || '',
          n(f.avgReadDocs),
        ]),
    ),
  )
  lines.push('')
  const failing = r.functions.filter((f) => f.errors > 0)
  if (failing.length) {
    lines.push('## Errors')
    lines.push('')
    lines.push(
      table(
        ['Function', 'Count', 'Kind'],
        failing.flatMap((f) =>
          Object.entries(f.errorKinds).map(([kind, count]) => [`\`${f.fn}\``, count, kind.replaceAll('|', '\\|')]),
        ),
      ),
    )
    lines.push('')
  }
  if (r.client.errors) {
    lines.push('## What the clients saw fail')
    lines.push('')
    lines.push(
      table(
        ['Kind', 'Count'],
        Object.entries(r.client.errorKinds)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 30)
          .map(([k, v]) => [k.replaceAll('|', '\\|'), v]),
      ),
    )
    lines.push('')
  }
  lines.push('## Minute by minute')
  lines.push('')
  lines.push(
    table(
      ['Minute', 'Executions', 'Timeouts', 'Errors', 'CPU %'],
      r.minutes.map((m) => [m.minute, m.executions, m.timeouts, m.errors, n(m.cpu)]),
    ),
  )
  lines.push('')
  lines.push(`Settings: \`${JSON.stringify(r.settings)}\``)
  lines.push('')
  return lines.join('\n')
}

function stat(values = []) {
  const s = summarize(values)
  return [s.count, ms(s.p50), ms(s.p95), ms(s.p99), ms(s.max)]
}
