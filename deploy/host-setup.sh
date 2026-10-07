#!/usr/bin/env bash
# One-time VPS host setup (deploy/host-setup.md §1–5). Run as root ON THE SERVER:
#
#   sudo APP_URL=https://example.com/your-secret-path bash host-setup.sh
#
# Safe to run again: every step checks the current state first and only changes what is missing.
# It never touches the SSH configuration (it only warns), never overwrites an existing .env, and
# backs up /etc/nftables.conf before replacing it. Environment variables:
#   APP_URL      public URL (required); sets SITE_ADDRESS and BASE_PATH
#   APP_NAME     shown name of the instance (default BandRoom)
#   APP_DIR      application directory (default /opt/bandroom)
#   SWAP_SIZE    swap file size (default 2G)
#   ASSUME_YES=1 skip the confirmation prompt
set -euo pipefail

: "${APP_URL:?set APP_URL, e.g. APP_URL=https://example.com/your-secret-path}"
APP_NAME=${APP_NAME:-BandRoom}
APP_DIR=${APP_DIR:-/opt/bandroom}
SWAP_SIZE=${SWAP_SIZE:-2G}
APP_USER=bandroom

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
warn() { printf '\033[33m   WARNING: %s\033[0m\n' "$*"; }
trap 'printf "\n\033[31mFailed at line %s. Nothing after that step ran; fix and run again.\033[0m\n" "$LINENO"' ERR

# --- Pre-flight ---------------------------------------------------------------------------------

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo bash $0)." >&2; exit 1; }
# shellcheck source=/dev/null
. /etc/os-release
[[ ${ID:-} == debian ]] || { echo "Debian only (found ${ID:-unknown})." >&2; exit 1; }
[[ $APP_URL =~ ^https://([^/]+)(/.*)?$ ]] || { echo "APP_URL must be https://host[/path]." >&2; exit 1; }
SITE_ADDRESS=${BASH_REMATCH[1]}
BASE_PATH=${BASH_REMATCH[2]%/}

cat <<EOF
BandRoom host setup on $(hostname) (Debian ${VERSION_ID:-?})
  APP_URL       $APP_URL
  SITE_ADDRESS  $SITE_ADDRESS
  BASE_PATH     ${BASE_PATH:-(none, app at the root)}
  APP_DIR       $APP_DIR
  Steps: unattended upgrades, ${SWAP_SIZE} swap, nftables firewall, Docker, user '$APP_USER',
         $APP_DIR with a generated .env. SSH is only checked.
EOF
if [[ ${ASSUME_YES:-} != 1 ]]; then
  read -r -p "Continue? [y/N] " answer
  [[ $answer =~ ^[Yy]$ ]] || exit 0
fi
export DEBIAN_FRONTEND=noninteractive

# --- 1. SSH (check only: a wrong change here locks you out) -------------------------------------

step "SSH"
sshd_effective=$(sshd -T 2>/dev/null || true)
if grep -qx 'passwordauthentication no' <<<"$sshd_effective" &&
  grep -Eqx 'permitrootlogin (no|prohibit-password|without-password)' <<<"$sshd_effective"; then
  info "key-only login is in force"
else
  warn "password login or root password login is still allowed; see host-setup.md §1"
fi

# --- 2. Automatic security updates --------------------------------------------------------------

step "Unattended upgrades"
apt-get update -qq
apt-get install -y -qq unattended-upgrades ca-certificates curl >/dev/null
auto=/etc/apt/apt.conf.d/20auto-upgrades
if [[ -f $auto ]] && grep -q 'Unattended-Upgrade "1"' "$auto"; then
  info "already enabled"
else
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' >"$auto"
  info "enabled"
fi

# --- 3. Swap (the VPS ships without it) ---------------------------------------------------------

step "Swap"
if [[ -n $(swapon --show --noheadings) ]]; then
  info "swap already active: $(swapon --show --noheadings | awk '{print $1, $3}' | paste -sd ' ')"
else
  [[ -f /swapfile ]] || { fallocate -l "$SWAP_SIZE" /swapfile && chmod 600 /swapfile && mkswap -q /swapfile; }
  swapon /swapfile
  info "created and enabled /swapfile ($SWAP_SIZE)"
fi
grep -qE '^/swapfile\s' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
echo 'vm.swappiness=10' >/etc/sysctl.d/99-swappiness.conf
sysctl -q -p /etc/sysctl.d/99-swappiness.conf

# --- 4. Firewall --------------------------------------------------------------------------------

step "Firewall (nftables)"
apt-get install -y -qq nftables >/dev/null
nft_new=$(mktemp)
cat >"$nft_new" <<'NFT'
#!/usr/sbin/nft -f
# BandRoom host firewall (deploy/host-setup.md §1). Replaces only this table; Docker's tables
# survive a reload. No forward chain: Docker filters forwarded container traffic itself.
table inet filter
destroy table inet filter

table inet filter {
	chain input {
		type filter hook input priority filter; policy drop;

		ct state established,related accept
		ct state invalid drop
		iif "lo" accept

		# ICMP: ping, path MTU, and IPv6 neighbor discovery (IPv6 breaks without it)
		ip protocol icmp icmp type { echo-request, destination-unreachable, time-exceeded } limit rate 10/second accept
		ip6 nexthdr icmpv6 icmpv6 type { echo-request, destination-unreachable, packet-too-big, time-exceeded, parameter-problem, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept

		# SSH, with a per-source limit on new connections to slow brute-forcing
		tcp dport 22 ct state new meter ssh-meter { ip saddr limit rate 10/minute burst 20 packets } accept
		tcp dport 22 ct state new meter ssh-meter6 { ip6 saddr limit rate 10/minute burst 20 packets } accept

		# HTTP, HTTPS and HTTP/3 (Caddy). IPv4 clients are forwarded to the container by Docker
		# and never reach this chain; IPv6 clients (the compose network is IPv4-only) reach Caddy
		# through docker-proxy on the host, which this chain does filter.
		tcp dport { 80, 443 } accept
		udp dport 443 accept
	}
}
NFT
if cmp -s "$nft_new" /etc/nftables.conf; then
  info "rule set already current"
  rm -f "$nft_new"
else
  nft -c -f "$nft_new"
  if [[ -f /etc/nftables.conf ]]; then
    backup="/etc/nftables.conf.bak-$(date +%Y%m%d-%H%M%S)"
    cp -p /etc/nftables.conf "$backup"
    info "previous rule set saved as $backup"
  fi
  install -m 0755 "$nft_new" /etc/nftables.conf
  rm -f "$nft_new"
  info "rule set replaced (SSH stays open; established sessions are kept)"
fi
systemctl enable -q nftables
systemctl restart nftables

# --- 5. Docker Engine + Compose plugin ----------------------------------------------------------

step "Docker"
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  info "already installed: $(docker --version)"
else
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: ${VERSION_CODENAME}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin \
    docker-compose-plugin >/dev/null
  info "installed: $(docker --version)"
fi
if [[ -f /etc/docker/daemon.json ]]; then
  if grep -q '"max-size"' /etc/docker/daemon.json; then
    info "log rotation already set"
  else
    warn "/etc/docker/daemon.json exists without log rotation; add it by hand (host-setup.md §3)"
  fi
else
  echo '{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }' \
    >/etc/docker/daemon.json
  systemctl restart docker
  info "container log rotation set (10 MB x 3)"
fi
systemctl enable -q docker
if nft list tables | grep -q 'ip nat'; then
  info "Docker's firewall tables are in place"
else
  warn "Docker's nat table is missing; try: systemctl restart docker"
fi
docker_members=$(getent group docker | cut -d: -f4)
[[ -z $docker_members ]] || warn "in the docker group (equivalent to root): $docker_members"

# --- 6. Dedicated user and application directory ------------------------------------------------

step "User '$APP_USER' and $APP_DIR"
if id "$APP_USER" >/dev/null 2>&1; then
  info "user exists"
else
  adduser --system --group --no-create-home --home /nonexistent "$APP_USER" >/dev/null
  info "created system user"
fi
uid=$(id -u "$APP_USER")
gid=$(id -g "$APP_USER")
info "uid $uid, gid $gid"
install -d -m 0755 -o root -g root "$APP_DIR"
install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$APP_DIR/data"

env_file=$APP_DIR/.env
if [[ -f $env_file ]]; then
  info ".env exists; left unchanged"
  if ! grep -qx "BANDROOM_UID=$uid" "$env_file" || ! grep -qx "BANDROOM_GID=$gid" "$env_file"; then
    warn ".env must contain BANDROOM_UID=$uid and BANDROOM_GID=$gid"
  fi
else
  secret() { head -c 48 /dev/urandom | base64 -w0; }
  (
    umask 077
    cat >"$env_file" <<EOF
# BandRoom configuration (SPEC §19.5), generated by host-setup.sh on $(date -I).
# Keep it secret: chmod 600, owned by root.

# --- Core ---
APP_URL=$APP_URL
APP_NAME=$APP_NAME
APP_SECRET=$(secret)
LOG_LEVEL=info
DEFAULT_LOCALE=en

# Caddy: host name for the certificate and, for the sub-path variant, the path of APP_URL.
SITE_ADDRESS=$SITE_ADDRESS
BASE_PATH=$BASE_PATH
BANDROOM_TAG=latest

# Host user that owns ./data; the app and worker containers run as it.
BANDROOM_UID=$uid
BANDROOM_GID=$gid

# --- Limits ---
MAX_UPLOAD_BYTES=2147483648
WORKER_CONCURRENCY=1

# --- Internal (worker -> API job events) ---
INTERNAL_EVENTS_SECRET=$(secret)
EOF
  )
  info "generated .env with fresh secrets"
fi

# --- Done ---------------------------------------------------------------------------------------

caddyfile=Caddyfile
[[ -n $BASE_PATH ]] && caddyfile=Caddyfile.subpath
cat <<EOF

$(printf '\033[1m')Host is ready.$(printf '\033[0m') Next steps:
  1. From your machine, copy the deploy files (from the repository root):
       scp deploy/compose.yml deploy/deploy.sh <you>@$SITE_ADDRESS:/tmp/
       scp deploy/$caddyfile <you>@$SITE_ADDRESS:/tmp/Caddyfile
     then on the server:
       sudo install -m 0644 /tmp/compose.yml /tmp/Caddyfile $APP_DIR/
       sudo install -m 0755 /tmp/deploy.sh $APP_DIR/
  2. Start and check:  cd $APP_DIR && sudo ./deploy.sh
  3. First admin:      sudo docker compose -f $APP_DIR/compose.yml exec app bandroom create-admin
  4. Open $APP_URL/
DNS: every A/AAAA record of $SITE_ADDRESS must be an address of this machine:
$(ip -br addr show scope global | awk '$1 !~ /^(docker|br-|veth)/ {for (i = 3; i <= NF; i++) print "       " $i}')
EOF
