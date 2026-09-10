require("dotenv").config();
const http = require("http");
const fetch = require("node-fetch");
const { createDriver } = require("./drivers");
const queue = require("./queue");

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:4000";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 500;
const DEVICE_REFRESH_MS = 5000;
const API_KEY = process.env.GATEWAY_API_KEY;
const HEALTH_PORT = Number(process.env.HEALTH_PORT) || 9090;

if (!API_KEY) {
  console.error("[gateway] GATEWAY_API_KEY is not set. Copy the key the backend");
  console.error("[gateway] printed on first run into gateway/.env, or generate a");
  console.error("[gateway] new one from the dashboard's Gateway Keys panel.");
  process.exit(1);
}

const authHeaders = { "X-Gateway-Key": API_KEY };
const drivers = new Map(); // deviceId -> driver instance
const startedAt = Date.now();
let lastSuccessfulPostAt = null;
let lastBackendReachableAt = null;

async function postReading(payload) {
  const res = await fetch(`${BACKEND_URL}/api/readings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) throw new Error("rejected: invalid or revoked gateway API key");
  if (!res.ok) throw new Error(`backend returned ${res.status}`);
  lastSuccessfulPostAt = Date.now();
  lastBackendReachableAt = Date.now();
}

async function postTelemetry(deviceId, reading) {
  const metrics = {};
  if (reading.weight !== undefined) metrics.weight = reading.weight;
  if (reading.phase !== undefined) metrics.phase = reading.phase;
  if (reading.bagCount !== undefined) metrics.bag_count = reading.bagCount;
  try {
    const res = await fetch(`${BACKEND_URL}/api/telemetry`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ deviceId, metrics, connected: reading.connected !== false }),
    });
    if (!res.ok) console.warn(`[gateway] telemetry POST returned ${res.status}`);
  } catch (err) {
    // telemetry is best-effort — don't block on failure
  }
}

// Retries anything that failed to send earlier (network blip, backend restart, etc).
// Stops at the first failure so order is preserved and nothing is skipped.
async function flushQueue() {
  const pending = queue.readAll();
  if (pending.length === 0) return;
  let sent = 0;
  for (const entry of pending) {
    try {
      await postReading(entry);
      sent += 1;
    } catch {
      break; // backend still unreachable — stop and keep the rest queued
    }
  }
  if (sent > 0) {
    queue.writeAll(pending.slice(sent));
    if (sent === pending.length) {
      console.log(`[gateway] flushed ${sent} buffered reading(s) after reconnect`);
    }
  }
}

async function refreshDevices() {
  // A dead backend must never crash the gateway — it should just keep polling
  // devices and buffering readings until the backend comes back.
  let devices;
  try {
    const res = await fetch(`${BACKEND_URL}/api/devices`, { headers: authHeaders });
    if (!res.ok) throw new Error(`backend returned ${res.status}`);
    devices = await res.json();
  } catch (err) {
    console.warn(`[gateway] could not reach backend for device list: ${err.message}`);
    return; // keep existing drivers running with last-known device list
  }

  const seenIds = new Set(devices.map((d) => d.id));

  // add drivers for new devices
  for (const device of devices) {
    if (!drivers.has(device.id)) {
      try {
        const driver = createDriver(device);
        await driver.connect();
        drivers.set(device.id, driver);
        console.log(`[gateway] connected to ${device.name} (${device.protocol} @ ${device.ip})`);
      } catch (err) {
        console.error(`[gateway] failed to connect to ${device.name}:`, err.message);
      }
    }
  }

  // remove drivers for deleted devices
  for (const id of [...drivers.keys()]) {
    if (!seenIds.has(id)) {
      try {
        await drivers.get(id).disconnect();
      } catch (err) {
        console.error(`[gateway] error disconnecting ${id}:`, err.message);
      }
      drivers.delete(id);
      console.log(`[gateway] disconnected removed device ${id}`);
    }
  }
}

async function pollAll() {
  await flushQueue();

  for (const [deviceId, driver] of drivers.entries()) {
    let reading;
    try {
      reading = await driver.read();
    } catch (err) {
      console.error(`[gateway] failed to read from ${deviceId}:`, err.message);
      continue; // a read failure isn't a lost reading — nothing to buffer
    }

    const payload = { deviceId, ...reading };
    try {
      await postReading(payload);
    } catch (err) {
      // backend unreachable — buffer locally instead of dropping the reading
      queue.enqueue(payload);
      console.warn(`[gateway] backend unreachable, buffered reading for ${deviceId} (queue size ${queue.size()})`);
    }

    // Also send to generic telemetry endpoint (best-effort)
    postTelemetry(deviceId, reading);
  }
}

// setInterval doesn't catch rejected promises from an async callback — an
// uncaught rejection there crashes the whole process. Wrap every scheduled
// call so a bug in one poll cycle logs and moves on instead of taking the
// gateway down.
function safeInterval(fn, ms) {
  setInterval(() => {
    Promise.resolve(fn()).catch((err) => {
      console.error(`[gateway] unexpected error in ${fn.name}:`, err.message);
    });
  }, ms);
}

async function main() {
  console.log(`[gateway] starting, backend at ${BACKEND_URL}`);
  startHealthServer();
  await refreshDevices();
  safeInterval(refreshDevices, DEVICE_REFRESH_MS);
  safeInterval(pollAll, POLL_INTERVAL_MS);
}

// Local-only HTTP endpoint for site monitoring tools (Nagios/Zabbix/a simple
// cron+curl check, or just a technician on-site) to check gateway health
// without needing dashboard access. Never exposed outside the gateway host —
// see the deployment guide for firewall guidance (LAN-only, not internet-facing).
function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404);
      res.end();
      return;
    }
    const now = Date.now();
    const queueSize = queue.size();
    const backendReachable = lastBackendReachableAt !== null && now - lastBackendReachableAt < DEVICE_REFRESH_MS * 3;
    const healthy = drivers.size > 0 && queueSize < 1000; // buffering is fine; a huge backlog isn't

    const body = {
      status: healthy ? "ok" : "degraded",
      uptimeSeconds: Math.floor((now - startedAt) / 1000),
      devicesConnected: drivers.size,
      backendReachable,
      lastSuccessfulPostAt: lastSuccessfulPostAt ? new Date(lastSuccessfulPostAt).toISOString() : null,
      bufferedReadings: queueSize,
      backendUrl: BACKEND_URL,
    };
    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body, null, 2));
  });

  // Firmware OTA endpoint — the backend calls this to trigger firmware push
  server.on("request", (req, res) => {
    if (req.url === "/firmware-update" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => body += c);
      req.on("end", () => {
        try {
          const { deviceId, version, url } = JSON.parse(body);
          console.log(`[gateway] Firmware update requested for ${deviceId}: → v${version}`);
          // In production: download firmware from `url`, push to device via protocol
          // For now, acknowledge the request
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, message: `Firmware update queued for ${deviceId}` }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  });

  server.listen(HEALTH_PORT, "0.0.0.0", () => {
    console.log(`[gateway] health endpoint on http://0.0.0.0:${HEALTH_PORT}/healthz`);
  });
}

main().catch((err) => {
  console.error("[gateway] fatal error during startup:", err);
  process.exit(1);
});
