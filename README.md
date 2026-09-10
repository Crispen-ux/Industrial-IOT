# Scale Ops — Industrial IoT Dashboard

Full-stack prototype for monitoring bag-filling scales: add a device by IP + protocol,
pick which analytics you want to see, and watch a live customizable dashboard.

## Architecture

```
scales (any protocol) --> gateway service --> backend API + WebSocket --> dashboard (browser)
                                                       |
                                                  Postgres (Neon)
```

- **backend/** — Express API + WebSocket server. All persistent data (devices,
  widgets, products, users, maintenance/calibration records, templates,
  branding, alert config/history, audit log, give-away stats, and reading
  history) lives in Postgres — see "Database" below. Also serves the frontend.
- **gateway/** — Polls every registered device on its configured protocol, normalizes
  the reading, and posts it to the backend. Protocol drivers live in `gateway/drivers/`
  — one file per protocol, all currently backed by a shared fill-cycle simulator so
  the whole stack runs without real hardware. See "Connecting real scales" below.
- **frontend/** — Plain HTML/JS/CSS dashboard. No build step. Talks to the backend
  over REST (device/widget management) and WebSocket (live readings).

## Database

Postgres-backed (built for and tested against [Neon](https://neon.tech), but any
standard Postgres works — nothing here is Neon-specific).

```bash
cd backend
cp .env.example .env
# paste your Neon connection string into .env as DATABASE_URL
npm install
npm start
```

`backend/schema.sql` runs automatically on every startup (`CREATE TABLE IF NOT
EXISTS` throughout, so it's safe to run repeatedly — no separate migration
step to remember). Nothing to provision by hand beyond creating the database
itself in Neon's console and copying the connection string.

**What's in Postgres** vs **what's still in-memory**, and why:
- Postgres: everything that must survive a restart or needs to be queried —
  devices, widgets, products, users, gateway keys, maintenance/calibration
  records, templates, branding, alert config, audit log, alert history,
  give-away/loss stats (`device_stats`), and full reading history (`readings`).
- In-memory only: the live-sparkline cache (last ~30 readings per device —
  every reading is *also* durably written to `readings`, this is just a fast
  path so the dashboard doesn't round-trip to the DB on every tick),
  out-of-tolerance streak counters, and engineering-mode communication logs.
  None of these need to survive a restart or be queried later.

This is what actually fixes the biggest limitation from the JSON-file version:
give-away stats used to live only in memory and reset to zero on every
restart even though `data.json` persisted everything else. They're now in
`device_stats` and survive restarts like everything else. The new
`/api/devices/:id/readings-range` endpoint is the other direct payoff — real
date-range queries against durable history, not just "since last reset."

## Running it

```bash
# Terminal 1 — backend (also serves the dashboard at http://localhost:4000)
cd backend
cp .env.example .env   # set DATABASE_URL to your Neon connection string
npm install
npm start
```

On first run the backend runs migrations, then prints a **one-time** dashboard
login and a default **gateway API key** to the console — copy both now, they're
never shown again in full.

```bash
# Terminal 2 — gateway (polls devices, feeds the backend)
cd gateway
npm install
cp .env.example .env
# paste the gateway API key from the backend's console output into .env
npm start
```

Open http://localhost:4000, log in with the printed credentials, add a device
(any protocol, any IP — it'll simulate data until real drivers are wired in),
then add widgets against it.

## Authentication & roles

Two separate credential types, matching who's actually authenticating:

- **Dashboard users** — username/password, issued a short-lived (12h) JWT.
  Every user has a role that determines what they can do:
  - **operator** — view the dashboard, live data, alerts, and reports. Can't
    change anything.
  - **manager** — everything an operator can, plus manage devices, widgets,
    branding, alert settings, gateway keys, and reset a device's give-away
    stats. Can also view the audit log.
  - **admin** — everything a manager can, plus create/remove dashboard users
    and change their roles. The system refuses to demote or remove the last
    admin account, so you can't accidentally lock yourself out.

  A default `admin` user is created automatically on first run (see console
  output). Add operators/managers from the dashboard's "Users" panel.

- **Gateway API keys** — a static key per gateway, sent as `X-Gateway-Key`.
  Manage these from the dashboard's "Gateway keys" panel (manager+) — create
  one per physical gateway deployment so you can revoke a single site without
  affecting others. A gateway key can only post readings — it has no access
  to devices, users, or configuration.

Every API route is protected except `POST /api/auth/login` and
`GET /api/branding` (public so the login screen can show the client's logo
before authenticating).

## Audit log

Every mutating dashboard action — device/widget add or remove, branding and
alert-config changes, gateway key create/revoke, user create/remove/role
change, stats resets, report exports, and logins — is recorded with who did
it, their role, and when. View it from the "Audit log" button (manager+).
Stored in the `audit_log` table with no cap (the JSON-file version capped it
at 1000 entries; that limitation is gone now that it's a real table).

## Reports & exports

Both CSV and PDF, from the "Reports" panel, available to any logged-in user:

- **Give-away report** — per device: bags filled, cumulative overfill/underfill
  in kg, estimated cost, and the timestamp of the last reset. PDF version
  includes a totals row and picks up the client's branding (name, accent
  color) — formatted to print or email as-is.
- **Alert history** — every alert that's fired, with severity, message, and
  resolution status.

Use CSV for spreadsheet work, PDF for something to hand to a client or print.
Both pull from the same underlying data, so they never disagree with each
other or with what's on the dashboard.

Give-away figures are cumulative since a device was added *or* since it was
last reset — there's a "Reset" button per device (manager+) to start a new
counting period, e.g. at a shift boundary. The give-away/alert reports
themselves are still "cumulative since reset" rather than a picked date
range; the underlying data (`readings` table, full history, queryable via
`GET /api/devices/:id/readings-range`) now supports building true date-range
reports, that's just not wired into the Reports panel's PDF/CSV buttons yet.

## Connecting real scales

Each protocol has its own driver file in `gateway/drivers/index.js`. Every driver
currently delegates to `drivers/simulator.js`. To connect a real scale:

1. Pick the driver matching its protocol (`ModbusDriver`, `OpcUaDriver`, `RestDriver`, `MqttDriver`).
2. Replace the body of `read()` with the real call:
   - **Modbus TCP** — `npm i modbus-serial`, connect to `device.ip:502`, read the
     weight holding register per your scale's register map.
   - **OPC-UA** — `npm i node-opcua`, connect to `opc.tcp://<ip>:4840`, read the
     configured NodeId.
   - **REST API** — `fetch` the vendor's HTTP endpoint on `device.ip` and map its
     JSON response.
   - **MQTT** — `npm i mqtt`, subscribe to the device's topic in `connect()`, keep
     the latest message and return it from `read()`.
3. Return `{ weight, phase, bagCount, connected }` — that's the only contract the
   rest of the app relies on. Nothing in the backend or frontend needs to change.

## Reliability & give-away tracking (added for the first pilot plant)

- **Gateway buffering** — if the backend or network drops, the gateway keeps
  polling scales and writes unsent readings to `gateway/pending-readings.jsonl`
  instead of losing them. On reconnect it flushes the whole queue in order.
  Survives a gateway restart too, since the queue is a file, not memory.
  A backend outage can no longer crash the gateway — every network call in
  `gateway.js` is wrapped so a failure gets logged and retried, not thrown.
- **Give-away / loss tracking** — each device can have an optional cost-per-kg.
  The backend detects the moment a bag finishes filling (the phase transition
  to "settling", which is the one point where the reading reflects the actual
  final bag weight) and accumulates cumulative overfill (kg), underfill (kg),
  and estimated give-away cost. Add a "Give-away / loss" widget on the
  dashboard to see it live — this is usually the single most convincing number
  for a plant manager evaluating ROI.

## Client branding

`GET/PUT /api/branding` controls company name, tagline, logo URL, and accent
color — edit it from the "Branding" button on the dashboard itself, no code
changes needed. It's stored in Postgres (`kv_config` table) alongside alert
config, and applied on load (page title, header, logo, and every
accent-colored element in the UI via a single CSS variable).

This is currently one branding config per deployment — the simplest thing
that works for a single-plant pilot. If you later run multiple clients off
one shared backend, branding would move from a global config to something
keyed by tenant/org; the API shape wouldn't need to change, just where it
reads from.

## Alerting

Two independent conditions, both configurable from the "Alert settings" button:

- **Out-of-tolerance bags** — after N consecutive bags land more than X% off
  target, an alert fires (default: 3 bags, 3%). Resets the streak on the next
  good bag, and resolves the alert automatically.
- **Device silence** — if a device hasn't sent *any* reading in the configured
  timeout (default 10s), a `no_data` alert fires. This is separate from a
  reading explicitly saying `connected: false` (which alerts immediately,
  since the scale/gateway is still reachable enough to report its own
  status) — silence catches the case where the gateway itself is down or the
  network is cut entirely.

Active alerts show as a banner at the top of the dashboard and update live
over the WebSocket. Full history (including resolved alerts) is in the
"Alerts" panel.

**Webhook** — set a URL in Alert settings and every trigger/resolve gets
POSTed there as `{event: "alert.triggered" | "alert.resolved", alert}`. Point
it at a Slack incoming webhook, Zapier, PagerDuty, or your own endpoint to
get notifications outside the dashboard. Delivery is fire-and-forget — a
slow or unreachable webhook never blocks reading ingestion.

## Product management & weight tolerance

Products define what a scale's output should look like — set once, then
assign to any device instead of hand-tuning each scale's target/tolerance:

- **Fields**: code, name, description, target weight, min/max weight, unit,
  tolerance (absolute ±kg or percentage ±%), status (active/inactive/draft).
- Set tolerance either way — enter a target + tolerance % and min/max are
  computed automatically, or enter min/max directly for an asymmetric band.
  Whichever you enter, the resolved min/max is what's actually used to
  classify readings.
- **Classification** — every completed bag on a product-assigned device gets
  classified `UNDER` / `PASS` / `OVER` against that band. This *replaces* the
  old generic percentage-deviation check for that device (devices with no
  product assigned keep working exactly as before, using their own target +
  the global tolerance %). Classification counts show up in bag stats, the
  "Bag classification" dashboard widget, and drive the same consecutive-bags
  alert as before — just measured against the product's real tolerance
  instead of a generic percentage.
- Manage products from the "Products" button; assign one to a device from
  the device onboarding wizard's first step (auto-fills target weight) or by
  editing the device directly.

## Maintenance management

Work orders per device, from the "Maintenance" button:

- Fields: work order number (auto-generated), status, scheduled/due date,
  recurrence interval, technician, notes, parts, labour hours/cost, downtime,
  attachments (referenced by name/URL — no file upload pipeline yet).
- Statuses: `SCHEDULED` → `IN_PROGRESS` → `COMPLETED` (or `CANCELLED` from
  either open state).
- **Recurring schedules** — set an interval when scheduling; completing that
  record automatically creates the next `SCHEDULED` record that many days
  out, with a new work order number. No need to re-enter a recurring PM
  schedule by hand.
- **Due reminders** — a device's most urgent scheduled item feeds into the
  same alert system as everything else: a warning as it approaches the
  configured reminder window (default 7 days), critical once overdue.

## Calibration management

Append-only calibration history per device, from the "Calibration" button:

- Fields: calibration date, next due date, certificate number/file
  reference, technician, calibration company, reference weight, actual
  weight. Error (absolute and %) is computed automatically; pass/fail is
  auto-suggested (±0.5% rule) but can be overridden per record.
- **Reminders** — a watchdog checks each device's most recent calibration
  record against its `nextCalibrationDate`: a warning inside the configured
  reminder window (default 14 days), critical once overdue. Logging a new
  calibration record naturally resolves the alert once its next-due date is
  far enough out.

## Engineering / maintenance mode

A deliberately restricted diagnostic area, reachable from the red
"Engineering mode" button (manager+ only). Everything here is read-only
except one specific action:

- **Read-only for manager+**: raw data view (latest simulated payload), test
  connection, test a configured data point, communication log (rolling
  history of both real gateway traffic and manual tests), view current
  protocol/register configuration.
- **The one write path — admin-only, confirmation-gated**: editing a
  device's protocol/register configuration. The API rejects the request
  outright unless the body includes `confirm: true` — there is no way to
  trigger it with a single click, and it is never available to non-admins
  regardless of what the UI shows. This writes to the *stored configuration*
  only; there is currently no path from here (or anywhere else) to writing
  to a physical scale, since the protocol drivers only implement `read()`. If
  a write capability to real hardware is ever added, it must go through this
  same confirm-gated, admin-only pattern — never bypass it for convenience.

## Configuration templates & device onboarding wizard

Templates (seeded with generics for Modbus TCP, OPC-UA, REST API, and MQTT,
matching the register-map conventions in "Connecting real scales" above) let
a technician skip re-entering protocol/port/register/polling details for
every scale. Manage custom ones from the "Templates" button — built-ins
can't be deleted, only superseded by picking a different one in the wizard.

"+ Add device" now opens a 7-step wizard instead of a bare form:

1. **Device information** — name, IP, optional product assignment (autofills
   target weight), cost/kg.
2. **Protocol** — pick a template (prefills everything below) or set
   protocol/port/polling manually.
3. **Connection** — test reachability before going further. Simulated until
   a real driver is wired in, but structured identically to what a real
   result would look like.
4. **Data point configuration** — register/node/path/topic + data type,
   fields adapt to the selected protocol.
5. **Read test** — actually read the configured data point once and show
   the value that came back.
6. **Validation** — a checklist (name/IP set, protocol chosen, connection
   test passed, data point read successfully, target weight valid) with a
   clear pass/fail verdict.
7. **Activate** — review, then create the device. This is the only step that
   actually persists anything — steps 1–6 are working with in-memory wizard
   state, so canceling partway through leaves nothing behind.

## Multi-site sync — local instance + cloud, both databases in sync

Answers the "no internet at all" and "local dashboard" questions properly:
run a **full instance on-site** (its own Postgres, its own dashboard, works
with zero internet dependency for day-to-day operation) that pushes its data
up to a **cloud instance** whenever it can reach it. Same backend/frontend
codebase both places — which role an instance plays is a runtime config
choice (`SYNC_ROLE`), not a different deployment.

### Setup

**On the cloud instance** (log in as admin, needs the admin role since a
sync key has broad access — see "What syncs" below):

1. Open the "Sync" panel on the dashboard.
2. Create a sync key, giving the site an ID (e.g. `durban-plant`) and a
   display label (e.g. "Durban Plant"). The full key is shown once.

**On the site's local instance** (`backend/.env`):

```bash
SYNC_ROLE=local
CLOUD_SYNC_URL=https://your-cloud-backend.example.com
CLOUD_SYNC_KEY=<the key from step 2>
SYNC_INTERVAL_MS=15000   # how often to push, default 15s
```

Restart the local instance. Its "Sync" panel now shows the role, target
cloud URL, and how many records are currently buffered waiting to push
(0 in steady state; a growing number during an outage is expected and
correct — see below).

Point the site's **gateway** at the **local** instance's URL, not the
cloud's — that's what makes the site work with zero internet dependency for
day-to-day operation. The local instance is a completely normal, fully
functional instance of everything else in this README; sync is additive on
top of it, not a replacement for anything.

### What syncs, and why some things deliberately don't

**Syncs up to the cloud:** devices, products, give-away/loss stats, alerts,
maintenance records, calibration records, audit log.

**Stays local only, on purpose:**
- **Users, gateway keys** — security-sensitive; a compromised cloud
  shouldn't be able to touch a site's credentials, and vice versa.
- **Branding, alert config** — these are legitimately per-instance settings;
  a site's alert tolerances and a cloud rollup's branding aren't the same
  thing and shouldn't be forced to match.
- **Raw high-frequency readings** — only the aggregated give-away stats sync,
  not every individual poll. Syncing every raw reading from every site would
  dominate sync volume for little benefit; the cloud gets the numbers that
  matter (bags, over/under, cost) without the firehose. If you need raw
  historical readings from a specific site, that's on the local instance's
  own `readings` table — accessible via `GET /devices/:id/readings-range`
  when reachable, or directly against that site's Postgres.

### How it works

- **The outbox pattern** — every mutation on a `local` instance appends a row
  to a `sync_outbox` table instead of a separate queue file. The local
  Postgres database itself is the buffer; nothing extra to manage. A push
  failure just leaves those rows unsynced, retried on the next interval —
  same "buffer and retry" philosophy as the gateway's reading queue, just at
  the database level instead of a file.
- **ID prefixing avoids collisions** — a device's local ID becomes
  `<site-id>:<local-id>` on the cloud side, and every reference to it
  (in stats, alerts, maintenance, calibration records) is prefixed the same
  way, so multiple sites can sync into one cloud instance without ever
  clashing. Synced device names are also prefixed with `[Site Label]` so
  they're visually distinguishable in a multi-site cloud dashboard.
- **Idempotent and safe to retry** — every synced record carries its own
  stable (prefixed) ID and is applied as an upsert (`INSERT ... ON CONFLICT
  DO UPDATE`), so resending the same batch after a retry never creates
  duplicates or corrupts state.
- **Per-record success tracking** — the cloud's `/api/sync/push` reports
  which specific records in a batch succeeded or failed; the local agent
  only marks the successful ones as synced. A record that fails stays in
  the outbox and retries next interval rather than silently vanishing.

### What this doesn't handle

Only one direction — local pushes up, nothing flows back down. If you edit
something on the cloud dashboard for a synced device (unlikely to be useful
anyway, since synced devices are read-mostly reflections of the site's own
data), that change stays on the cloud and isn't pushed back to the site.
This is deliberate: the site is always the source of truth for its own data,
which avoids real conflict-resolution problems (what happens if the same
record changes in both places at once?) that a bidirectional sync would
require solving. If you need the cloud to *push configuration to* sites
(e.g. centrally managing alert thresholds across many sites), that's a
different, not-yet-built feature — say so if you need it.

## Edge gateway deployment

Packaged for real on-site installation, not just `npm start` in a terminal
someone has to remember to restart. See **`gateway/EDGE_DEPLOYMENT.md`** for
the full guide. Summary:

- **Docker** (`gateway/Dockerfile` + `docker-compose.yml`) — `docker compose
  up -d`, runs as non-root, persistent volume for the reading buffer so an
  update never loses data queued during a backend outage.
- **systemd** (`gateway/deploy/`) — for sites that avoid Docker on
  control-adjacent hardware. `sudo bash deploy/install.sh` sets up a
  dedicated unprivileged user and an auto-restarting service.
- **Health endpoint** — `GET http://<gateway-host>:9090/healthz` reports
  connected devices, backend reachability, and buffer size, for whatever
  monitoring the site already runs. Local-only by design (never internet-facing).

Confirms the hybrid architecture question is a non-issue in practice: the
gateway is outbound-only, so it works from behind any site firewall/NAT
without opening a single inbound port, regardless of whether the backend is
cloud-hosted or on-prem.

## Next steps toward production

- Wire the Reports panel's PDF/CSV buttons up to `readings-range` for actual
  date-range reports (e.g. "last shift", "last 7 days") instead of only
  "cumulative since reset" — the data's there now, this is UI + query work.
- Containerize the **backend** too (the gateway is now packaged — see "Edge
  gateway deployment" above — but the backend itself still just runs via
  `npm start`; a Dockerfile for it is the natural next piece).
- Wire a real protocol driver (Modbus/OPC-UA/REST/MQTT) to an actual scale —
  everything upstream of `gateway/drivers/` is unaffected by this, including
  the engineering-mode diagnostics and the wizard's connection/read tests.
- Real file uploads for maintenance attachments and calibration certificates
  (currently name/URL references only).
- Password reset / "forgot password" flow for dashboard users.
- The `readings` table will grow unbounded with no retention policy yet —
  fine for a pilot, but worth adding a cutoff (or a TimescaleDB continuous
  aggregate) before this runs for months unattended. Same applies to
  `sync_outbox` on a `local` instance — successfully synced rows stay in the
  table (marked `synced_at`) rather than being deleted, which is useful for
  debugging but will also grow unbounded over time.
- Sync is one-directional (local → cloud) by design — see "What this doesn't
  handle" in the sync section above if you need centralized config push
  instead of/in addition to that.
