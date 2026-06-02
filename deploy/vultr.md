# Deploying notesci on a Vultr VPS

This guide assumes:

- You already have a Vultr VPS (any region; for low LLM-API latency to
  US-based providers a US region is fine — Anthropic / OpenAI both
  have global edges).
- A domain you control is pointed at the VPS (`A` record → IPv4).
- You have an LLM provider key (Anthropic / OpenAI / Google / DeepSeek).

The stack is three Compose services on a single host:

```
                          ┌─────────────────────┐
   user (TLS)  ───────►   │ Caddy / Cloudflare  │   :443
                          │     (TLS edge)      │
                          └────────┬────────────┘
                                   │ :80
                          ┌────────▼────────────┐
                          │ frontend (nginx)    │   serves SPA + /api proxy
                          └────────┬────────────┘
                                   │ :8000 (private)
                          ┌────────▼────────────┐
                          │ backend (uvicorn)   │   FastAPI + LangGraph
                          └────────┬────────────┘
                                   │ :5432 (private)
                          ┌────────▼────────────┐
                          │ postgres (pgvector) │   data on a docker volume
                          └─────────────────────┘
```

For higher scale you'd split Postgres onto Vultr Managed Databases and
put backend behind a load balancer. The single-host setup below is
right for the invite-only beta.

---

## 1 · One-time VPS setup

SSH into the VPS as root (or your sudo user) and install Docker +
Compose v2 + a TLS reverse proxy.

```bash
# Docker Engine
curl -fsSL https://get.docker.com | sh
usermod -aG docker $USER         # log out + back in for the group to take effect

# Compose v2 (bundled with modern docker on Vultr's marketplace images;
# verify with `docker compose version`).

# Caddy is the simplest TLS terminator — it handles Let's Encrypt
# automatically.  (Use Cloudflare Tunnel instead if your domain is on CF.)
apt install -y caddy
```

Open the firewall ports you need:

```bash
ufw allow 22         # ssh
ufw allow 80         # http (Caddy redirects to https)
ufw allow 443        # https
ufw enable
```

---

## 2 · Drop the repo on the VPS

```bash
# Either git clone, or scp the repo up. Both work. Skip /node_modules,
# /.venv, *.pen and anything matching .gitignore — they build inside
# the containers.
git clone https://github.com/<you>/notesci.git
cd notesci
```

---

## 3 · Configure environment

```bash
cp .env.prod.example .env.prod
nano .env.prod
```

At minimum fill in:

- `POSTGRES_PASSWORD` — strong, 32+ chars
- `NOTESCI_ADMIN_TOKEN` — `python -c "import secrets; print(secrets.token_urlsafe(32))"`
- `OPENAI_API_KEY` — required for embeddings (retrieval grounding)
- One chat key: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `DEEPSEEK_API_KEY`
- `NOTESCI_DEFAULT_MODEL` — e.g. `anthropic:claude-sonnet-4-6`
- `NOTESCI_APP_BASE_URL` — e.g. `https://notesci.your-domain.com`
- `NOTESCI_EMAIL_FROM_INVITE` / `_FROM_SECURITY` — addresses on a domain
  with valid SPF / DKIM / DMARC records pointing at your SMTP provider
- `NOTESCI_SMTP_*` if you want real email; otherwise leave
  `NOTESCI_EMAIL_BACKEND=log` and tokens land in the backend container's
  stdout (visible via `docker compose logs -f backend`).

---

## 4 · Build + run the stack

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod build
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d

# Verify
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f backend   # ctrl-C to detach
curl -s http://127.0.0.1:8080/healthz                       # nginx
curl -s http://127.0.0.1:8080/api/health                    # via the proxy
```

The frontend container listens on `:8080` (host) → `:80` (container).
`docker-compose.prod.yml` does not publish backend or postgres to the
host — they're only reachable on the private docker network.

---

## 5 · Put TLS in front

### Option A · Caddy (single-line config)

```bash
cat >/etc/caddy/Caddyfile <<'EOF'
notesci.your-domain.com {
  reverse_proxy 127.0.0.1:8080
}
EOF
systemctl reload caddy
```

Caddy fetches a Let's Encrypt cert automatically (HTTP-01 challenge over
port 80). Your stack is now reachable at `https://notesci.your-domain.com`.

### Option B · Cloudflare Tunnel (no public ports needed)

If your domain is on Cloudflare, install `cloudflared` and create a
tunnel pointing at `http://127.0.0.1:8080`. Cloudflare terminates TLS at
the edge and you can keep ports 80/443 closed on the VPS.

---

## 6 · Provision your operator account

The VPS Postgres volume starts empty, so the database has no workspace
and no account on the first boot. Provision your own admin account with
the bundled seed script — it's idempotent (safe to re-run) and ensures
a workspace, an `admin` member with a known password, and a pool of
invite codes.

```bash
docker compose -f docker-compose.prod.yml exec \
  -e NOTESCI_SEED_ADMIN_PASSWORD='your-strong-password' \
  backend python scripts/seed_admin.py
```

Defaults — override any of these by adding more `-e` flags to the
`docker compose exec` command above (the `NOTESCI_SEED_*` block in
`.env.prod.example` lists them for reference):

| Env var | Default |
|---|---|
| `NOTESCI_SEED_ADMIN_EMAIL` | `admin@notesci.com` |
| `NOTESCI_SEED_ADMIN_PASSWORD` | **required — no default** |
| `NOTESCI_SEED_ADMIN_NAME` | `notesci` |
| `NOTESCI_SEED_WORKSPACE_SLUG` | `notesci` |
| `NOTESCI_SEED_WORKSPACE_NAME` | `notesci` |
| `NOTESCI_SEED_INVITE_COUNT` | `50` |

The password is required with no default on purpose, so it never lands
in source control. Re-running the script resets the password + forces
`role=admin`, and tops the invite pool back up to the target count
without duplicating existing codes.

Then visit `https://notesci.your-domain.com/sign-in` and sign in with
that email + password — you're in, as the workspace admin, with your
invite codes on the `/invites` page.

### Handing out additional workspaces (optional)

notesci is a personal knowledge base — one workspace per person — but
if you ever need to stand up a *separate* workspace for someone else,
the admin endpoint mints bootstrap invite codes for it. The first
person to claim one becomes that workspace's admin.

```bash
ADMIN_TOKEN=...   # whatever you put in NOTESCI_ADMIN_TOKEN

curl -X POST https://notesci.your-domain.com/api/admin/workspaces \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"slug":"second-space","name":"Second space","bootstrap_invites":1}'
```

---

## 7 · Day 2 ops

### Update deploy

```bash
git pull
docker compose -f docker-compose.prod.yml --env-file .env.prod build
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

Migrations run on backend startup via the FastAPI `lifespan` hook — no
manual step. Check `logs backend` for migration output on the first
boot after a release that adds new SQL files.

### Backups

The `notesci-pgdata` volume holds everything. The cheapest backup is
`docker compose exec postgres pg_dump -Fc -U notesci notesci > /backups/notesci-$(date +%F).dump`
on a daily cron, then push the dump file to Vultr Object Storage.

### Restoring

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod down
docker volume rm notesci_notesci-pgdata
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d postgres
# wait for postgres to come up, then
cat backup.dump | docker compose exec -T postgres pg_restore -U notesci -d notesci -c
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

### Logs

```bash
docker compose -f docker-compose.prod.yml logs -f backend frontend
```

For longer retention, point the daemon at a JSON / journald driver and
ship to Vultr Object Storage or an external collector.

### Resource sizing

- 2 vCPU / 4 GB RAM is comfortable for a beta with ≤50 active users.
- pgvector recall scales with chunk count — budget ~3 GB extra disk per
  10k chunks if you're ingesting heavy PDFs.
- For larger embedding dimensions or more users, move Postgres to Vultr
  Managed Databases (you'll need to install the `vector` extension on
  the managed instance — Vultr supports custom extensions on Postgres
  16+).

---

## Vultr-specific gotchas

- **Outbound port 25 is blocked** by default on most Vultr regions. Use
  port 587 (submission with STARTTLS) for SMTP — already the default in
  `.env.prod.example`. If you need port 25, file a Vultr ticket and they
  unblock per-VPS.
- **IPv6** is enabled by default on Vultr; if your DNS only has an `A`
  record, that's fine, but you may want to add an `AAAA` so users on
  IPv6-only networks reach you.
- **Snapshot before risky updates** — Vultr's "snapshot" feature on the
  control panel takes ~5 min and is the fastest rollback path.

---

## Hardening env vars (production)

The backend reads a handful of optional-but-strongly-recommended env
vars that gate security-sensitive behaviour. Set these on every
production deploy.

### `NOTESCI_ENV` — environment mode (REQUIRED in prod)

One of ``dev`` / ``prod`` / ``test``. In ``prod`` mode the backend
**refuses to start** without ``NOTESCI_SECRET_KEY`` set, so MCP
credentials can never silently fall back to plaintext at-rest storage.

```
NOTESCI_ENV=prod
```

### `NOTESCI_SECRET_KEY` — MCP credential encryption (REQUIRED in prod)

Fernet key used to encrypt MCP server credentials at rest
(``mcp_servers.config.headers`` secret values, ``config.env`` entries).
In ``prod`` mode the server refuses to start without it. In ``dev`` /
``test`` it logs a warning at startup and stores values in plaintext.

Generate a fresh key:

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Then add to ``.env.prod``:

```
NOTESCI_SECRET_KEY=<the-generated-key>
```

See "Rotating the MCP encryption key" below for the rollover procedure.

### `NOTESCI_ALLOWED_ORIGINS` — CORS allowlist

Comma-separated list of origins allowed to call the API from a browser.
The backend rejects requests with an ``Origin`` header outside this
list, so set this to your user-facing https origin(s) before exposing
the stack to the public internet.

```
NOTESCI_ALLOWED_ORIGINS=https://app.notesci.com,https://staging.notesci.com
```

Defaults to ``http://localhost:5173`` (the Vite dev server) when unset —
fine for local dev, **unsafe for production**.

### `NOTESCI_TRUSTED_PROXIES` — reverse-proxy CIDR list

Comma-separated CIDRs whose ``X-Forwarded-For`` / ``X-Forwarded-Proto``
headers the backend will honour. Without setting this to your TLS
edge's IP range, an attacker can forge the client IP that lands in
audit logs and rate-limiter buckets.

```
# Cloudflare:
NOTESCI_TRUSTED_PROXIES=173.245.48.0/20,103.21.244.0/22,103.22.200.0/22,...
# Single VPS LB:
NOTESCI_TRUSTED_PROXIES=10.0.0.0/8
```

Defaults to ``127.0.0.1/8,::1/128`` (loopback only) when unset — that
default is correct for Caddy-on-the-same-host but wrong for Cloudflare
Tunnel or an external load balancer.

### `NOTESCI_LOG_FORMAT` — structured logs (optional)

Set to ``json`` to emit one-JSON-object-per-line structured logs
(ready to ship to Loki / Datadog / Vultr Object Storage). Defaults to
the human-readable text format.

```
NOTESCI_LOG_FORMAT=json
```

### Rotating the MCP encryption key

Today the backend reads a **single** ``NOTESCI_SECRET_KEY``. Rotating
it means every MCP credential already encrypted under the old key
becomes unreadable — the dashboard will surface "decrypt failed"
errors and admins will have to re-paste secrets.

Until comma-separated rollover support lands (see below), the safe
procedure is a maintenance window:

```bash
# 1. Announce + drain. Stop the backend so no new writes use the old key.
docker compose -f docker-compose.prod.yml stop backend

# 2. Dump the encrypted columns (mcp_servers.config holds the Fernet
#    blobs under config.headers.* and config.env.*).
docker compose -f docker-compose.prod.yml exec postgres \
  pg_dump -U notesci -Fc -t mcp_servers notesci > mcp_servers-pre-rotate.dump

# 3. Decrypt + re-encrypt with the new key using a one-shot Python
#    script that uses the cryptography helpers in
#    ``backend/src/notesci/crypto.py`` (read old key from env, write
#    with the new). Apply the UPDATEs in a transaction.

# 4. Roll NOTESCI_SECRET_KEY in .env.prod, restart:
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d backend
```

#### `NOTESCI_SECRET_KEYS` — comma-separated key list *(Coming in v1.2)*

The planned rollover story: set a comma-separated list where the
**first** key is the active write key and the **remaining** keys are
decrypt-only. The backend writes new ciphertext with the first key
and falls back to subsequent keys when decryption fails. Once every
row has been re-encrypted (audit logs land on a ``mcp.credential.rotate``
event), drop the old keys from the list and restart.

```
# v1.2 example (not active yet):
NOTESCI_SECRET_KEYS=<new-key>,<old-key>
```

### Backend healthcheck

``docker-compose.prod.yml`` now declares a healthcheck on the backend
service that polls ``/readyz`` (DB pool open + LangGraph checkpointer
migrated). The frontend's ``depends_on`` is gated on
``service_healthy`` so Compose won't expose the app at all until the
backend is actually ready to take traffic.

Tail with:

```bash
docker compose -f docker-compose.prod.yml ps
docker inspect --format='{{json .State.Health}}' notesci-backend-1 | jq
```
