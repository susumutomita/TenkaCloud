#!/usr/bin/env bash
# Code preparation is safe elsewhere; EXECUTION is exclusive to the approved disposable VM.
# Official install reference: https://docs.docker.com/engine/install/ubuntu/
set -euo pipefail

if [[ ${TENKACLOUD_VPN_ACCEPTANCE:-} != github-ephemeral-v1 ||
      ${GITHUB_ACTIONS:-} != true || ${GITHUB_EVENT_NAME:-} != workflow_dispatch ||
      ${RUNNER_ENVIRONMENT:-} != github-hosted || ${RUNNER_OS:-} != Linux ||
      ${ImageOS:-} != ubuntu24 || $EUID != 0 ]]; then
  echo 'Refusing setup outside the explicitly approved GitHub-hosted Ubuntu 24.04 VM.' >&2
  exit 1
fi
# shellcheck source=/etc/os-release
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 && $(dpkg --print-architecture) == amd64 ]]
[[ $(systemd-detect-virt) != docker && $(systemd-detect-virt) != lxc ]]
[[ $(findmnt -n -o FSTYPE /run) == tmpfs ]]
[[ -f ${TENKACLOUD_BUN_SOURCE:-} ]]
install -m 0755 "$TENKACLOUD_BUN_SOURCE" /usr/local/bin/bun
[[ $(/usr/local/bin/bun --version) == 1.3.11 ]]
if command -v docker >/dev/null; then
  # An unavailable daemon is uncertain ownership, not evidence of an empty VM.
  existing_containers=$(docker ps -aq)
  if [[ -n $existing_containers ]]; then
    echo 'Refusing to replace Docker while any pre-existing workload exists.' >&2
    exit 1
  fi
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl wireguard-tools ipset iptables iproute2 kmod
# Hosted images can already have Docker's repo under another signing-key path.
# Move only its two conventional source files aside on this disposable VM to avoid
# apt Signed-By conflicts; keep their exact contents until the VM is destroyed.
install -d -m 0700 /run/tenkacloud-vpn-setup
for source_file in /etc/apt/sources.list.d/docker.list /etc/apt/sources.list.d/docker.sources; do
  if [[ -f $source_file ]]; then
    grep -q 'download.docker.com/linux/ubuntu' "$source_file"
    mv "$source_file" "/run/tenkacloud-vpn-setup/$(basename "$source_file")"
  fi
done
install -d -m 0755 /etc/apt/keyrings
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/tenkacloud-docker.asc
chmod 0644 /etc/apt/keyrings/tenkacloud-docker.asc
cat > /etc/apt/sources.list.d/tenkacloud-docker.sources <<'SOURCES'
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/tenkacloud-docker.asc
SOURCES
# Use matching iptables-nft frontends BEFORE Docker establishes its own admission hooks.
update-alternatives --set iptables /usr/sbin/iptables-nft
update-alternatives --set ip6tables /usr/sbin/ip6tables-nft
systemctl stop docker.service docker.socket containerd.service
apt-get update
apt-get install -y --allow-downgrades --no-install-recommends \
  docker-ce='5:28.4.0-1~ubuntu.24.04~noble' \
  docker-ce-cli='5:28.4.0-1~ubuntu.24.04~noble' \
  containerd.io='1.7.28-1~ubuntu.24.04~noble' \
  docker-buildx-plugin='0.27.0-1~ubuntu.24.04~noble' \
  docker-compose-plugin='2.39.2-1~ubuntu.24.04~noble'

# VM-only prerequisites, prepared explicitly; production native guards never load modules.
for module in wireguard br_netfilter nf_tables nft_compat nf_conntrack ip_set ip_set_hash_ip xt_set xt_comment xt_conntrack; do
  modprobe "$module"
  [[ -d /sys/module/$module ]]
done
# No default routes, existing routes, firewall tables or global policies are flushed.
# These flags last only for this disposable VM; no sysctl.d boot configuration is written.
sysctl -w net.bridge.bridge-nf-call-iptables=1 net.bridge.bridge-nf-call-ip6tables=1 \
  net.ipv4.ip_forward=1 net.ipv6.conf.all.forwarding=1
systemctl restart containerd.service docker.service
[[ $(docker info --format '{{.ServerVersion}}') == 28.4.0 ]]
[[ $(docker context inspect --format '{{.Endpoints.docker.Host}}') == unix:///var/run/docker.sock ]]
[[ $(iptables -S FORWARD | sed -n '/^-A /{p;q;}') == '-A FORWARD -j DOCKER-USER' ]]
docker compose version
# Public versioned fixture image; no registry login, token or private image.
docker pull oven/bun:1.3.11-alpine
echo 'Disposable VPN acceptance VM prerequisites verified.'
