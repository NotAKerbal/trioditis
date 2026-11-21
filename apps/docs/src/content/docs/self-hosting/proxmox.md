---
title: Proxmox VE
description: Provision an Ubuntu 24.04 VM or unprivileged LXC container and install Trioditis on Proxmox VE with one command.
---

Trioditis includes a Proxmox VE helper script (`deploy/install/proxmox.sh`) that creates a dedicated Ubuntu 24.04 guest and installs the Docker Compose stack inside it.

## Usage

Run the script as `root` on your Proxmox VE host:

```sh
# Default: Ubuntu 24.04 VM (ID 9100, 2 vCPUs, 8 GiB RAM, 64 GiB disk)
bash deploy/install/proxmox.sh

# Customize storage pool and network bridge
bash deploy/install/proxmox.sh --storage local-zfs --bridge vmbr1

# Optional: Unprivileged LXC container with nesting enabled
bash deploy/install/proxmox.sh --lxc --id 9101
```

## VM vs. LXC

**A VM is the default and strongly recommended choice:**

- Docker inside an LXC container depends on the Proxmox host's kernel and storage driver behavior.
- Giving a VM encrypted storage (either encrypted Proxmox storage or full-disk encryption inside the guest) is simpler and cleaner. See [Encryption at rest](/self-hosting/backup-and-keys/#encryption-at-rest).

## Prerequisites on Proxmox

- The storage pool passed to `--snippets` (default `local`) must have the **`snippets`** content type enabled so cloud-init can install the QEMU guest agent on first boot:

  ```sh
  pvesm set local --content iso,vztmpl,backup,snippets
  ```

- The script verifies the downloaded Ubuntu cloud image against Ubuntu's published SHA-256 checksum before creating the guest.
- If any step fails after the VM is created, the script prints the exact commands to inspect or remove it.

:::note[HTTPS after provisioning]
Once the guest finishes installing, configure HTTPS (with `--domain` or `--public-url` behind Tailscale Serve) before signing up from another device. See [Installation & Modes](/self-hosting/installation/).
:::
