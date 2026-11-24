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
5. Run the tests with libsignal on the linker path (`LIBRARY_PATH`): the bridge host's,
   `go test -tags libsignal ./internal/networks/`, and the patch's own, which `./...` doesn't
   reach: `go test go.mau.fi/mautrix-signal/pkg/signalmeow`.

## mautrix

`mautrix/` is `maunium.net/go/mautrix` (bridgev2, which every connector runs on) at the
version `../go.mod` requires (v0.33.0), with `mautrix.patch` applied, replaced the same way.
The same script keeps it: `node scripts/signal-fork.mjs check` checks both copies, and
`diff mautrix` / `update mautrix` work on this one alone.

**Why:** bridgev2 stops waiting for an event's handler after its handler limit and reports an
assumed success, while handling carries on. WhatsApp and Signal acknowledge an incoming message
on that success, so a message the process then stops before saving in full is lost, and one
whose handling then fails part way is dropped as a duplicate when redelivered. The patch adds
`bridgev2.RemoteEventDone`, called with each remote event's real outcome when its handler
returns, which the host waits on (`internal/handled`). It also adds `bridgev2.BeforeBackfillTask`,
called before each backfill queue task and before any portal lock, where the host holds older
history back while its server is behind (`internal/gateway/pressure.go`). Every change is marked
`Trioditis:`.

**Updating mautrix:** change its version in `../go.mod`, `node scripts/signal-fork.mjs update
mautrix`, check that `handleSingleEventWithDelayLogging` (`bridgev2/portal.go`) still hands
every remote event's outcome to the callback the patch hooks, then `go mod tidy` and run the
bridge host's tests, the libsignal-tagged ones included.
