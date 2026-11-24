---
title: iMessage
description: Implementation status, the BlueBubbles Server sign-in, what needs the Private API, known limits, and plaintext notes for iMessage.
---

iMessage needs a Mac. Apple offers no API for it, so each person's own Mac, signed in to Messages, does the sending and receiving, and **[BlueBubbles Server](https://bluebubbles.app)** running on that Mac gives the bridge host a REST API and a socket to reach it. The connector is the bridge host's own (`apps/bridge-host/internal/imessage`), written on `bridgev2`: no `mautrix` connector speaks BlueBubbles on `bridgev2` (`mautrix-imessage` is still on the legacy framework).

| Property           | Value                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Network ID**     | `imessage`                                                                                                           |
| **Maturity**       | **Experimental**                                                                                                     |
| **Terms risk**     | No (it drives the Messages app on the person's own Mac)                                                              |
| **Operator setup** | For Macs on a home network or tailnet, list those ranges (below). Each person needs a Mac running BlueBubbles Server |
| **New chats from** | A contact, a phone number with its country code, or an email address                                                 |

## Implementation status

- **Implemented:** BlueBubbles Server sign-in (address and password), the socket for live events, catch-up of every message sent while the bridge host was away, recent and older history, receiving text and files, and, with the Private API, sending text and files, replies, tapbacks, edits, unsending, typing and read receipts. Group names, members and pictures, and contact names and pictures from the Mac's Contacts. Sends are made once (`TestSendOutcomes`, `TestIMessageThroughTheHost`), and only a refusal BlueBubbles itself reports before acting, or a message Messages marked failed, counts as failed; anything else is `unknown`.
- **Remaining:** Live end-to-end verification with a real Mac.

## How to connect

1. On a Mac that stays on and is signed in to Messages, install [BlueBubbles Server](https://bluebubbles.app/downloads/server/) and set a password in its settings.
2. To send, turn on BlueBubbles' [Private API](#the-private-api). Without it, iMessage only receives.
3. Make the Mac reachable from your Trioditis server:
   - **From anywhere:** BlueBubbles' own Cloudflare or ngrok proxy (Settings → Proxy Service), which gives an `https://` address. This works with no setup on the server.
   - **On the same network, or over Tailscale:** the Mac's address, such as `http://192.168.1.20:1234` or its tailnet address, once the server's admin allows that range (below).
4. In Trioditis, open **Settings → Accounts → iMessage → BlueBubbles Server** and enter the server address and password BlueBubbles shows.

Prefer an `https://` address when the Mac isn't on your own network: BlueBubbles takes its password in each request's address, so plain `http://` sends it readable to anyone on the path.

### Where a Mac may be (operators)

A member types the server address, and the bridge host connects to it from inside your server, so by default it only connects to the public internet. To let members use Macs on a home network or a tailnet, list those ranges in `deploy/.env` and run the installer again:

```sh
IMESSAGE_MAC_NETWORKS=192.168.1.0/24,100.64.0.0/10
```

List only the ranges Macs are on: an address there can be anything on that network, your server's own other services included. Whatever is listed, the bridge host never connects to loopback, link-local addresses (where cloud metadata services answer), the clouds' other metadata addresses, the ranges in `BRIDGE_EGRESS_DENY`, or the Docker bundle's own networks.

### The Private API

Sending needs BlueBubbles' [Private API](https://docs.bluebubbles.app/private-api/installation), on and with its helper running. BlueBubbles' other way to send, scripting the Messages app, runs the script again when it times out and then tries a second script, so one send can go twice; its Private API asks Messages once. Trioditis never retries a send whose outcome isn't known, so without the Private API it doesn't send at all.

The Private API needs System Integrity Protection turned off on the Mac. That is a real loss of protection for a Mac used day to day, so a Mac kept only for this is the usual choice.

The connector asks the Mac whether the helper is running when it connects, every five minutes after, and before refusing anything. Without the helper, a login only receives:

- **Refused** (`unsupported`, nothing sent): every message, file, reply, tapback, edit and unsend.
- **Skipped:** typing and read receipts.

The app offers sending, tapbacks, editing and deleting on iMessage as the Private API allows. It doesn't yet know whether a particular Mac has the Private API, so on a receive-only Mac those actions fail as `unsupported`.

## Unsupported & known limits

- **The Mac must stay on and reachable.** While it isn't, sends fail (`not_connected` if the bridge host can't reach it at all) and the account shows as disconnected. When it's back, the bridge host first brings in every message created since the time it last synced, minus five minutes, in every chat, oldest first, up to 20,000; only then does it hand over what arrived live meanwhile.
- **What changed while away, beyond new messages:** catching up brings in new messages and tapbacks; an edit, unsend or read receipt on an older message made while the bridge host was away isn't brought in.
- **iMessage and SMS with the same person are one chat**, as on an iPhone. Chats are keyed by their `any;` GUID (macOS 26 moved every chat to it, and BlueBubbles finds a chat by it on older systems too), and a send goes to whichever chat Messages has.
- **Starting a chat** happens on its first message, which must be text. A file can't start one.
- **Tapbacks:** the six classic ones go both ways. Any other emoji tapback comes in when Messages' text for it ("Reacted 🎉 to …") is in English, and can't be sent (BlueBubbles can't send one). Stickers on messages aren't brought in.
- **Edits** are allowed for 15 minutes, five times; **unsending** for 2 minutes (macOS 13 or newer). An edit or unsend the Mac doesn't confirm within 30 seconds is reported uncertain, since it may still go.
- **A failure Messages reports later:** a message Messages marks failed after BlueBubbles has answered is marked in Messages on the Mac, but stays sent in Trioditis.
- **Messages only an Apple device can show** (games, Apple Cash, app balloons) come in as a note saying so.
- **Files** up to 100 MiB both ways. Pictures Messages keeps as HEIC come in as JPEG, and voice messages as MP3.

## What's stored in plaintext

Beyond `bridgev2`'s shared tables:

- **`user_login.metadata`:** the BlueBubbles Server address and password, and the time the login last synced up to (cleared on logout).
- **Login IDs** are a hash of the member and the Mac's computer ID (BlueBubbles makes it of the Mac's user and host names).
- **`user_login.remote_name`:** the Apple ID Messages is signed in with, when BlueBubbles reports it.
- **`message.metadata`:** only the time a message was last edited. No message text is kept by the connector.
- **IDs:** a direct chat's ID and each person's ID are their phone number or email address, as for WhatsApp's phone numbers. People are kept per login (`<login>|<address>`), so a name or picture from one person's Contacts never shows to another member with a chat with the same address.
