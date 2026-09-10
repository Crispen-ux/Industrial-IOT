# Edge gateway deployment guide

This covers installing the gateway on a server/PC on the plant network, near
the scales. The backend + dashboard can be cloud-hosted (see the main
README's "Database" section for Neon setup) or run anywhere else reachable
over HTTPS — the gateway doesn't care where it is, only that it can reach it.

## Network requirements

The gateway is **outbound-only**. Site IT does not need to open any inbound
port, set up port forwarding, or add a firewall exception for anything
reaching in from outside the site.

| Direction | What | Port |
|---|---|---|
| Outbound | Gateway → backend (HTTPS) | 443 (or whatever the backend is configured on) |
| Outbound | Gateway → each scale (Modbus TCP / OPC-UA / REST / MQTT, per device) | varies by device — see that device's protocol config |
| Local only | `GET /healthz` on the gateway host itself | 9090 (configurable) |

If the site network requires an outbound allowlist/proxy, the only entry
needed is the backend's hostname on 443.

The `/healthz` endpoint is diagnostic-only — bind it to the LAN or loopback,
never expose it to the internet. It doesn't require authentication and isn't
meant to be internet-facing.

## Choosing Docker vs systemd

Both are supported and equally maintained — pick whichever fits the site:

- **Docker** — simpler updates (`docker compose pull && up -d`), isolated
  from the host's Node version, easiest if the site already runs other
  containerized services.
- **systemd** — no Docker dependency, which some OT/industrial sites
  deliberately avoid on control-network-adjacent hardware. Runs as a
  standard Linux service with journal logging.

## Option A: Docker

```bash
cd gateway
cp .env.example .env
# edit .env — set BACKEND_URL and GATEWAY_API_KEY
docker compose up -d
```

Check it's healthy:
```bash
curl http://localhost:9090/healthz
docker compose logs -f
```

Update to a new version:
```bash
git pull   # or however you're distributing updates
docker compose up -d --build
```

The reading buffer (`pending-readings.jsonl`) lives on a named Docker volume
(`gateway-buffer`), not inside the container — so `docker compose up -d
--build` to deploy an update doesn't lose anything that was queued during a
backend outage.

## Option B: systemd (no Docker)

Requires Node.js 18+ already installed on the host.

```bash
cd gateway
sudo bash deploy/install.sh
```

The installer copies the gateway to `/opt/scale-ops/gateway`, creates a
dedicated unprivileged `scaleops` user to run it, and installs the systemd
unit — but it deliberately does **not** create `.env` or start the service,
since the gateway API key is unique per deployment and has to come from you.
Follow the printed instructions to finish:

```bash
sudo cp /opt/scale-ops/gateway/.env.example /opt/scale-ops/gateway/.env
sudo nano /opt/scale-ops/gateway/.env   # set BACKEND_URL and GATEWAY_API_KEY
sudo systemctl start scale-ops-gateway
sudo systemctl status scale-ops-gateway
```

Useful commands:
```bash
journalctl -u scale-ops-gateway -f      # tail logs
curl http://localhost:9090/healthz      # health check
sudo systemctl restart scale-ops-gateway
```

The service is configured `Restart=always` — a crash, a reboot, or a power
blip all bring it back up on their own; nobody needs to SSH in and restart
it by hand.

## Health monitoring

`GET http://<gateway-host>:9090/healthz` returns:

```json
{
  "status": "ok",
  "uptimeSeconds": 41230,
  "devicesConnected": 4,
  "backendReachable": true,
  "lastSuccessfulPostAt": "2026-08-30T07:27:16.194Z",
  "bufferedReadings": 0,
  "backendUrl": "https://your-backend.example.com"
}
```

`status` is `"degraded"` (HTTP 503) if no devices are connected, or if the
local buffer has backed up past 1000 readings (meaning the backend's been
unreachable for a while) — either is worth investigating. `backendReachable:
false` with a growing `bufferedReadings` count is the expected, correct
behavior during a genuine outage — that's the buffering working as designed,
not a bug.

Wire this into whatever monitoring the site already has (Nagios, Zabbix, a
cron job that curls and alerts on non-200, etc.) — nothing here requires a
specific tool, just an HTTP GET.

## What happens with no internet at the site

Two different situations, and only one of them this architecture actually handles well:

**Intermittent/unreliable internet (the common case)** — scales keep working
(all protocol traffic is LAN-only), the gateway keeps polling and buffers
every reading locally, and flushes in order once connectivity returns. The
dashboard is unreachable *from that site* during the outage — it's served by
the backend, wherever that's hosted — but `GET /healthz` on the gateway
itself still works locally, so a technician on-site can confirm it's
buffering correctly without needing the dashboard. The backend's own
silence-watchdog (running wherever the backend is hosted, with its own
internet) will notice the gap and can still fire a webhook alert — the
outage itself becomes something someone gets notified about, even though
nobody at the site can see the dashboard during it.

The buffer is sized for this case — see `MAX_QUEUED_READINGS` in
`.env.example` for the exact coverage numbers (hours to days, depending on
device count). Past that cap, the *oldest* buffered readings get dropped to
make room for new ones, not the newest — so a very long outage loses
mid-outage detail, not the most recent state.

**Genuinely no internet, ever (a permanently isolated site)** — this
architecture doesn't support that today. A cloud-hosted backend needs *some*
connectivity to ever be reachable; if a site truly never gets online, the
buffer just fills, drops old data forever, and the dashboard/reports for
that site stay permanently empty. If this is your actual situation (not
"unreliable," but "no ISP available"), that needs a different architecture —
a fully local backend + local Postgres running on-site, with either no cloud
sync at all or a periodic/scheduled sync (e.g. over a cellular modem window,
or manual export/import) rather than the always-connected model this
gateway assumes. That's a real scope change, not a config tweak — ask if
this applies to you before assuming the current setup will work.

## Security notes

- The gateway API key (`GATEWAY_API_KEY`) is the only credential the gateway
  holds, and it can only post readings — it has no access to devices, users,
  branding, or configuration. If a gateway host is ever compromised, revoke
  its key from the dashboard's "Gateway keys" panel (manager+) without
  affecting any other site.
- Create one gateway key per physical site/gateway, not one shared key
  across all of them — that's what makes per-site revocation possible.
- The Docker image runs as a non-root user; the systemd unit runs as a
  dedicated unprivileged `scaleops` user with `ProtectSystem=strict`. Neither
  needs elevated privileges to do its job.
- `.env` contains the gateway API key in plaintext — treat it like any other
  credential file (correct filesystem permissions, not committed to version
  control; `.gitignore`/`.dockerignore` already exclude it here).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `GATEWAY_API_KEY is not set` on startup | `.env` missing or empty | Copy `.env.example` to `.env` and fill it in |
| `rejected: invalid or revoked gateway API key` in logs | Key was revoked, or copied wrong | Generate a new key from the dashboard, update `.env`, restart |
| `backendReachable: false` for an extended period | Backend down, DNS issue, or firewall blocking outbound 443 | Check `BACKEND_URL` is reachable from the gateway host: `curl $BACKEND_URL` |
| `bufferedReadings` climbing steadily | Same as above — this is the buffer doing its job, not data loss | Once the backend's reachable again, the queue flushes automatically in order |
| Gateway connects but a specific device shows no data | Device's protocol/register config is wrong, or it's genuinely unreachable | Use the dashboard's Engineering Mode (manager+) to test that device's connection and data point directly |
