#!/usr/bin/env bash
# Creates a Trioditis server on a Proxmox VE host: a VM (the default) or an LXC container,
# running Ubuntu 24.04, with Docker and Trioditis installed by deploy/install/install.sh.
# Run it as root on the Proxmox host:
#
#   bash proxmox.sh                       # VM 9100, 2 cores, 8 GiB, 64 GiB disk
#   bash proxmox.sh --lxc --id 9101       # an unprivileged LXC with nesting, instead
#   bash proxmox.sh --storage local-zfs --bridge vmbr1 --networks whatsapp,fake
#
# A VM's cloud-init setup goes in a snippet on --snippets storage (default local), which
# must allow the snippets content type.
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
snippets=local
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
    --snippets) snippets=$2; shift ;;
    --bridge) bridge=$2; shift ;;
    --networks) networks=$2; shift ;;
    --repo) repo=$2; shift ;;
    --ref) ref=$2; shift ;;
    --ssh-key) ssh_key=$2; shift ;;
    -h | --help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# What runs inside the guest once it's up: Docker, then Trioditis from the chosen ref. In a
# VM, cloud-init may still be installing packages and holding apt's lock, so it waits first.
guest_setup_script() {
  cat <<EOF
set -eu
export DEBIAN_FRONTEND=noninteractive
if command -v cloud-init >/dev/null; then cloud-init status --wait >/dev/null || true; fi
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
  [ -f "$ssh_key" ] || die "No SSH public key at $ssh_key. Pass --ssh-key."
  # The script drives the VM through the QEMU guest agent, which the cloud image doesn't
  # include. Cloud-init installs and starts it from vendor data in a snippet, which leaves the
  # user and SSH key that Proxmox generates in place.
  pvesm status --content snippets 2>/dev/null | awk 'NR > 1 {print $1}' | grep -qx "$snippets" ||
    die "Storage '$snippets' can't hold snippets, which the VM's cloud-init setup needs. Add snippets to its content types (pvesm set $snippets --content <its current types>,snippets) or pass --snippets <storage>."

  image_url=https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
  image=/var/lib/vz/template/iso/noble-server-cloudimg-amd64.img
  # Checked against Ubuntu's published checksum, fetched over HTTPS. A download goes to a
  # temporary name of its own first, so neither an interrupted one nor one running at the
  # same time is ever taken for the image.
  expected=$(wget -qO- "${image_url%/*}/SHA256SUMS" | awk -v f="${image_url##*/}" '$2 == f || $2 == "*" f {print $1}')
  [ -n "$expected" ] || die "Couldn't get the cloud image's checksum from ${image_url%/*}/SHA256SUMS."
  if [ ! -f "$image" ] || [ "$(sha256sum "$image" | awk '{print $1}')" != "$expected" ]; then
    say "Downloading the Ubuntu 24.04 cloud image"
    part=$(mktemp "$image.XXXXXX.part")
    trap 'rm -f "$part"' EXIT
    wget -q -O "$part" "$image_url"
    if [ "$(sha256sum "$part" | awk '{print $1}')" != "$expected" ]; then
      die "The downloaded cloud image doesn't match its checksum. Try again."
    fi
    chmod 644 "$part"
    mv "$part" "$image"
    trap - EXIT
  fi

  # Named for this run, so two runs racing for one ID never share (or remove) each other's.
  vendor_file="trioditis-$id-$(date +%s)-$$.yaml"
  vendor_path=$(pvesm path "$snippets:snippets/$vendor_file")
  mkdir -p "$(dirname "$vendor_path")"
  printf '%s\n' '#cloud-config' 'packages: [qemu-guest-agent]' 'runcmd:' \
    '  - [systemctl, enable, --now, qemu-guest-agent]' >"$vendor_path"

  # On a failure before this run has created the VM, its snippet goes and nothing else is
  # touched (the ID may be another run's). After, the VM and its snippet stay to look into.
  created=0
  left_behind() {
    [ "$1" = 0 ] && return
    if [ "$created" = 1 ]; then
      echo "VM $id ($name) is left as it is, to look into: qm terminal $id (Ctrl-O leaves)." >&2
      echo "Remove it with: qm stop $id; qm destroy $id --purge; rm $vendor_path" >&2
    else
      rm -f "$vendor_path"
    fi
  }
  trap 'left_behind $?' EXIT

  say "Creating VM $id ($name)"
  qm create "$id" --name "$name" --cores "$cores" --memory "$memory" --cpu host \
    --net0 "virtio,bridge=$bridge" --scsihw virtio-scsi-pci --agent enabled=1 \
    --serial0 socket --vga serial0 --ostype l26
  created=1
  qm set "$id" --scsi0 "$storage:0,import-from=$image,discard=on"
  qm resize "$id" scsi0 "${disk}G"
  qm set "$id" --ide2 "$storage:cloudinit" --boot order=scsi0 \
    --ipconfig0 ip=dhcp --ciuser trioditis --sshkeys "$ssh_key" \
    --cicustom "vendor=$snippets:snippets/$vendor_file"
  qm start "$id"

  say "Waiting for the guest agent (cloud-init installs it on first boot)"
  for _ in $(seq 120); do qm agent "$id" ping >/dev/null 2>&1 && break; sleep 5; done
  qm agent "$id" ping >/dev/null 2>&1 ||
    die "The VM's guest agent didn't come up in 10 minutes. Check cloud-init on its console: it needs network access to install qemu-guest-agent."

  say "Installing Docker and Trioditis in the VM (this takes several minutes)"
  # qm guest exec reports the command's result as JSON and exits 0 whatever it was, so this
  # prints the command's output and exits with its status (124 if it was still running).
  result=$(qm guest exec "$id" --timeout 3600 -- bash -c "$guest_setup")
  setup_status=0
  printf '%s' "$result" | perl -MJSON::PP -e '
    my $r = decode_json(do { local $/; <STDIN> });
    print $r->{"out-data"} // "";
    print STDERR $r->{"err-data"} // "";
    exit($r->{exited} ? ($r->{exitcode} // 1) : 124);
  ' || setup_status=$?
  [ "$setup_status" = 0 ] || die "Installing in the VM failed (exit status $setup_status; 124 means it was still running after an hour)."
  address=$(qm guest cmd "$id" network-get-interfaces | grep -oE '"ip-address" *: *"[0-9.]+"' | grep -v 127.0.0.1 | head -1 | grep -oE '[0-9.]+$')
  trap - EXIT
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
echo "The admin setup link is in the install output above. Until the admin account exists,"
echo "running deploy/install/install.sh again inside the guest (/opt/trioditis) prints it too."
echo "Serve it over HTTPS before signing up from another device: see docs/deploy.md."
