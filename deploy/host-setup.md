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
# copy deploy/compose.yml, deploy/deploy.sh, deploy/status.sh and deploy/.env.example here, and
# deploy/Caddyfile.subpath as Caddyfile (sub-path) or deploy/Caddyfile (subdomain);
# all of them owned by root and not writable by anyone else (see §7)
sudo cp .env.example .env && sudo chmod 600 .env && sudoedit .env
#   APP_URL=https://example.com/your-secret-path   SITE_ADDRESS=example.com   BASE_PATH=/your-secret-path
#   BANDROOM_UID / BANDROOM_GID from `id bandroom`, APP_SECRET, INTERNAL_EVENTS_SECRET, …
sudo chown bandroom:bandroom data && sudo chmod 750 data
sudo docker compose pull && sudo docker compose up -d
sudo docker compose exec app bandroom create-admin   # from M1
```

Updates, rollback and the status script: §7.

## 6. Other services on the same host

The BandRoom Caddy owns ports 80 and 443. Another service is added to the same Caddyfile: its own
site block for a subdomain, or a `handle` block above the final 404 in `Caddyfile.subpath`.
Prefer a subdomain for anything that runs code in the browser (an app, not a static page): pages
on `example.com` share BandRoom's origin, so a cross-site scripting hole in another app there could
act with a band member's BandRoom session.

Off-site backups (`backup.sh`, restic) are added in M15; `deploy.sh` only keeps a local copy of the database before each update.

## 7. Updates, rollback and status

All commands run in `/opt/bandroom`.

```bash
sudo ./deploy.sh              # deploy the tag already in .env (BANDROOM_TAG; latest without it)
sudo ./deploy.sh v1.2.3       # switch to v1.2.3 and deploy it
sudo ./deploy.sh --rollback   # undo the last update
sudo ./status.sh              # read-only overview
sudo ./status.sh song "<part of a title>"
sudo ./status.sh uploads [hours]
```

**Deploy.** `deploy.sh` accepts only a tag of the form `vX.Y.Z`. With a tag it first pulls exactly
that image; if the tag does not exist it stops and changes nothing. Then it sets
`BANDROOM_TAG=<tag>` in `.env` (adding the line if needed), after copying `.env` to
`.env.bak-<UTC time>` (mode 600). It pulls, stops the app and worker, copies
`data/bandroom.sqlite` to `/opt/bandroom-backup/bandroom-before-<new>-from-<old>-<UTC time>.sqlite`
(next to the application directory), verifies the copy, starts the new version and waits for the
health check. It never overwrites or deletes a backup; remove old ones by hand. The backup
directory is root-only (`chmod 700`), so list or copy its files inside a root shell, e.g.
`sudo sh -c 'ls -l /opt/bandroom-backup/'` (a `*` typed in your own shell cannot see into it), or
use `sudo ./status.sh`.

**Self-update.** Every image from v0.4.1 on carries `deploy.sh`, `status.sh`, `compose.yml` and the
Caddyfile templates in `/app/deploy/`. After pulling, `deploy.sh` copies them out of the new image
and, for each of `deploy.sh`, `status.sh` and `compose.yml` that differs from the installed one,
prints a unified diff, keeps the old file as `<file>.bak-<UTC time>` and installs the new one
(owned by root; mode 755 for the scripts, 644 for `compose.yml`). When `deploy.sh` or `compose.yml`
changed, it restarts itself once with the same arguments, so the rest of the update already runs
with the new files. It never installs files from an image older than the running version. The
`Caddyfile` is never replaced, because yours may be customized: when it differs from the matching
template, the diff is printed as a note, and you adopt what you need by hand
(`sudo docker compose restart caddy` afterwards).

Updating from a release before v0.4.1 needs the new scripts once (later updates bring them along):

```bash
cd /opt/bandroom
for f in deploy.sh status.sh; do
  sudo curl -fsSL "https://raw.githubusercontent.com/<owner>/bandroom/main/deploy/$f" -o "$f"
done
sudo chown root:root deploy.sh status.sh && sudo chmod 755 deploy.sh status.sh
```

**Rollback.** `sudo ./deploy.sh --rollback` looks in the backup directory for the newest
`bandroom-before-<running>-from-<previous>-*.sqlite`, prints its plan and checks that the
`<previous>` image exists. It then stops the app and worker, copies the current database to
`bandroom-before-rollback-from-<running>-<UTC time>.sqlite` (verified), restores the backup (removing
stale `-wal`/`-shm` files and keeping the owner and mode of the database file), sets
`BANDROOM_TAG=<previous>` (with a `.env` backup), starts and waits for the health check. Everything
changed in BandRoom since that backup is lost from the running instance; it is still in the copy
made first. Without a matching backup, or when `<previous>` is not a `vX.Y.Z` tag, it changes nothing.

**Status.** `status.sh` only reads: it shows the running versions, container states and health,
`BANDROOM_TAG`, free disk space for the data and backups, the newest 10 backups and the last 50
warnings and errors of the app and worker. `song` lists, for each song whose title contains the
text (case-insensitive, deleted ones included), its tracks and versions with their audio variants,
Opus bitrate and channels, source codec, lossless flag and upload options. `uploads` lists the
audio uploaded in the last `hours` (default 24). The database is opened read-only inside the app
container, and the search text is passed as a bound query parameter.

### Running the scripts without a password (optional)

A sudoers rule can allow your user (`<you>`) to run exactly these two scripts as root without a
password, e.g. so that an assistant working in your SSH session can deploy or inspect without
being given your password. Install it once:

```bash
sudo visudo -f /etc/sudoers.d/bandroom-deploy
#   <you> ALL=(root) NOPASSWD: /opt/bandroom/deploy.sh, /opt/bandroom/status.sh
sudo chmod 0440 /etc/sudoers.d/bandroom-deploy
sudo visudo -c                 # all files parse
sudo -l                        # as <you>: lists the two scripts
```

Run them as `sudo ./deploy.sh …` in `/opt/bandroom` or as `sudo /opt/bandroom/deploy.sh …`; sudo
matches the full path. Why this does not hand out root:

- The rule only covers these two files, so they, everything they read and their directory must not
  be writable by `<you>`: otherwise `<you>` could change them, or `compose.yml` (a container can
  mount `/`), and run anything as root. Check with
  `ls -ld /opt/bandroom /opt/bandroom/{deploy.sh,status.sh,compose.yml,Caddyfile,.env}`: all owned
  by root and writable only by root. `deploy.sh` installs updated files the same way.
- Both scripts accept only strictly validated arguments (a `vX.Y.Z` tag, `--rollback`, `--help`; a
  title fragment of at most 200 characters without control characters, a whole number of hours),
  and never pass them to a shell or into SQL text.
- sudo resets the environment (`env_reset`), so nothing in your shell changes what the scripts do.
  The variables `BANDROOM_BACKUP_DIR` and `BANDROOM_SKIP_BACKUP` therefore only work for a user
  with full sudo rights (`sudo BANDROOM_SKIP_BACKUP=1 ./deploy.sh`); under this rule sudo refuses
  them.
- What the rule does allow: deploying any published version and rolling back the last update
  (which keeps a copy of the database first), and reading song, track and upload details.
- The self-update installs files from the release image as root, so whoever can publish images to
  the registry can change these scripts. The diff is printed on every change; review it.
