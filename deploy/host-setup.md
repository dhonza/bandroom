# Host setup (VPS)

One-time setup of the target VPS (netcup piko G11s: 1 vCPU, ~1 GB RAM, 30 GB SSD, Debian 12/13),
performed by the owner (SPEC §19.1). Claude Code never runs these steps.

`deploy/host-setup.sh` does §1–5 in one go (copy it to the server, then
`sudo APP_URL=https://example.com/your-secret-path bash host-setup.sh`). It is safe to run again, only
checks SSH, backs up `/etc/nftables.conf` before replacing it, never overwrites an existing `.env`,
and ends by printing the remaining steps. The sections below explain what it does; keep its
nftables rule set in sync with §1.

## 1. Security baseline

```bash
# SSH keys only
sudoedit /etc/ssh/sshd_config.d/10-hardening.conf
#   PasswordAuthentication no
#   PermitRootLogin prohibit-password
systemctl reload ssh

# Automatic security updates
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades
```

### Firewall (nftables, Debian's default)

Docker manages its own nftables tables (through iptables-nft), so the host rule set must leave
them alone: replace only its own table (`destroy table`, never `flush ruleset`, which would wipe
Docker's rules on every reload) and have no `forward` chain with a drop policy (it would also drop
container traffic: image pulls, Let's Encrypt, outgoing mail). Docker filters forwarded traffic
itself. `/etc/nftables.conf`:

```nft
#!/usr/sbin/nft -f
# Replaces only this table; Docker's tables survive a reload.
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
```

```bash
sudo nft -c -f /etc/nftables.conf && sudo systemctl restart nftables
sudo nft list tables      # after Docker is installed: Docker's tables are still listed
```

## 2. Swap (the VPS ships without it)

Swap is required, not optional: the container memory limits in `compose.yml` add up to 896 MB
(caddy 64 + app 384 + worker 448), more than the ~1 GB VPS has left beside the kernel, Docker and
SSH. Normal use stays far below that (SPEC §19.6: < 350 MB idle, < 800 MB while ingesting), and
the 2 GB swap file absorbs rare peaks, such as a long ingest while the API is busy, instead of
the kernel OOM killer. With `vm.swappiness=10` the kernel swaps only under real pressure; if
`free -m` shows swap in steady use, look at `docker stats` before raising any limit.

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf && sysctl --system
```

## 3. Docker Engine + Compose plugin

Follow <https://docs.docker.com/engine/install/debian/> (skip the "manage Docker as a non-root
user" step: membership in the `docker` group is equivalent to root, so run `docker` with `sudo`
and your sudo password stays the barrier). Then limit container logs:

```bash
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
JSON
systemctl restart docker
```

## 4. DNS

Point the chosen name to the VPS so Caddy can obtain Let's Encrypt certificates: the apex
(`example.com`) for the sub-path variant, or a subdomain. Every A/AAAA record of that name must be
an address the VPS really has (`ip -br addr`): Let's Encrypt prefers IPv6, so a stale AAAA record
makes certificate issuance fail, and it breaks IPv6 clients (most phones).

The sub-path variant (`https://example.com/your-secret-path`) keeps the instance out of sight: the
certificate only names `example.com`, so the path never appears in Certificate Transparency logs,
and everything outside the path answers a bare 404. Share the address only with the band; never put it in `robots.txt` or a public page.

## 5. Dedicated user and application directory

The app and worker containers run as a system user without a login shell that owns only the data
directory, so a compromised container cannot touch your home directory. The directory itself and
`.env` (secrets) stay owned by root.

```bash
sudo adduser --system --group --no-create-home --home /nonexistent bandroom
id bandroom                                  # note the uid and gid for .env
sudo mkdir -p /opt/bandroom/data && cd /opt/bandroom
# copy deploy/compose.yml, deploy/deploy.sh and deploy/.env.example here, and
# deploy/Caddyfile.subpath as Caddyfile (sub-path) or deploy/Caddyfile (subdomain)
sudo cp .env.example .env && sudo chmod 600 .env && sudoedit .env
#   APP_URL=https://example.com/your-secret-path   SITE_ADDRESS=example.com   BASE_PATH=/your-secret-path
#   BANDROOM_UID / BANDROOM_GID from `id bandroom`, APP_SECRET, INTERNAL_EVENTS_SECRET, …
sudo chown bandroom:bandroom data && sudo chmod 750 data
sudo docker compose pull && sudo docker compose up -d
sudo docker compose exec app bandroom create-admin   # from M1
```

Updates: `sudo ./deploy.sh` in `/opt/bandroom`.

## 6. Other services on the same host

The BandRoom Caddy owns ports 80 and 443. Another service is added to the same Caddyfile: its own
site block for a subdomain, or a `handle` block above the final 404 in `Caddyfile.subpath`.
Prefer a subdomain for anything that runs code in the browser (an app, not a static page): pages
on `example.com` share BandRoom's origin, so a cross-site scripting hole in another app there could
act with a band member's BandRoom session.

Backups (`backup.sh`, restic) are added in M15.
