---
title: iMessage
description: Implementation status, the BlueBubbles Server sign-in, what needs the Private API, known limits, and plaintext notes for iMessage.
---

iMessage needs a Mac. Apple offers no API for it, so each person's own Mac, signed in to Messages, does the sending and receiving, and **[BlueBubbles Server](https://bluebubbles.app)** running on that Mac gives the bridge host a REST API and a socket to reach it. The connector is the bridge host's own (`apps/bridge-host/internal/imessage`), written on `bridgev2`: no `mautrix` connector speaks BlueBubbles on `bridgev2` (`mautrix-imessage` is still on the legacy framework).

| Property           | Value                                                                  |
| ------------------ | ---------------------------------------------------------------------- |
| **Network ID**     | `imessage`                                                             |
| **Maturity**       | **Experimental**                                                       |
| **Terms risk**     | No (it drives the Messages app on the person's own Mac)                |
| **Operator setup** | None on the server. Each person needs a Mac running BlueBubbles Server |
| **New chats from** | A contact, a phone number with its country code, or an email address   |

## Implementation status

- **Implemented:** BlueBubbles Server sign-in (address and password), the socket for live events, catch-up of chats that changed while the bridge host was away, recent and older history, text and files both ways, replies, tapbacks, edits, unsending, typing, read receipts, group names, members and pictures, and contact names and pictures from the Mac's Contacts. Sends are made once (`TestSendOutcomes`, `TestIMessageThroughTheHost`), and only a refusal the Mac reports before acting counts as failed; anything else is `unknown`.
- **Remaining:** Live end-to-end verification with a real Mac.

## How to connect

1. On a Mac that stays on and is signed in to Messages, install [BlueBubbles Server](https://bluebubbles.app/downloads/server/) and set a password in its settings.
2. Make the Mac reachable from your Trioditis server:
   - **On the same network:** the Mac's address, such as `http://192.168.1.20:1234`.
   - **Over Tailscale:** the Mac's tailnet address or name.
   - **From anywhere:** BlueBubbles' own Cloudflare or ngrok proxy (Settings → Proxy Service), which gives an `https://` address.
3. In Trioditis, open **Settings → Accounts → iMessage → BlueBubbles Server** and enter the server address and password BlueBubbles shows.

Prefer an `https://` address when the Mac isn't on your own network: BlueBubbles takes its password in each request's address, so plain `http://` sends it readable to anyone on the path.

The bridge host refuses an address that would reach itself or the machine it runs on rather than a Mac: loopback, link-local (where cloud metadata services answer), the clouds' other metadata addresses, and, in the Docker bundle, the containers' own networks. Private and Tailscale addresses are allowed.

### The Private API

Without it, BlueBubbles drives Messages with AppleScript, which can send text and files and nothing more. With BlueBubbles' [Private API](https://docs.bluebubbles.app/private-api/installation) on and its helper running, the Mac can also send replies, captions with files, tapbacks, edits and unsends, typing, and read receipts. The Private API needs System Integrity Protection turned off on the Mac, which is a real loss of protection for a Mac used day to day; a Mac kept only for this is the usual choice.

The connector asks the Mac whether the helper is running when it connects and every five minutes after, and offers each chat only what the Mac can do then. Without the helper:

- **Refused** (`unsupported`, nothing sent): replies, a file with a caption (send the file and the text separately), tapbacks, edits, and unsending.
- **Skipped:** typing and read receipts.

## Unsupported & known limits

- **The Mac must stay on and reachable.** While it isn't, sends fail (`not_connected` if the bridge host can't reach it at all) and the account shows as disconnected. When it's back, the bridge host catches up on every chat whose last message is newer than the time it last synced, minus five minutes.
- **What changed while away, beyond new messages:** catching up brings in new messages and tapbacks; an edit, unsend or read receipt on an older message made while the bridge host was away isn't brought in.
- **iMessage and SMS with the same person are one chat**, as on an iPhone. Chats are keyed by their `any;` GUID (macOS 26 moved every chat to it, and BlueBubbles finds a chat by it on older systems too), and a send goes to whichever chat Messages has.
- **Starting a chat** happens on its first message, which must be text. A file can't start one.
- **Tapbacks:** the six classic ones go both ways. Any other emoji tapback comes in when Messages' text for it ("Reacted 🎉 to …") is in English, and can't be sent (BlueBubbles can't send one). Stickers on messages aren't brought in.
- **Edits** are allowed for 15 minutes, five times; **unsending** for 2 minutes (macOS 13 or newer). An edit or unsend the Mac doesn't confirm within 30 seconds is reported uncertain, since it may still go.
- **A failure Messages reports after sending:** with AppleScript, BlueBubbles answers as soon as Messages has the message, before it has gone; a failure after that is marked in Messages on the Mac but the message stays sent in Trioditis.
- **Emoji-only texts sent without the Private API:** BlueBubbles matches what it sent by the text's letters and digits, so two such texts sent within ten seconds of each other in one chat can be confused, and one may be reported with the other's ID.
- **Messages only an Apple device can show** (games, Apple Cash, app balloons) come in as a note saying so.
- **Files** up to 100 MiB both ways. Pictures Messages keeps as HEIC come in as JPEG, and voice messages as MP3.

## What's stored in plaintext

Beyond `bridgev2`'s shared tables:

- **`user_login.metadata`:** the BlueBubbles Server address and password, and the time the login last synced up to (cleared on logout).
- **`user_login.remote_name`:** the Apple ID Messages is signed in with, when BlueBubbles reports it.
- **`message.metadata`:** only the time a message was last edited. No message text is kept by the connector.
- **IDs:** a direct chat's ID and each person's ID are their phone number or email address, as for WhatsApp's phone numbers. People are kept per login (`<login>|<address>`), so a name or picture from one person's Contacts never shows to another member with a chat with the same address.
