# Signal

Signal, through `go.mau.fi/mautrix-signal` **v0.2611.0** (`pkg/connector`,
`SignalConnector`), which links Signal's own Rust library, **libsignal v0.106.1**
(`github.com/signalapp/libsignal`, tag `v0.106.1`, commit
`904c8dc8216073b078a5f2f5090e3da8382e6a92`), through cgo. Network ID `signal`, maturity
**experimental** (stable is its v1 target in docs/PLAN.md), `termsRisk: false`: the bridge
is a linked device, like Signal Desktop, made with Signal's own linking flow.

**Receive-only for now** (`receiveOnly: true` in `NETWORK_INFO`): messages, history and
read state come in, but the bridge host refuses sends, edits, reactions and deletions. See
Sending.

One login is one Signal account, linked as a secondary device of the phone. The phone
stays the primary device: it must stay registered, and Signal unlinks a device that hasn't
connected for 30 days.

## Building with Signal

libsignal is Rust, so the Signal connector is only in a bridge host built with
`-tags libsignal` and `libsignal_ffi.a` on the linker path
(`apps/bridge-host/internal/networks/signal.go`). Any other build has a `signal` entry that
fails at start with "this bridge host was built without Signal"
(`signal_unavailable.go`). The library must be the exact version mautrix-signal's bindings
were generated against (`pkg/libsignalgo/signalversion`); libsignalgo calls
`signal_ffi_version_0_106_1` so any other version fails the link.
`internal/networks/signal_test.go` fails when mautrix-signal is updated without moving the
image's pin.

### Installs (Docker)

`deploy/docker/bridge-host.Dockerfile` builds libsignal in a Rust stage
(`rust:1.98.1-bookworm`, pinned by digest; 1.98.1 is libsignal's `rust-toolchain`) from the
pinned tag, checks the tag still points at the pinned commit, and links it with
`-tags libsignal`. It only does so with `--build-arg WITH_SIGNAL=1`, which `install.sh`
passes when `signal` is in `--networks`: the first build takes a long while (a full Rust
release build, cargo's caches kept between builds), and nobody else should pay for it.
Without it the image builds as before. It builds for the machine it runs on, amd64 or
arm64.

The library is linked statically; the binary then loads the C++ runtime (`libstdc++6`,
`libgcc-s1`) at run time, which the runtime image has.

### Dev

`pnpm dev --network signal` builds the bridge host with `-tags libsignal`, linking
`libsignal_ffi.a` from `.data/libsignal/` in the checkout, or from the directory
`LIBSIGNAL_FFI_DIR` names (one build can serve every worktree). Without the library, or with
another version, it stops before building and says which version it needs and where to put
it. Other networks build exactly as before.

To build the library without Rust installed, with Docker (from the repository root):

```sh
docker build -f deploy/docker/bridge-host.Dockerfile --target libsignal-export -o .data/libsignal .
```

Or with Rust (Debian or Ubuntu):

```sh
sudo apt install clang libclang-dev cmake protobuf-compiler libprotobuf-dev g++ zlib1g-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # if you have no rustup
git clone --depth 1 --branch v0.106.1 https://github.com/signalapp/libsignal.git ~/src/libsignal-v0.106.1
cd ~/src/libsignal-v0.106.1 && cargo build -p libsignal-ffi --release --locked
mkdir -p ~/.local/lib/libsignal && cp target/release/libsignal_ffi.a ~/.local/lib/libsignal/
export LIBSIGNAL_FFI_DIR=~/.local/lib/libsignal   # or copy it into .data/libsignal
```

rustup fetches the toolchain the checkout names. The library is about 220 MB (x86_64) and
takes several minutes on a fast machine. Linking also needs `libz.so` and the C++ runtime
(`zlib1g-dev`, `g++`). Without `zlib1g-dev`, a `libz.so` symlink to the system's
`libz.so.1` in the same directory as `libsignal_ffi.a` does the same.

By hand: `cd apps/bridge-host && LIBRARY_PATH=<dir> go build -tags libsignal -o bin/bridge-host ./cmd/bridge-host`.

CI vets the Signal code (`go vet -tags libsignal ./...`, which needs no library) but
doesn't build libsignal, so it doesn't link or run the Signal tests.

## Configuration

No operator settings and no credentials: the connector talks to Signal's public servers.
The bridge host starts from mautrix-signal's example config and changes two things:

| Setting               | Upstream default           | Here        | Why                                                                                    |
| --------------------- | -------------------------- | ----------- | -------------------------------------------------------------------------------------- |
| `device_name`         | `mautrix-signal`           | `Trioditis` | The name under **Linked devices** in Signal.                                           |
| `note_to_self_avatar` | an `mxc://maunium.net` URI | none        | The bridge host can't fetch another Matrix server's media; Note to Self has no avatar. |

Kept as upstream on purpose: `use_contact_avatars`, `use_outdated_profiles` off and a
display name of profile name, else phone number, else username, never the person's
address-book name. A contact is one ghost shared by everyone on the host, so one person's
address book must not name it for the others.

Backfill is on in the bridge host (`host.BridgeConfig`), so linking asks the phone to
**transfer message history** (the link advertises the `backup5` capability). The phone
offers it during linking; accepting brings recent history in.

Voice notes sent from Trioditis need ffmpeg (ogg to aac), which the image doesn't have, so
the connector reports them as unsupported; received voice notes come through unconverted
(AAC). Stickers as GIF need it too.

## Sending

AGENTS.md: a send is never retried after an ambiguous outcome; it is reported `unknown`
and the person decides. mautrix-signal v0.2611.0 retries on its own in two places, both
before the connector returns, so the host never gets to say `unknown`:

- **A dropped websocket.** When the connection closes with a request's response still
  outstanding, signalmeow closes that request's response channel, and
  `web.SignalWebsocket.sendRequestInternal` resubmits the same request on the next
  connection, up to three times (`pkg/signalmeow/web/signalwebsocket.go`). If Signal had
  accepted the first one, it gets it twice.
- **A 500 or 503 from Signal.** `sendContent` (one recipient, `pkg/signalmeow/sending.go`)
  and `sendToGroupWithSenderKey` (a group, `pkg/signalmeow/senderkey.go`) send again with
  the same timestamp. 409 and 410 (the recipient's device list changed: Signal refused the
  message, so sending again is right) and 428 are retried the same way.

There is no seam the bridge host can use. Every request goes through signalmeow's own
websocket client (`AuthedWS`, `UnauthedWS`). Its outgoing queue is one unexported channel
that senders write to and each new connection's write loop reads, both through the same
field, so it can't be wrapped without racing a reconnect; the response channels live in a
local map; and the client and its websockets are made and connected in one call. A hook below that
would mean reading and rewriting Signal's websocket frames under TLS. The connector's
client type (`*SignalClient`) is asserted in several places, so it can't be wrapped either.

So until mautrix-signal can be told not to resubmit (a patch upstream, or a fork), the
bridge host runs Signal **receive-only** (`networks.Network.ReceiveOnly`): it refuses
`send`, `edit`, `react`, `unreact` and `redact` with 409 `unsupported` before anything
reaches bridgev2, so nothing is submitted and the refusal is certain (a stored one is
refused when it runs and fails). `markRead` and `typing` still go out: a repeated read
receipt or typing notice changes nothing. Turning sends back on is `ReceiveOnly: false` in
`internal/networks/signal.go` and dropping `receiveOnly` from `NETWORK_INFO`, once a patched
connector is in.

For whoever decides that: a resubmission isn't shown twice by Signal's apps. The
websocket case resends the same ciphertext, which libsignal refuses to decrypt a second
time, and the 500/503 case reuses the message's timestamp, which Signal's apps use to drop
duplicates. That's Signal's behaviour, not something the bridge host can check, so it isn't
relied on here.

## Logging in

| Flow ID | Stepper kind | First step                                         | Needs Signal's servers |
| ------- | ------------ | -------------------------------------------------- | ---------------------- |
| `qr`    | `qr`         | a `displayAndWait` QR of a `sgnl://linkdevice` URI | yes, to get the QR     |

`NETWORK_INFO` (`packages/core`) lists it as `qr`, "Link a device". The QR comes from
Signal's provisioning websocket and is replaced every 45 seconds (a new `displayAndWait`
step with the same step ID), up to 20 times, then the login times out. The stepper and the
terminal login both show a refreshed QR.

To connect:

1. In Trioditis: Settings, Accounts, Signal, **Link a device**.
2. On the phone: Signal, **Settings**, **Linked devices**, **Link new device**, and scan
   the code.
3. When the phone asks, choose **Transfer message history** for recent history (or skip it
   for new messages only). The phone uploads an encrypted archive; the bridge waits up to an
   hour for it, then carries on without history.
4. The device appears as **Trioditis** in the phone's list.

Errors map to a code in the app; the connector's own reasons: the account already has the
maximum number of linked devices (remove one), the code was already used or expired (start
again), rate limited (wait a few minutes), or a capability the account's other devices need
(try later).

Logging out in Trioditis unlinks the device on Signal's side and deletes the account's
signalmeow store (every `signalmeow_*` row of that account goes with it).

From the terminal:

```sh
cd apps/bridge-host
LIBRARY_PATH=<dir> go build -tags libsignal -o bin/bridge-host ./cmd/bridge-host
./bin/bridge-host --network signal --dev-keys --data /tmp/signal-try --user isaac login
```

## What's stored in plaintext

mautrix-signal keeps its store (signalmeow) in the bridge host's database, beside
bridgev2's tables, all under the encrypted-disk rule of docs/architecture/sealing.md
(What else is stored in plaintext). Per table:

| Table                                                                                            | Holds                                                                                                       | Bounded by                                                                   |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `signalmeow_event_buffer`                                                                        | each incoming message's **decrypted protobuf, content included** (`plaintext`), keyed by a ciphertext hash  | cleared on success; the host deletes any row 35 days old (below)             |
| `signalmeow_backup_message`                                                                      | the **history transfer's messages, content included** (`data`, protobuf)                                    | deleted chat by chat as each is backfilled (the connector)                   |
| `signalmeow_backup_chat`                                                                         | the transfer's chats (`data`)                                                                               | deleted as each chat is backfilled, or at once if it has no messages         |
| `signalmeow_backup_recipient`                                                                    | the transfer's recipients: **contact names**, phone numbers, **group titles** and members (`data`)          | the host deletes them once the account has no archived chat left (below)     |
| `signalmeow_recipients`                                                                          | every contact: **address-book name**, **nickname**, **profile name**, about text, phone number, profile key | none: the connector needs them to name and reach contacts. Deleted at logout |
| `signalmeow_device`                                                                              | the account's keys, phone number, account record (own profile and settings)                                 | the login's lifetime                                                         |
| sessions, prekeys, identity, sender keys, profile keys, groups (master keys), unregistered users | cryptographic state and identifiers, no content or names                                                    | the login's lifetime                                                         |

bridgev2's own tables hold what they hold for every network: chat names and topics
(`portal`; a DM's topic has the contact's phone number, `number_in_topic`), contact names
(`ghost`) and the login's phone number (`user_login.remote_name`). mautrix-signal's
bridgev2 metadata holds no content: message metadata is the server GUID, a reporting token,
flags and poll vote counts; portal and ghost metadata are revisions, timestamps and the
Signal username.

**Decrypted-event buffer.** signalmeow writes the plaintext in the decrypting transaction
and clears it when the handler returns success, normally once the message is journaled
sealed (moments). It stays only when handling failed or the process stopped in between (the
message isn't acknowledged, so Signal redelivers it and the buffered copy is bridged and
cleared then: a Signal message can be decrypted only once) or when clearing failed with a
database error (signalmeow still acknowledges the message, so nothing clears it).
signalmeow's own cleanup deletes only rows already cleared, so such a row would keep its
plaintext indefinitely. The bridge host deletes every row older than 35 days, plaintext and
all (`internal/signalsweep`, `MaxAge`): Signal's server keeps an undelivered message 30 days
(Signal-Server's message table expiry), so no redelivery can need it later; 5 days' margin
covers the expiry running late. It sweeps at start-up and hourly, stops before the host on
shutdown, and a failed sweep leaves the rows for the next. bridgev2's 5-minute handler limit
has the same effect as for WhatsApp (sealing.md): past it the message is acknowledged and
its plaintext cleared while handling carries on, and a crash then loses it.

**History transfer.** The phone's archive is downloaded to a temporary file (encrypted;
removed once read), and read in one transaction into the `signalmeow_backup_*` tables. The
connector deletes each chat's messages as they are backfilled and the chat once its
backfill is done, as WhatsApp's history-sync table does; deleting them sooner would lose
that history. It never deletes the recipients, so the bridge host deletes an account's
archived recipients once it has no archived chat left; backfill reads senders, quote and
reaction authors from them until then. History for a chat that is never backfilled stays.

**Logs.** At the default level the connector logs identifiers (service IDs, timestamps), not
content, with two exceptions, both at info: the history transfer's `BackupInfo`, which holds
the account's `mediaRootBackupKey` (`backup.go`, "Received backup info"), and a contact-sync
entry with no Signal ID, with the contact's name and phone number (`receiving.go`, "Signal
Contact UUID is nil, skipping"). Signal's bridge host writes its whole log through a filter
(`internal/networks/signallog.go`) that drops those fields (`backup_info`, `contact`) from
every line, along with the trace-only fields signalmeow 26.11 logs content, keys or
credentials in (`raw_content`, `backup_frame`, `msg`, `contact_record`, `account_record`,
`item_data`, `response_data`, `invalid_response_data`, `creds`; the bridge host never logs at
trace, so these are a precaution), and lists what it dropped in `dropped_fields`; the line itself stays. A line that isn't valid JSON is replaced.
`--verbose` adds error responses' bodies from Signal's servers, which hold no message
content.

## Known limits

- **Receive-only** until mautrix-signal stops resubmitting after an ambiguous outcome; see
  Sending.
- **Building takes Rust.** See Building with Signal. The image's Rust stage has been built
  on x86_64 (about 5 minutes for libsignal on 24 cores; the image is about 50 MB bigger),
  and the image reached Signal's QR step; arm64 hasn't been built yet.
- **Linked-device limits.** Signal allows a few linked devices per account; the bridge is
  one. Signal unlinks a device that hasn't connected for 30 days; it then needs linking again.
- **History** is what the phone transfers at linking, once; there is no later backfill
  from Signal's servers (they keep no history).
- **No threads, no edit after 24 hours, no polls closing** (Signal's own limits, from the
  connector's capabilities). Delete for everyone within 24 hours.
- **Voice notes out** need ffmpeg; see Configuration.

## How to test

With Isaac's account, on a host built with Signal (`pnpm dev --network signal` once
`libsignal_ffi.a` is in place, or an install with `--networks signal`):

- [ ] **Connect:** Link a device, scan with the phone, accept the history transfer. The
      account appears connected; the phone lists **Trioditis** under Linked devices.
- [ ] **Backfill:** recent chats appear with their history, DMs and groups, with names and
      avatars; Note to Self is there with no avatar.
- [ ] **Receive:** a message from another phone arrives in a DM and in a group.
- [ ] **Sending is refused:** a send, edit, reaction or delete fails at once with
      `unsupported`, and nothing appears on the phone.
- [ ] **Their edits, reactions and deletes** arrive.
- [ ] **Media:** an image, a video, a file and a voice note arrive.
- [ ] **Read state:** reading a chat in Trioditis marks it read on the phone.
- [ ] **Own messages:** one sent from the phone appears as yours.
- [ ] **Reconnect after restart:** stop the bridge host, send it a message meanwhile, start
      it: the message arrives once.
- [ ] **Log out:** in Trioditis; the device disappears from the phone's Linked devices.
