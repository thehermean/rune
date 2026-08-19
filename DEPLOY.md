# Deploying Rune

Rune is a static web app (Vite, output `dist/web`) plus one small Hono server
(`server/index.ts`) that serves the app, a single synced document, and share
links. It is deployed as **one Node process on a VPS**, bound to loopback, with
**Tailscale** terminating HTTPS in front of it. There is no database and no
serverless platform — the data is plain files on disk.

The server does three things from one port:

- serves the built app from `dist/web` (with an SPA fallback to `index.html`),
- `/api/doc` — the single shared `.rune` doc, GET/PUT, gated by `RUNE_TOKEN`
  (all your devices sync through this one doc; or token-free on a private tailnet
  with `RUNE_OPEN_SYNC=1`, see §4a). Every client PUT carries a precondition
  (`If-Match` stamp, or the `expect-empty` sentinel for a never-synced device so
  it can only *seed* an empty server, never clobber an existing list); the server
  409s a failed precondition without writing. Unconditional PUTs are still
  accepted for backward compatibility.
- `/api/publish`, `/api/d/:id/comments`, `DELETE /api/d/:id`, and the public
  read views `/d/:id` (HTML) and `/d/:id.txt` (raw canonical bytes).

---

## 1. Prerequisites

- Node 24.x and `pnpm` on the VPS.
- Tailscale installed and logged in (`tailscale up`), so the box is reachable on
  your tailnet.

## 2. Build

From the repo root:

```bash
pnpm install
pnpm build:web        # -> dist/web (the static app the server serves)
```

Rebuild whenever the web app changes. The server itself runs from source via
`tsx`, so it needs no separate build step.

## 3. Configure the secret

`RUNE_TOKEN` is the single-user instance secret. It gates **sync** (read/write
the shared doc) and the **write side of sharing** (publish, comment, unpublish).
Public read links (`/d/:id`, `/d/:id.txt`) need no token — the unguessable id in
the URL *is* the read capability.

Generate a long random value:

```bash
openssl rand -hex 24        # 48 hex chars / 192 bits
```

**Treat it like a password.** Anyone with it can read and overwrite your doc and
publish snapshots. Do not commit it or paste it into chats/screenshots. If
`RUNE_TOKEN` is unset the sync and publish endpoints return `503` and refuse all
writes (public read views still work).

## 4. Run

```bash
RUNE_TOKEN=<secret> \
RUNE_DATA_DIR=/var/lib/rune \
PORT=8787 \
pnpm serve            # = tsx server/index.ts
```

Environment variables:

| Var | Default | Meaning |
|---|---|---|
| `RUNE_TOKEN` | — (required for publish; for sync unless open) | the instance secret (bearer) |
| `RUNE_OPEN_SYNC` | unset | `1` = trusted-network sync: `/api/doc` needs no token (see §4a) |
| `RUNE_DATA_DIR` | `~/.local/share/rune-server` | where the doc + snapshots live |
| `PORT` | `8787` | localhost port the server binds |
| `RUNE_HOST` | `127.0.0.1` | bind address — keep it loopback behind Tailscale |
| `RUNE_STATIC_DIR` | `dist/web` (next to the server) | override the static build path |

The server binds `127.0.0.1` on purpose: it speaks plain HTTP and lets
`tailscale serve` terminate HTTPS in front of it. Do not expose the port
publicly.

## 4a. Zero-setup sync on a private tailnet (`RUNE_OPEN_SYNC=1`)

By default every device must paste `RUNE_TOKEN` into the **Sync** dialog before
it will sync. On a private tailnet that friction is unnecessary — the network is
already the trust boundary. Set:

```bash
RUNE_OPEN_SYNC=1 \
RUNE_TOKEN=<secret> \
RUNE_DATA_DIR=/var/lib/rune \
PORT=8787 \
pnpm serve
```

With `RUNE_OPEN_SYNC=1`, **`GET`/`PUT /api/doc` (the single shared doc, and
nothing else) accept requests with no bearer token.** Open the app on any tailnet
device and the shared list is just there and syncing — no token to paste. The
client auto-detects this: on first load it probes `GET /api/doc` with no token;
`200` means "open" (it silently enables sync), `401` means "token required" (it
falls back to the manual paste flow). A device the user has explicitly turned
sync **off** on stays off (a persisted opt-out), and either way the manual token
flow and all conflict handling are unchanged.

**What stays gated.** `RUNE_OPEN_SYNC` only relaxes the sync doc. It does **not**
touch anything else:

- **Share publish** (`POST /api/publish`, comment write-backs, unpublish) stays
  `RUNE_TOKEN`-gated. Open sync can't fill your disk with snapshots.
- A request that **does** carry a non-empty bearer must still present the correct
  `RUNE_TOKEN`, or it gets `401` — a misconfigured client fails loudly instead of
  silently syncing to the wrong place. (`RUNE_TOKEN` is still worth setting under
  open sync purely to keep publish available; sync itself works with it unset.)

**When it is safe — and the tradeoff.** Only use `RUNE_OPEN_SYNC=1` when the
server is reachable **exclusively** over your private tailnet (loopback bind +
`tailscale serve`, as in §4–5). In that setup, "no token" means "any device you
already trust onto your tailnet can read and overwrite the one shared list" —
which is exactly the intent for a single-user, all-your-own-devices instance. The
tradeoff is explicit: there is no second factor beyond tailnet membership, so
**never set `RUNE_OPEN_SYNC` on a server whose port is exposed to the public
internet.** If you can't guarantee that, leave it unset and paste the token.

## 5. Put it behind Tailscale (HTTPS)

`tailscale serve` proxies HTTPS on your tailnet to the loopback port. Two forms:

```bash
# Simple: proxy this machine's tailnet HTTPS (443) to localhost:8787, in the bg.
tailscale serve --bg 8787

# Explicit https:443 form (equivalent), if you want to be precise about the port.
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Then open `https://<machine-name>.<your-tailnet>.ts.net/` from any device that's
on the tailnet. Because HTTPS + a stable hostname are in place, the app installs
as a PWA and the service worker runs. To stop serving: `tailscale serve --https=443 off`.

## 6. Run it as a service (systemd)

Example unit (the orchestrator installs the real one). Adjust `WorkingDirectory`,
`User`, and the `pnpm`/`tsx` path to your box:

```ini
# /etc/systemd/system/rune.service
[Unit]
Description=Rune server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=rune
WorkingDirectory=/opt/rune
Environment=PORT=8787
Environment=RUNE_HOST=127.0.0.1
Environment=RUNE_DATA_DIR=/var/lib/rune
# Keep the secret out of the unit file; drop it in an env file mode 600:
EnvironmentFile=/etc/rune/rune.env      # contains: RUNE_TOKEN=...
ExecStart=/usr/bin/env tsx server/index.ts
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rune
journalctl -u rune -f      # logs
```

`WorkingDirectory` must be the repo root so the default `dist/web` static path
resolves (or set `RUNE_STATIC_DIR` to an absolute build path).

## 7. Where the data lives / backups

Everything is under `RUNE_DATA_DIR`:

```
$RUNE_DATA_DIR/
  doc.json            # the single synced document { text, updatedAt }
  shares/
    <docId>.json      # one published share snapshot each (text + write-token hash)
```

It's all plain JSON, written atomically (temp file + rename). Back it up by
copying the folder:

```bash
tar czf rune-backup-$(date +%F).tgz -C "$RUNE_DATA_DIR" .
```

Restore by dropping the files back and restarting. The published snapshot files
store only a **sha256 of** each write token, never the token itself.

## 8. Migrating off the old Vercel + Upstash deployment

The old deploy kept the synced doc in Upstash. You do **not** need to script a
migration — the simplest path is to let a client push its local copy:

1. Stand up the new server (steps 2–5) with a fresh `RUNE_TOKEN`.
2. On the device that has your current list, open **Sync**, paste the new token,
   and enable sync. The client pushes its local doc to the new server, which
   becomes canonical. Every other device then pulls it.

If you'd rather pull the doc from the old endpoint once before decommissioning
it, fetch it with the old token and PUT it into the new server:

```bash
# From the OLD Vercel deployment:
curl -s -H "Authorization: Bearer $OLD_TOKEN" https://<old-app>.vercel.app/api/doc \
  | jq -r .text > current.rune

# Into the NEW server (over the tailnet, or localhost on the box):
curl -s -X PUT -H "Authorization: Bearer $NEW_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "$(jq -Rns '{text: input}' < current.rune)" \
  https://<machine>.<tailnet>.ts.net/api/doc
```

## 9. Rotating the token

1. Generate a new secret: `openssl rand -hex 24`.
2. Update `RUNE_TOKEN` (env file) and restart the service.
3. Re-enter the new token in the **Sync** dialog on every device.

Rotation locks out anyone who had the old secret. The stored doc is unaffected —
only the credential changes. Per-share write tokens are independent of
`RUNE_TOKEN`; rotating the instance secret does not invalidate existing share
read links.

---

## Icons / PWA follow-up

The app ships a vector icon (`web/public/icon.svg`) plus PNG icons
(`icon-180/192/512.png`) referenced by the manifest. Vite copies everything in
`web/public/` to `dist/web/` during `pnpm build:web`, so icons and the service
worker ship automatically.
