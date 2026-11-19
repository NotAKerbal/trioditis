# Third-party modules

## mautrix-signal

`mautrix-signal/` is `go.mau.fi/mautrix-signal` at the version `../go.mod` requires
(v0.2611.0), with `mautrix-signal.patch` applied. `../go.mod` replaces the module with this
directory, so the bridge host, its tests and the Docker image all build against it.

**Why:** upstream submits a message to Signal again on its own after an ambiguous outcome (a
connection that closed before Signal answered, or a 5xx), before the connector returns. A
send must never be retried then (AGENTS.md): it is reported `unknown` and the person decides.
That happens inside signalmeow's websocket client, which the bridge host can't reach from
outside, so the patch changes it there. What it changes, and what it leaves:
`docs/networks/signal.md`, Sending. Every change in the patch is marked `Trioditis:`.

The copy is upstream's module as `go mod download` fetches it (checked against Go's checksum
database), less `.idea`, which upstream's own `.gitignore` keeps out of a repository.
`node scripts/signal-fork.mjs check`, in `pnpm check` and CI, fails unless the copy is exactly
that plus the patch.

**Changing the patch:** edit the files under `mautrix-signal/`, then
`node scripts/signal-fork.mjs diff` to rewrite `mautrix-signal.patch`.

**Updating mautrix-signal:**

1. Change the version of `go.mau.fi/mautrix-signal` in `../go.mod`.
2. `node scripts/signal-fork.mjs update`: copies the new upstream over `mautrix-signal/` and
   applies the patch. If a hunk no longer applies, it stops before touching the copy; carry
   the change over by hand in a fresh copy and run `diff`.
3. Read upstream's changes for new resubmissions: `retry`, `sendRequestInternal`, and every
   status a send handles (`sending.go`, `senderkey.go`). The patch must still cover each.
4. Check the libsignal version (`pkg/libsignalgo/signalversion`) against the image's pin
   (`docs/networks/signal.md`, Building with Signal), `go mod tidy`, and
   `node scripts/signal-fork.mjs diff`.
5. Run the tagged tests with libsignal: `go test -tags libsignal ./internal/networks/`.
