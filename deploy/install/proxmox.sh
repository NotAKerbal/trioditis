#!/usr/bin/env bash
# Creates a Trioditis server on a Proxmox VE host: a VM (the default) or an LXC container,
# running Ubuntu 24.04, with Docker and Trioditis installed by deploy/install/install.sh.
# Run it as root on the Proxmox host:
#
#   bash proxmox.sh                       # VM 9100, 2 cores, 8 GiB, 64 GiB disk
#   bash proxmox.sh --lxc --id 9101       # an unprivileged LXC with nesting, instead
#   bash proxmox.sh --storage local-zfs --bridge vmbr1 --networks whatsapp,fake
#
# A VM is the default because Docker inside an LXC depends on the host's kernel and storage
# driver, and an encrypted disk is simpler to give a VM. See docs/deploy.md, Proxmox.
#
# Not exercised in CI: it needs a Proxmox host. Report problems with its output.
set -euo pipefail

kind=vm
id=9100
name=trioditis
cores=2
memory=8192
disk=64
storage=local-lvm
bridge=vmbr0
networks=whatsapp
repo=https://github.com/NotAKerbal/trioditis.git
ref=dev
ssh_key=${SSH_KEY:-$HOME/.ssh/id_ed25519.pub}

while [ $# -gt 0 ]; do
  case "$1" in
    --lxc) kind=lxc ;;
    --vm) kind=vm ;;
    --id) id=$2; shift ;;
    --name) name=$2; shift ;;
    --cores) cores=$2; shift ;;
    --memory) memory=$2; shift ;;
    --disk) disk=$2; shift ;;
    --storage) storage=$2; shift ;;
    --bridge) bridge=$2; shift ;;
    --networks) networks=$2; shift ;;
    --repo) repo=$2; shift ;;
    --ref) ref=$2; shift ;;
    --ssh-key) ssh_key=$2; shift ;;
    -h | --help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v pvesh >/dev/null || die "Run this on a Proxmox VE host (pvesh not found)."
[ "$(id -u)" = 0 ] || die "Run this as root."
if qm status "$id" >/dev/null 2>&1 || pct status "$id" >/dev/null 2>&1; then
  die "ID $id is already in use. Pass --id."
fi

# What runs inside the guest once it's up: Docker, then Trioditis from the chosen ref.
guest_setup_script() {
  cat <<EOF
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q docker.io docker-compose-v2 docker-buildx git ca-certificates
systemctl enable --now docker
git clone --branch '$ref' '$repo' /opt/trioditis
cd /opt/trioditis
deploy/install/install.sh --local --port 8080 --networks '$networks'
EOF
}
guest_setup=$(guest_setup_script)

if [ "$kind" = vm ]; then
  image=/var/lib/vz/template/iso/noble-server-cloudimg-amd64.img
  if [ ! -f "$image" ]; then
    say "Downloading the Ubuntu 24.04 cloud image"
    wget -q -O "$image" https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
  fi
  [ -f "$ssh_key" ] || die "No SSH public key at $ssh_key. Pass --ssh-key."

  say "Creating VM $id ($name)"
  qm create "$id" --name "$name" --cores "$cores" --memory "$memory" --cpu host \
    --net0 "virtio,bridge=$bridge" --scsihw virtio-scsi-pci --agent enabled=1 \
    --serial0 socket --vga serial0 --ostype l26
  qm set "$id" --scsi0 "$storage:0,import-from=$image,discard=on"
  qm resize "$id" scsi0 "${disk}G"
  qm set "$id" --ide2 "$storage:cloudinit" --boot order=scsi0 \
    --ipconfig0 ip=dhcp --ciuser trioditis --sshkeys "$ssh_key"
  qm start "$id"

  say "Waiting for the guest agent"
  for _ in $(seq 120); do qm agent "$id" ping >/dev/null 2>&1 && break; sleep 5; done
  qm agent "$id" ping >/dev/null 2>&1 || die "The VM's guest agent didn't come up. Check its console."

  say "Installing Docker and Trioditis in the VM (this takes several minutes)"
  qm guest exec "$id" --timeout 3600 -- bash -c "$guest_setup"
  address=$(qm guest cmd "$id" network-get-interfaces | grep -oE '"ip-address" *: *"[0-9.]+"' | grep -v 127.0.0.1 | head -1 | grep -oE '[0-9.]+$')
else
  template=$(pveam list local 2>/dev/null | awk '/ubuntu-24.04-standard/ {print $1}' | tail -1)
  if [ -z "$template" ]; then
    say "Downloading the Ubuntu 24.04 LXC template"
    pveam update >/dev/null
    template_name=$(pveam available --section system | awk '/ubuntu-24.04-standard/ {print $2}' | tail -1)
    pveam download local "$template_name"
    template="local:vztmpl/$template_name"
  fi

  say "Creating LXC $id ($name)"
  pct create "$id" "$template" --hostname "$name" --cores "$cores" --memory "$memory" \
    --rootfs "$storage:$disk" --net0 "name=eth0,bridge=$bridge,ip=dhcp" \
    --unprivileged 1 --features nesting=1,keyctl=1 --onboot 1
  pct start "$id"
  sleep 10

  say "Installing Docker and Trioditis in the container (this takes several minutes)"
  pct exec "$id" -- bash -c "$guest_setup"
  address=$(pct exec "$id" -- hostname -I | awk '{print $1}')
fi

say "Done. Trioditis is at http://${address:-GUEST-ADDRESS}:8080"
echo "The admin setup link is in the install output above; it's also rebuilt by running"
echo "deploy/install/install.sh again inside the guest (/opt/trioditis)."
