---
title: Backups, Restore & Keys
description: Create encrypted backups, restore a server cleanly, manage exported server keys, and protect connector data at rest.
---

## Encrypted backups

`deploy/trioditis backup` creates an atomic, **encrypted** snapshot while the server is briefly stopped:

```sh
deploy/trioditis backup ~/trioditis-backups
```

The destination must live **outside** your git checkout (container image builds copy the checkout).

Each backup creates a `0700` directory named `<project>-<date>-<time>` (appending `-2`, `-3`, … rather than overwriting) containing three `0600` files:

- **`archive.enc`** — Encrypted, uncompressed tar archive of every Docker volume belonging to this Compose project (including volumes for previously disabled networks), ending with a manifest of entry counts, byte sizes, version, and PostgreSQL major version.
- **`secrets.env.enc`** — Encrypted installer settings from `deploy/install/env-names`, **excluding** the server's private keys and `BACKUP_KEY`.
- **`backup.info`** — Unencrypted metadata (format version, project name, git commit, timestamp) needed before restore starts. Format 3 archives are uncompressed (the volumes are mostly sealed content and media, which gzip barely shrinks); restore still reads the gzip archives of format 2 and older.

### Encryption & safety guarantees

- **Streamed AES-256-GCM encryption:** `deploy/scripts/backup-crypt.mjs` (running offline in the bundle's Node image) encrypts volumes and settings directly into 64 KiB authenticated chunks under per-file keys derived from `BACKUP_KEY`. Plaintext archives and secrets never touch the destination disk—staging happens in memory (`/dev/shm` or user runtime dir).
- **Atomic publish:** Files stage privately and rename into place only after a second parser verifies `secrets.env` matches the allowlist and confirms no private key or `BACKUP_KEY` appears inside. An interrupted backup (`Ctrl-C`) leaves nothing behind.
- **Exact service restart:** Only containers that were running beforehand are restarted (in dependency order, waiting up to two minutes per health check).

## Restoring a backup

```sh
deploy/trioditis restore ~/trioditis-backups/trioditis-20261120-040000
```

Pass `--yes` to skip the interactive confirmation prompt. Before stopping anything, `restore` verifies that:

1. The backup decrypts cleanly with this install's `BACKUP_KEY`.
2. It matches this install's Compose project name and server public keys (`BRIDGE_PUBLIC_KEY` and `AGENT_ACCESS_PUBLIC_KEY`).
3. Your git checkout is at the commit recorded in `backup.info` (whose schema matches the backup's data).

Restoring onto a **brand-new server** (where `deploy/.env` does not exist yet):

1. Clone the repository and check out the exact commit listed in `backup.info`.
2. Restore with `--keys`, passing your previously exported key file—this imports the keys, restores all volumes and settings, and reruns the installer in one step:

```sh
deploy/trioditis restore --keys ~/trioditis-server-keys.env <backup-dir>
```

## Managing the server's keys

A Trioditis server keeps three critical keys in `deploy/.env`:

- **`BRIDGE_PRIVATE_KEY`** — Unseals outbound messages, scheduled sends waiting for their send time, and encrypted login input.
- **`AGENT_ACCESS_PRIVATE_KEY`** — Unseals chats explicitly granted to AI agents over MCP.
- **`BACKUP_KEY`** — Encrypts and decrypts `archive.enc` and `secrets.env.enc` in backups.

Backups **never** contain any of these three keys, and no Docker volume stores them.

### Exporting and importing keys

Export all server keys once after installation (and again if upgrading from an older install before `BACKUP_KEY` existed), store the file **separate from your backups** (password manager or offline media), and delete the copy on the server:

```sh
deploy/trioditis keys export ~/trioditis-server-keys.env
```

`keys export` writes a new `0600` file, refuses to overwrite an existing file or write inside the checkout, and never prints key material.

To restore keys onto a replacement server:

```sh
deploy/trioditis keys import ~/trioditis-server-keys.env
```

`keys import` derives public keys offline in the bundle's Node container and refuses malformed or mismatched key pairs.

### If the server keys are lost

- **Lost `BACKUP_KEY`:** Encrypted backups created with that key cannot be decrypted.
- **Lost bridge or agent-access keys:** Regenerate missing private halves with:

  ```sh
  deploy/install/install.sh --new-server-keys
  ```

  This is the **only** way the installer replaces a server key. In-flight or scheduled sends sealed to the old bridge key fail cleanly (`invalid_command`) so members can resend them, and chats granted to agents must be re-granted. Stored message history sealed to each member's own identity key is **completely unaffected**.

## Encryption at rest

While Trioditis seals stored messages, attachments, chat names, and contact profiles in Convex to each member's identity key, upstream `bridgev2` connectors keep operational state in PostgreSQL—some of which is plaintext (chat names, contact names, phone numbers, and pending history-sync batches).

Always **run Trioditis on an encrypted disk** (LUKS/dm-crypt, encrypted ZFS, or encrypted VM host storage). Backups are already encrypted with `BACKUP_KEY` by `deploy/trioditis backup`. The installer checks Docker's block device for dm-crypt and prints a reminder if it cannot confirm encryption (note that host-level VM encryption or ZFS native encryption cannot be detected from inside a guest).
