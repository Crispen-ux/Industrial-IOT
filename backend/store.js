// Postgres-backed persistence layer (Neon or any standard Postgres).
//
// Durable, queryable data lives in Postgres: devices, widgets, products,
// users, gateway keys, maintenance/calibration records, templates, branding,
// alert config, audit log, alert history, give-away/loss stats, and reading
// history.
//
// Genuinely ephemeral, high-frequency, or fast-lookup state stays in memory
// on purpose — persisting it would add DB round-trips to the hot path for no
// real benefit:
//   - the live-sparkline ring buffer (last ~30 readings per device) — every
//     reading is still durably written to the `readings` table below, this
//     is just a fast cache for the dashboard's trend widget
//   - out-of-tolerance consecutive-bag streak counters
//   - engineering-mode communication logs (diagnostic scrollback, not data
//     anyone needs after a restart)
//   - the active-alerts index (fast key lookup on every reading) — but it's
//     rehydrated from `alert_history` on startup, so an active alert isn't
//     lost across a restart, only the fast-lookup index is rebuilt.

const db = require("./db");

const MAX_READINGS_PER_DEVICE = 300; // in-memory sparkline cache, not the durable history
const MAX_COMM_LOG_PER_DEVICE = 100;

const DEFAULT_BRANDING = {
  companyName: "Scale Ops",
  tagline: "Fill Line Monitoring",
  logoUrl: "",
  accentColor: "#F2B705",
};

const DEFAULT_ALERT_CONFIG = {
  toleranceThresholdPercent: 3,
  consecutiveBagsThreshold: 3,
  offlineTimeoutSeconds: 10,
  webhookUrl: "",
  calibrationReminderDays: 14,
  maintenanceReminderDays: 7,
};

const DEFAULT_TEMPLATES = [
  {
    id: "tmpl_modbus_generic",
    name: "Generic Modbus Weight Scale",
    protocol: "Modbus TCP",
    port: 502,
    registerMap: { weight: { register: "40001", dataType: "Float32" } },
    unit: "kg",
    pollingMs: 500,
    builtIn: true,
  },
  {
    id: "tmpl_opcua_generic",
    name: "Generic OPC-UA Weight Scale",
    protocol: "OPC-UA",
    port: 4840,
    registerMap: { weight: { nodeId: "ns=2;s=Weight", dataType: "Float32" } },
    unit: "kg",
    pollingMs: 500,
    builtIn: true,
  },
  {
    id: "tmpl_rest_generic",
    name: "Generic REST Weight Scale",
    protocol: "REST API",
    port: 80,
    registerMap: { weight: { path: "/api/weight", jsonField: "weight_kg", dataType: "Float32" } },
    unit: "kg",
    pollingMs: 1000,
    builtIn: true,
  },
  {
    id: "tmpl_mqtt_generic",
    name: "Generic MQTT Weight Scale",
    protocol: "MQTT",
    port: 1883,
    registerMap: { weight: { topic: "scale/weight", dataType: "Float32" } },
    unit: "kg",
    pollingMs: 500,
    builtIn: true,
  },
];

// ---------- in-memory ephemeral state ----------
const readings = new Map(); // deviceId -> array (sparkline cache)
const toleranceStreaks = new Map(); // deviceId -> consecutive out-of-tolerance count
const activeAlerts = new Map(); // `${deviceId}:${type}` -> alert row (rehydrated on startup)
const commLogs = new Map(); // deviceId -> array

function alertKey(deviceId, type) {
  return `${deviceId}:${type}`;
}

function emptyStats(deviceId) {
  return { deviceId, totalBags: 0, totalOverKg: 0, totalUnderKg: 0, totalCost: 0, countUnder: 0, countPass: 0, countOver: 0, since: new Date().toISOString() };
}

function classifyWeight(weight, product) {
  if (weight < product.minWeight) return "UNDER";
  if (weight > product.maxWeight) return "OVER";
  return "PASS";
}

function normalizeProductBounds(input) {
  const target = Number(input.targetWeight);
  const toleranceType = input.toleranceType === "percentage" ? "percentage" : "absolute";
  const toleranceValue = Number(input.toleranceValue);
  let minWeight, maxWeight;
  if (toleranceType === "percentage") {
    minWeight = target * (1 - toleranceValue / 100);
    maxWeight = target * (1 + toleranceValue / 100);
  } else {
    minWeight = target - toleranceValue;
    maxWeight = target + toleranceValue;
  }
  if (input.minWeight !== undefined && input.minWeight !== null && input.minWeight !== "") minWeight = Number(input.minWeight);
  if (input.maxWeight !== undefined && input.maxWeight !== null && input.maxWeight !== "") maxWeight = Number(input.maxWeight);
  return { targetWeight: target, toleranceType, toleranceValue, minWeight, maxWeight };
}

function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// Every mutation to a syncable entity appends one row here instead of a
// separate durable queue file — local Postgres itself is the buffer (see
// sync_outbox in schema.sql). Not part of the public store API; called
// internally from the mutating methods below.
async function enqueueSyncOutbox(entityType, entityId, operation, payload) {
  await db.query(
    "INSERT INTO sync_outbox (entity_type, entity_id, operation, payload) VALUES ($1,$2,$3,$4)",
    [entityType, entityId, operation, payload ? JSON.stringify(payload) : null]
  );
}

// ---------- row <-> object mapping helpers ----------
// Postgres columns are snake_case; the rest of the app (server.js, frontend)
// speaks camelCase JSON, same as before the migration.

function deviceFromRow(r) {
  return {
    id: r.id, name: r.name, ip: r.ip, protocol: r.protocol,
    target: Number(r.target), unit: r.unit, costPerUnit: Number(r.cost_per_unit),
    productId: r.product_id, connectionConfig: r.connection_config,
    createdAt: r.created_at,
  };
}
function productFromRow(r) {
  return {
    id: r.id, code: r.code, name: r.name, description: r.description,
    targetWeight: Number(r.target_weight), minWeight: Number(r.min_weight), maxWeight: Number(r.max_weight),
    unit: r.unit, toleranceType: r.tolerance_type, toleranceValue: Number(r.tolerance_value),
    status: r.status, createdAt: r.created_at,
  };
}
function widgetFromRow(r) {
  return { id: r.id, deviceId: r.device_id, metric: r.metric };
}
function userFromRow(r) {
  return { id: r.id, username: r.username, passwordHash: r.password_hash, role: r.role, twoFactorEnabled: r.two_factor_enabled || false, createdAt: r.created_at };
}
function gatewayKeyFromRow(r) {
  return { id: r.id, key: r.key, label: r.label, createdAt: r.created_at };
}
function maintenanceFromRow(r) {
  return {
    id: r.id, deviceId: r.device_id, workOrderNumber: r.work_order_number, status: r.status,
    maintenanceType: r.maintenance_type, priority: r.priority,
    scheduledDate: r.scheduled_date, dueDate: r.due_date, intervalDays: r.interval_days,
    technician: r.technician, notes: r.notes,
    failureMode: r.failure_mode, rootCause: r.root_cause,
    parts: r.parts, labourHours: Number(r.labour_hours),
    labourCost: Number(r.labour_cost), partsCost: Number(r.parts_cost || 0), totalCost: Number(r.total_cost || 0),
    downtimeMinutes: Number(r.downtime_minutes), attachments: r.attachments, metadata: r.metadata,
    createdAt: r.created_at, completedAt: r.completed_at,
  };
}
function calibrationFromRow(r) {
  return {
    id: r.id, deviceId: r.device_id, calibrationDate: r.calibration_date, nextCalibrationDate: r.next_calibration_date,
    certificateNumber: r.certificate_number, certificateFileUrl: r.certificate_file_url, technician: r.technician,
    calibrationCompany: r.calibration_company, referenceWeight: Number(r.reference_weight), actualWeight: Number(r.actual_weight),
    error: Number(r.error), errorPercent: Number(r.error_percent), passFail: r.pass_fail, notes: r.notes, createdAt: r.created_at,
  };
}
function templateFromRow(r) {
  return { id: r.id, name: r.name, protocol: r.protocol, port: r.port, registerMap: r.register_map, unit: r.unit, pollingMs: r.polling_ms, builtIn: r.built_in };
}
function alertFromRow(r) {
  return { id: r.id, deviceId: r.device_id, deviceName: r.device_name, type: r.type, message: r.message, severity: r.severity, since: r.since, active: r.active, resolvedAt: r.resolved_at };
}
function downtimeFromRow(r) {
  return { id: r.id, deviceId: r.device_id, deviceName: r.device_name, startedAt: r.started_at, endedAt: r.ended_at, reasonCode: r.reason_code, reasonNote: r.reason_note, reportedBy: r.reported_by, createdAt: r.created_at };
}
function statsFromRow(r) {
  return {
    totalBags: r.total_bags, totalOverKg: Number(r.total_over_kg), totalUnderKg: Number(r.total_under_kg),
    totalCost: Number(r.total_cost), countUnder: r.count_under, countPass: r.count_pass, countOver: r.count_over,
    since: r.since,
  };
}

// ---------- schema migration + startup rehydration ----------

async function migrate() {
  const fs = require("fs");
  const path = require("path");
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await db.query(sql);

  // seed built-in templates if the templates table is empty
  const { rows } = await db.query("SELECT count(*) FROM templates");
  if (Number(rows[0].count) === 0) {
    for (const t of DEFAULT_TEMPLATES) {
      await db.query(
        `INSERT INTO templates (id, name, protocol, port, register_map, unit, polling_ms, built_in)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [t.id, t.name, t.protocol, t.port, JSON.stringify(t.registerMap), t.unit, t.pollingMs, t.builtIn]
      );
    }
  }

  // rehydrate the in-memory active-alerts index so a restart doesn't "lose"
  // an alert that's still genuinely active (e.g. a device still offline)
  const { rows: activeRows } = await db.query("SELECT * FROM alert_history WHERE active = true");
  for (const r of activeRows) {
    const alert = alertFromRow(r);
    activeAlerts.set(alertKey(alert.deviceId, alert.type), alert);
  }

  // seed device_stats / reading cache maps for any devices already on disk
  const { rows: deviceRows } = await db.query("SELECT id FROM devices");
  for (const d of deviceRows) {
    readings.set(d.id, []);
    await ensureStatsRow(d.id);
  }
}

async function ensureStatsRow(deviceId) {
  await db.query(
    `INSERT INTO device_stats (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING`,
    [deviceId]
  );
}

const store = {
  migrate,

  // --- devices ---
  async listDevices() {
    const { rows } = await db.query("SELECT * FROM devices ORDER BY created_at");
    return rows.map(deviceFromRow);
  },
  async getDevice(id) {
    const { rows } = await db.query("SELECT * FROM devices WHERE id = $1", [id]);
    return rows[0] ? deviceFromRow(rows[0]) : null;
  },
  async addDevice(device) {
    await db.query(
      `INSERT INTO devices (id, name, ip, protocol, target, unit, cost_per_unit, product_id, connection_config, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [device.id, device.name, device.ip, device.protocol, device.target, device.unit, device.costPerUnit,
       device.productId || null, device.connectionConfig ? JSON.stringify(device.connectionConfig) : null, device.createdAt]
    );
    readings.set(device.id, []);
    await ensureStatsRow(device.id);
    await enqueueSyncOutbox("device", device.id, "upsert", device);
    return device;
  },
  async updateDevice(id, partial) {
    const existing = await store.getDevice(id);
    if (!existing) return null;
    const merged = { ...existing, ...partial };
    await db.query(
      `UPDATE devices SET name=$2, ip=$3, protocol=$4, target=$5, unit=$6, cost_per_unit=$7, product_id=$8, connection_config=$9 WHERE id=$1`,
      [id, merged.name, merged.ip, merged.protocol, merged.target, merged.unit, merged.costPerUnit,
       merged.productId || null, merged.connectionConfig ? JSON.stringify(merged.connectionConfig) : null]
    );
    const updated = await store.getDevice(id);
    await enqueueSyncOutbox("device", id, "upsert", updated);
    return updated;
  },
  async removeDevice(id) {
    await db.query("DELETE FROM devices WHERE id = $1", [id]);
    await db.query("DELETE FROM widgets WHERE device_id = $1", [id]);
    await db.query("DELETE FROM device_stats WHERE device_id = $1", [id]);
    readings.delete(id);
    toleranceStreaks.delete(id);
    commLogs.delete(id);
    for (const key of [...activeAlerts.keys()]) {
      if (key.startsWith(`${id}:`)) activeAlerts.delete(key);
    }
    await db.query("UPDATE alert_history SET active=false WHERE device_id=$1 AND active=true", [id]);
    await enqueueSyncOutbox("device", id, "delete", null);
  },

  // --- widgets ---
  async listWidgets() {
    const { rows } = await db.query("SELECT * FROM widgets");
    return rows.map(widgetFromRow);
  },
  async addWidget(widget) {
    await db.query("INSERT INTO widgets (id, device_id, metric) VALUES ($1,$2,$3)", [widget.id, widget.deviceId, widget.metric]);
    return widget;
  },
  async removeWidget(id) {
    await db.query("DELETE FROM widgets WHERE id = $1", [id]);
  },

  // --- readings ---
  // Every reading is durably written to Postgres AND kept in a capped
  // in-memory array per device for the live sparkline widget, so the
  // dashboard never waits on a DB round-trip for something this frequent.
  async pushReading(deviceId, reading) {
    if (!readings.has(deviceId)) readings.set(deviceId, []);
    const arr = readings.get(deviceId);
    arr.push(reading);
    if (arr.length > MAX_READINGS_PER_DEVICE) arr.shift();
    await db.query(
      `INSERT INTO readings (device_id, weight, phase, bag_count, connected, ts) VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0))`,
      [deviceId, reading.weight, reading.phase, reading.bagCount, reading.connected, reading.ts]
    );
  },
  getReadings(deviceId, limit = 50) {
    // sparkline cache — synchronous, in-memory, recent-only by design
    const arr = readings.get(deviceId) || [];
    return arr.slice(-limit);
  },
  getLatest(deviceId) {
    const arr = readings.get(deviceId) || [];
    return arr[arr.length - 1] || null;
  },
  async getReadingsInRange(deviceId, fromIso, toIso) {
    // durable historical query — this is what a real database unlocks that
    // the in-memory ring buffer never could
    const { rows } = await db.query(
      `SELECT weight, phase, bag_count, connected, ts FROM readings
       WHERE device_id=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts`,
      [deviceId, fromIso, toIso]
    );
    return rows.map((r) => ({ weight: Number(r.weight), phase: r.phase, bagCount: r.bag_count, connected: r.connected, ts: r.ts }));
  },

  // --- bag-level give-away / loss tracking (persisted, not just in-memory) ---
  async recordBag(deviceId, finalWeight, target, costPerUnit, classification) {
    await ensureStatsRow(deviceId);
    const delta = finalWeight - target;
    const over = Math.max(delta, 0);
    const under = Math.max(-delta, 0);
    const under_inc = classification === "UNDER" ? 1 : 0;
    const pass_inc = classification === "PASS" ? 1 : 0;
    const over_inc = classification === "OVER" ? 1 : 0;
    const { rows } = await db.query(
      `UPDATE device_stats SET
         total_bags = total_bags + 1,
         total_over_kg = total_over_kg + $2,
         total_under_kg = total_under_kg + $3,
         total_cost = total_cost + $4,
         count_under = count_under + $5,
         count_pass = count_pass + $6,
         count_over = count_over + $7
       WHERE device_id = $1 RETURNING *`,
      [deviceId, over, under, over * (costPerUnit || 0), under_inc, pass_inc, over_inc]
    );
    const stats = statsFromRow(rows[0]);
    await enqueueSyncOutbox("device_stats", deviceId, "upsert", { deviceId, ...stats });
    return stats;
  },
  async getBagStats(deviceId) {
    await ensureStatsRow(deviceId);
    const { rows } = await db.query("SELECT * FROM device_stats WHERE device_id = $1", [deviceId]);
    return rows[0] ? statsFromRow(rows[0]) : emptyStats(deviceId);
  },
  async resetDeviceStats(deviceId) {
    await ensureStatsRow(deviceId);
    const { rows } = await db.query(
      `UPDATE device_stats SET total_bags=0, total_over_kg=0, total_under_kg=0, total_cost=0,
         count_under=0, count_pass=0, count_over=0, since=now() WHERE device_id=$1 RETURNING *`,
      [deviceId]
    );
    toleranceStreaks.set(deviceId, 0);
    const stats = statsFromRow(rows[0]);
    await enqueueSyncOutbox("device_stats", deviceId, "upsert", { deviceId, ...stats });
    return stats;
  },

  // --- branding ---
  async getBranding() {
    const { rows } = await db.query("SELECT value FROM kv_config WHERE key = 'branding'");
    return rows[0] ? { ...DEFAULT_BRANDING, ...rows[0].value } : { ...DEFAULT_BRANDING };
  },
  async setBranding(partial) {
    const current = await store.getBranding();
    const updated = { ...current, ...partial };
    await db.query(
      `INSERT INTO kv_config (key, value) VALUES ('branding', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
      [JSON.stringify(updated)]
    );
    return updated;
  },

  // --- JWT secret ---
  async getJwtSecret() {
    const { rows } = await db.query("SELECT value FROM kv_config WHERE key = 'jwtSecret'");
    return rows[0] ? rows[0].value.secret : null;
  },
  async setJwtSecret(secret) {
    await db.query(
      `INSERT INTO kv_config (key, value) VALUES ('jwtSecret', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
      [JSON.stringify({ secret })]
    );
  },

  // --- users ---
  async listUsers() {
    const { rows } = await db.query("SELECT * FROM users ORDER BY created_at");
    return rows.map(userFromRow);
  },
  async findUserByUsername(username) {
    const { rows } = await db.query("SELECT * FROM users WHERE username = $1", [username]);
    return rows[0] ? userFromRow(rows[0]) : null;
  },
  async findUserById(id) {
    const { rows } = await db.query("SELECT * FROM users WHERE id = $1", [id]);
    return rows[0] ? userFromRow(rows[0]) : null;
  },
  async addUser(user) {
    await db.query(
      "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ($1,$2,$3,$4,$5)",
      [user.id, user.username, user.passwordHash, user.role, user.createdAt]
    );
    return user;
  },
  async removeUser(id) {
    await db.query("DELETE FROM users WHERE id = $1", [id]);
  },
  async setUserRole(id, role) {
    const { rows } = await db.query("UPDATE users SET role=$2 WHERE id=$1 RETURNING *", [id, role]);
    return rows[0] ? userFromRow(rows[0]) : null;
  },
  async setUserPassword(id, passwordHash) {
    await db.query("UPDATE users SET password_hash=$2 WHERE id=$1", [id, passwordHash]);
  },
  async countAdmins() {
    const { rows } = await db.query("SELECT count(*) FROM users WHERE role='admin'");
    return Number(rows[0].count);
  },

  // --- 2FA ---
  async set2FASecret(userId, secret) {
    await db.query("UPDATE users SET two_factor_secret=$2 WHERE id=$1", [userId, secret]);
  },
  async enable2FA(userId) {
    await db.query("UPDATE users SET two_factor_enabled=true WHERE id=$1", [userId]);
  },
  async disable2FA(userId) {
    await db.query("UPDATE users SET two_factor_enabled=false, two_factor_secret=NULL WHERE id=$1", [userId]);
  },
  async get2FASecret(userId) {
    const { rows } = await db.query("SELECT two_factor_secret, two_factor_enabled FROM users WHERE id=$1", [userId]);
    return rows[0] ? { secret: rows[0].two_factor_secret, enabled: rows[0].two_factor_enabled } : null;
  },

  // --- sessions ---
  async createSession(userId, tokenHash, ip, userAgent, expiresAt) {
    const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      "INSERT INTO user_sessions (id, user_id, token_hash, ip, user_agent, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,now(),$6)",
      [id, userId, tokenHash, ip || null, userAgent || null, expiresAt]
    );
    return id;
  },
  async findSessionByToken(tokenHash) {
    const { rows } = await db.query("SELECT * FROM user_sessions WHERE token_hash = $1 AND expires_at > now()", [tokenHash]);
    return rows[0] || null;
  },
  async listUserSessions(userId) {
    const { rows } = await db.query("SELECT * FROM user_sessions WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
    return rows;
  },
  async removeSession(id) {
    await db.query("DELETE FROM user_sessions WHERE id = $1", [id]);
  },
  async removeUserSessions(userId) {
    await db.query("DELETE FROM user_sessions WHERE user_id = $1", [userId]);
  },
  async purgeExpiredSessions() {
    await db.query("DELETE FROM user_sessions WHERE expires_at < now()");
  },

  // --- scheduled reports ---
  async listScheduledReports() {
    const { rows } = await db.query("SELECT * FROM scheduled_reports ORDER BY created_at");
    return rows.map(r => ({ id: r.id, name: r.name, reportType: r.report_type, format: r.format, recipients: r.recipients, scheduleCron: r.schedule_cron, enabled: r.enabled, lastSentAt: r.last_sent_at, createdAt: r.created_at }));
  },
  async addScheduledReport(report) {
    const id = `sr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      `INSERT INTO scheduled_reports (id, name, report_type, format, recipients, schedule_cron, enabled, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
      [id, report.name, report.reportType, report.format || "pdf", report.recipients, report.scheduleCron, report.enabled !== false]
    );
    return { id, ...report, createdAt: new Date().toISOString() };
  },
  async removeScheduledReport(id) {
    await db.query("DELETE FROM scheduled_reports WHERE id = $1", [id]);
  },
  async markReportSent(id) {
    await db.query("UPDATE scheduled_reports SET last_sent_at = now() WHERE id = $1", [id]);
  },
  async getDueReports() {
    // Simple check: reports that are enabled and haven't been sent today
    const { rows } = await db.query(
      `SELECT * FROM scheduled_reports WHERE enabled = true AND (last_sent_at IS NULL OR last_sent_at < current_date)`
    );
    return rows;
  },

  // --- dashboard views ---
  async listDashboardViews(userId) {
    // Return shared views (user_id IS NULL) and the user's personal views
    const { rows } = await db.query(
      "SELECT * FROM dashboard_views WHERE user_id IS NULL OR user_id = $1 ORDER BY is_default DESC, name",
      [userId]
    );
    return rows.map(r => ({ id: r.id, name: r.name, isDefault: r.is_default, createdBy: r.created_by, userId: r.user_id, createdAt: r.created_at }));
  },
  async addDashboardView(name, createdBy, userId) {
    const id = `dv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const existing = await db.query("SELECT count(*) FROM dashboard_views");
    const isDefault = Number(existing.rows[0].count) === 0;
    await db.query(
      "INSERT INTO dashboard_views (id, name, is_default, user_id, created_by, created_at) VALUES ($1,$2,$3,$4,$5,now())",
      [id, name, isDefault, userId || null, createdBy]
    );
    return { id, name, isDefault, userId: userId || null, createdBy };
  },
  async removeDashboardView(id) {
    await db.query("DELETE FROM dashboard_views WHERE id = $1 AND is_default = false", [id]);
  },
  async duplicateDashboardView(sourceId, newName, userId) {
    const source = await db.query("SELECT * FROM dashboard_views WHERE id = $1", [sourceId]);
    if (!source.rows[0]) throw new Error("view not found");
    const newView = await this.addDashboardView(newName, userId, userId);
    // Copy all widgets from source view
    const widgets = await db.query("SELECT * FROM dashboard_widgets WHERE view_id = $1", [sourceId]);
    for (const w of widgets.rows) {
      await db.query(
        "INSERT INTO dashboard_widgets (id, view_id, device_id, metric, sort_order, x, y, w, h, scope_type, scope_id, config, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())",
        [`dw_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, newView.id, w.device_id, w.metric, w.sort_order, w.x, w.y, w.w, w.h, w.scope_type, w.scope_id, w.config]
      );
    }
    return newView;
  },
  async getDashboardWidgets(viewId) {
    const { rows } = await db.query("SELECT * FROM dashboard_widgets WHERE view_id = $1 ORDER BY y, x", [viewId]);
    return rows.map(r => ({
      id: r.id, deviceId: r.device_id, metric: r.metric, sortOrder: r.sort_order,
      x: r.x, y: r.y, w: r.w, h: r.h,
      scopeType: r.scope_type, scopeId: r.scope_id, config: r.config || {},
    }));
  },
  async addDashboardWidget(viewId, { deviceId, metric, x, y, w, h, scopeType, scopeId, config }) {
    const id = `dw_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const maxOrder = await db.query("SELECT COALESCE(MAX(sort_order),0)+1 as next FROM dashboard_widgets WHERE view_id=$1", [viewId]);
    await db.query(
      "INSERT INTO dashboard_widgets (id, view_id, device_id, metric, sort_order, x, y, w, h, scope_type, scope_id, config, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())",
      [id, viewId, deviceId, metric, maxOrder.rows[0].next, x || 0, y || 0, w || 4, h || 3, scopeType || "device", scopeId || null, JSON.stringify(config || {})]
    );
    return { id, viewId, deviceId, metric, x: x || 0, y: y || 0, w: w || 4, h: h || 3, scopeType: scopeType || "device", scopeId: scopeId || null, config: config || {} };
  },
  async updateDashboardWidget(id, updates) {
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, val] of Object.entries(updates)) {
      const col = { x: "x", y: "y", w: "w", h: "h", config: "config", deviceId: "device_id", metric: "metric", scopeType: "scope_type", scopeId: "scope_id" }[key];
      if (!col) continue;
      fields.push(`${col} = $${idx}`);
      values.push(key === "config" ? JSON.stringify(val) : val);
      idx++;
    }
    if (fields.length === 0) return;
    values.push(id);
    await db.query(`UPDATE dashboard_widgets SET ${fields.join(", ")} WHERE id = $${idx}`, values);
  },
  async removeDashboardWidget(id) {
    await db.query("DELETE FROM dashboard_widgets WHERE id = $1", [id]);
  },
  async reorderDashboardWidgets(viewId, widgetIds) {
    for (let i = 0; i < widgetIds.length; i++) {
      await db.query("UPDATE dashboard_widgets SET sort_order = $2 WHERE id = $1 AND view_id = $3", [widgetIds[i], i, viewId]);
    }
  },

  // --- device groups ---
  async listDeviceGroups() {
    const { rows } = await db.query("SELECT * FROM device_groups ORDER BY sort_order, name");
    return rows.map(r => ({ id: r.id, name: r.name, parentId: r.parent_id, color: r.color, sortOrder: r.sort_order, createdAt: r.created_at }));
  },
  async addDeviceGroup(name, parentId, color) {
    const id = `dg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const maxOrder = await db.query("SELECT COALESCE(MAX(sort_order),0)+1 as next FROM device_groups");
    await db.query(
      "INSERT INTO device_groups (id, name, parent_id, color, sort_order, created_at) VALUES ($1,$2,$3,$4,$5,now())",
      [id, name, parentId || null, color || "#3B82F6", maxOrder.rows[0].next]
    );
    return { id, name, parentId: parentId || null, color: color || "#3B82F6" };
  },
  async removeDeviceGroup(id) {
    // Move devices in this group to no group
    await db.query("UPDATE devices SET group_id = NULL WHERE group_id = $1", [id]);
    // Move child groups to top level
    await db.query("UPDATE device_groups SET parent_id = NULL WHERE parent_id = $1", [id]);
    await db.query("DELETE FROM device_groups WHERE id = $1", [id]);
  },
  async assignDeviceToGroup(deviceId, groupId) {
    await db.query("UPDATE devices SET group_id = $2 WHERE id = $1", [deviceId, groupId || null]);
  },

  // --- alert workflows (snooze/acknowledge) ---
  async snoozeAlert(id, snoozeUntil) {
    await db.query("UPDATE alert_history SET snoozed_until = $2 WHERE id = $1", [id, snoozeUntil]);
    // Also update in-memory active alerts
    for (const [key, alert] of activeAlerts) {
      if (alert.id === id) alert.snoozedUntil = snoozeUntil;
    }
  },
  async acknowledgeAlert(id, username) {
    await db.query("UPDATE alert_history SET acknowledged_by = $2, acknowledged_at = now(), active = false, resolved_at = now() WHERE id = $1", [id, username]);
    for (const [key, alert] of activeAlerts) {
      if (alert.id === id) { activeAlerts.delete(key); }
    }
  },
  async isAlertSnoozed(id) {
    const { rows } = await db.query("SELECT snoozed_until FROM alert_history WHERE id = $1", [id]);
    if (!rows[0] || !rows[0].snoozed_until) return false;
    return new Date(rows[0].snoozed_until) > new Date();
  },

  // --- production schedules ---
  async listProductionSchedules(filters = {}) {
    let query = "SELECT * FROM production_schedules";
    const params = [];
    const conditions = [];
    if (filters.deviceId) { params.push(filters.deviceId); conditions.push(`device_id = $${params.length}`); }
    if (filters.from) { params.push(filters.from); conditions.push(`shift_date >= $${params.length}`); }
    if (filters.to) { params.push(filters.to); conditions.push(`shift_date <= $${params.length}`); }
    if (conditions.length) query += " WHERE " + conditions.join(" AND ");
    query += " ORDER BY shift_date DESC, shift_name";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, deviceId: r.device_id, productId: r.product_id, shiftName: r.shift_name, shiftDate: r.shift_date, plannedBags: r.planned_bags, actualBags: r.actual_bags, plannedStart: r.planned_start, plannedEnd: r.planned_end, actualStart: r.actual_start, actualEnd: r.actual_end, status: r.status, notes: r.notes, createdAt: r.created_at }));
  },
  async addProductionSchedule(sched) {
    const id = `ps_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      `INSERT INTO production_schedules (id, device_id, product_id, shift_name, shift_date, planned_bags, planned_start, planned_end, status, notes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
      [id, sched.deviceId, sched.productId || null, sched.shiftName, sched.shiftDate, sched.plannedBags || 0, sched.plannedStart || null, sched.plannedEnd || null, sched.status || "planned", sched.notes || null]
    );
    return { id, ...sched };
  },
  async updateProductionSchedule(id, updates) {
    const fields = [];
    const params = [id];
    let idx = 2;
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined) { fields.push(`${k} = $${idx}`); params.push(v); idx++; }
    }
    if (!fields.length) return null;
    await db.query(`UPDATE production_schedules SET ${fields.join(", ")} WHERE id = $1`, params);
    const { rows } = await db.query("SELECT * FROM production_schedules WHERE id = $1", [id]);
    return rows[0] ? { id: rows[0].id, deviceId: rows[0].device_id, productId: rows[0].product_id, shiftName: rows[0].shift_name, shiftDate: rows[0].shift_date, plannedBags: rows[0].planned_bags, actualBags: rows[0].actual_bags, status: rows[0].status } : null;
  },
  async removeProductionSchedule(id) {
    await db.query("DELETE FROM production_schedules WHERE id = $1", [id]);
  },

  // --- firmware updates ---
  async updateDeviceFirmware(deviceId, version, url) {
    const sets = [];
    const params = [deviceId];
    let idx = 2;
    if (version) { sets.push(`firmware_version = $${idx}`); params.push(version); idx++; }
    if (url) { sets.push(`firmware_url = $${idx}`); params.push(url); idx++; }
    if (sets.length) await db.query(`UPDATE devices SET ${sets.join(", ")} WHERE id = $1`, params);
  },
  async logFirmwareUpdate(deviceId, fromVersion, toVersion) {
    const id = `fw_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      `INSERT INTO firmware_updates (id, device_id, from_version, to_version, status, started_at, created_at) VALUES ($1,$2,$3,$4,'pending',now(),now())`,
      [id, deviceId, fromVersion, toVersion]
    );
    return { id, deviceId, fromVersion, toVersion, status: "pending" };
  },
  async updateFirmwareStatus(id, status, error) {
    const extras = status === "completed" ? ", completed_at = now()" : "";
    await db.query(`UPDATE firmware_updates SET status = $2, error = $3${extras} WHERE id = $1`, [id, status, error || null]);
  },
  async listFirmwareUpdates(deviceId) {
    const query = deviceId
      ? "SELECT * FROM firmware_updates WHERE device_id = $1 ORDER BY created_at DESC LIMIT 20"
      : "SELECT * FROM firmware_updates ORDER BY created_at DESC LIMIT 50";
    const params = deviceId ? [deviceId] : [];
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, deviceId: r.device_id, fromVersion: r.from_version, toVersion: r.to_version, status: r.status, startedAt: r.started_at, completedAt: r.completed_at, error: r.error }));
  },

  // --- GDPR ---
  async logConsent(userId, action, detail, ip) {
    const id = `gc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      "INSERT INTO gdpr_consent_log (id, user_id, action, detail, ip, created_at) VALUES ($1,$2,$3,$4,$5,now())",
      [id, userId, action, detail || null, ip || null]
    );
  },
  async getConsentLog(userId) {
    const { rows } = await db.query("SELECT * FROM gdpr_consent_log WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
    return rows.map(r => ({ id: r.id, userId: r.user_id, action: r.action, detail: r.detail, ip: r.ip, createdAt: r.created_at }));
  },
  async exportUserData(userId) {
    // Export all data associated with a user
    const user = await this.findUserById(userId);
    const sessions = await this.listUserSessions(userId);
    const consent = await this.getConsentLog(userId);
    // Readings and alerts are device-level, not user-level, but we export what we can
    return { user: user ? { username: user.username, role: user.role, createdAt: user.createdAt } : null, sessions, consent, exportedAt: new Date().toISOString() };
  },
  async anonymizeUser(userId) {
    const hash = require("crypto").createHash("sha256").update(userId).digest("hex").slice(0, 12);
    await db.query("UPDATE users SET username = $2, password_hash = 'ANONYMIZED' WHERE id = $1", [userId, `anonymized_${hash}`]);
    await db.query("DELETE FROM user_sessions WHERE user_id = $1", [userId]);
  },
  async deleteUser(userId) {
    await db.query("DELETE FROM user_sessions WHERE user_id = $1", [userId]);
    await db.query("DELETE FROM gdpr_consent_log WHERE user_id = $1", [userId]);
    await db.query("DELETE FROM users WHERE id = $1", [userId]);
  },

  // --- SSO Providers ---
  async listSSOProviders() {
    const { rows } = await db.query("SELECT * FROM sso_providers ORDER BY created_at");
    return rows.map(r => ({ id: r.id, name: r.name, type: r.type, issuerUrl: r.issuer_url, clientId: r.client_id, redirectUrl: r.redirect_url, enabled: r.enabled, defaultRole: r.default_role }));
  },
  async createSSOProvider(provider) {
    const id = `sso_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      "INSERT INTO sso_providers (id, name, type, issuer_url, client_id, client_secret, redirect_url, enabled, default_role, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())",
      [id, provider.name, provider.type || "oidc", provider.issuerUrl || null, provider.clientId || null, provider.clientSecret || null, provider.redirectUrl || null, provider.enabled !== false, provider.defaultRole || "viewer"]
    );
    return { id, ...provider };
  },
  async updateSSOProvider(id, provider) {
    const sets = [];
    const params = [id];
    let idx = 2;
    for (const [k, v] of Object.entries(provider)) {
      if (v !== undefined && k !== "id") {
        const col = k === "issuerUrl" ? "issuer_url" : k === "clientId" ? "client_id" : k === "clientSecret" ? "client_secret" : k === "redirectUrl" ? "redirect_url" : k === "defaultRole" ? "default_role" : k;
        sets.push(`${col} = $${idx}`); params.push(v); idx++;
      }
    }
    if (sets.length) await db.query(`UPDATE sso_providers SET ${sets.join(", ")} WHERE id = $1`, params);
  },
  async deleteSSOProvider(id) {
    await db.query("DELETE FROM sso_providers WHERE id = $1", [id]);
  },
  async findSSOProviderByName(name) {
    const { rows } = await db.query("SELECT * FROM sso_providers WHERE name = $1 AND enabled = true", [name]);
    return rows[0] || null;
  },

  // --- Device Permissions ---
  async listDevicePermissions(userId) {
    const { rows } = await db.query(
      "SELECT dp.*, d.name as device_name FROM device_permissions dp LEFT JOIN devices d ON dp.device_id = d.id WHERE dp.user_id = $1 ORDER BY dp.created_at",
      [userId]
    );
    return rows.map(r => ({ id: r.id, userId: r.user_id, deviceId: r.device_id, deviceName: r.device_name, permission: r.permission, grantedBy: r.granted_by, createdAt: r.created_at }));
  },
  async listAllDevicePermissions() {
    const { rows } = await db.query(
      "SELECT dp.*, d.name as device_name, u.username FROM device_permissions dp LEFT JOIN devices d ON dp.device_id = d.id LEFT JOIN users u ON dp.user_id = u.id ORDER BY u.username, d.name"
    );
    return rows.map(r => ({ id: r.id, userId: r.user_id, username: r.username, deviceId: r.device_id, deviceName: r.device_name, permission: r.permission, grantedBy: r.granted_by, createdAt: r.created_at }));
  },
  async grantDevicePermission(userId, deviceId, permission, grantedBy) {
    const id = `dp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      "INSERT INTO device_permissions (id, user_id, device_id, permission, granted_by, created_at) VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (user_id, device_id) DO UPDATE SET permission = $4, granted_by = $5",
      [id, userId, deviceId, permission || "read", grantedBy]
    );
    return { id, userId, deviceId, permission: permission || "read" };
  },
  async revokeDevicePermission(id) {
    await db.query("DELETE FROM device_permissions WHERE id = $1", [id]);
  },
  async revokeDevicePermissionsByUser(userId) {
    await db.query("DELETE FROM device_permissions WHERE user_id = $1", [userId]);
  },
  async userHasDevicePermission(userId, deviceId) {
    const { rows } = await db.query("SELECT 1 FROM device_permissions WHERE user_id = $1 AND device_id = $2", [userId, deviceId]);
    return rows.length > 0;
  },
  async getUserDeviceIds(userId) {
    const { rows } = await db.query("SELECT device_id FROM device_permissions WHERE user_id = $1", [userId]);
    return rows.map(r => r.device_id);
  },

  // --- Device Health Scoring ---
  async getDeviceHealthScores() {
    const devices = await this.listDevices();
    const scores = [];
    for (const d of devices) {
      // Factor 1: Reading stability (last 20 readings within tolerance?)
      const { rows: readings } = await db.query(
        "SELECT weight, target_weight FROM readings WHERE device_id = $1 ORDER BY ts DESC LIMIT 20",
        [d.id]
      );
      let readingScore = 100;
      if (readings.length > 0) {
        const target = d.target || 25;
        const withinTolerance = readings.filter(r => Math.abs((r.weight || 0) - target) <= (d.tolerance || 5)).length;
        readingScore = Math.round((withinTolerance / readings.length) * 100);
      } else {
        readingScore = 50; // no data = unknown
      }

      // Factor 2: Maintenance recency (from maintenance_records)
      let maintenanceScore = 100;
      const { rows: maint } = await db.query(
        "SELECT completed_at FROM maintenance_records WHERE device_id = $1 AND status = 'COMPLETED' ORDER BY completed_at DESC LIMIT 1",
        [d.id]
      );
      if (maint.length) {
        const daysSince = (Date.now() - new Date(maint[0].completed_at).getTime()) / 86400000;
        if (daysSince > 90) maintenanceScore = 40;
        else if (daysSince > 60) maintenanceScore = 65;
        else if (daysSince > 30) maintenanceScore = 80;
        else maintenanceScore = 100;
      }

      // Factor 3: Calibration recency (last 14 days = 100, 30 days = 80, 60+ = 50)
      let calibrationScore = 100;
      const { rows: cal } = await db.query(
        "SELECT performed_at FROM calibrations WHERE device_id = $1 ORDER BY performed_at DESC LIMIT 1",
        [d.id]
      );
      if (cal.length) {
        const daysSince = (Date.now() - new Date(cal[0].performed_at).getTime()) / 86400000;
        if (daysSince > 60) calibrationScore = 40;
        else if (daysSince > 30) calibrationScore = 65;
        else calibrationScore = 100;
      }

      // Factor 4: Alert count (last 7 days, 0 alerts = 100, 5+ = 50)
      let alertScore = 100;
      const { rows: alerts } = await db.query(
        "SELECT 1 FROM alert_history WHERE device_id = $1 AND ts > now() - interval '7 days' AND severity IN ('critical','warning')",
        [d.id]
      );
      if (alerts.length >= 10) alertScore = 20;
      else if (alerts.length >= 5) alertScore = 50;
      else if (alerts.length >= 2) alertScore = 75;
      else alertScore = 100;

      // Factor 5: Data freshness (last reading within 2 hours = 100, 6 hours = 75, 24 hours = 50, stale = 20)
      let freshnessScore = 50;
      const { rows: latest } = await db.query(
        "SELECT ts FROM readings WHERE device_id = $1 ORDER BY ts DESC LIMIT 1",
        [d.id]
      );
      if (latest.length) {
        const hoursSince = (Date.now() - new Date(latest[0].ts).getTime()) / 3600000;
        if (hoursSince < 2) freshnessScore = 100;
        else if (hoursSince < 6) freshnessScore = 80;
        else if (hoursSince < 24) freshnessScore = 50;
        else freshnessScore = 20;
      }

      // Factor 6: Failure history (more recent failures = lower score)
      let failureScore = 100;
      const { rows: failures } = await db.query(
        "SELECT occurred_at FROM maintenance_failures WHERE device_id = $1 AND occurred_at > now() - interval '90 days'",
        [d.id]
      );
      if (failures.length >= 5) failureScore = 20;
      else if (failures.length >= 3) failureScore = 40;
      else if (failures.length >= 1) failureScore = 70;

      // Factor 7: Telemetry-based process capability (Cpk trend)
      let telemetryScore = 100;
      const { rows: tele } = await db.query(
        "SELECT value FROM telemetry WHERE device_id = $1 AND metric = 'weight' AND ts > now() - interval '7 days' ORDER BY ts DESC LIMIT 50",
        [d.id]
      );
      if (tele.length >= 10) {
        const values = tele.map(t => Number(t.value));
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const stdDev = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
        const tolerance = d.tolerance || 5;
        const cpk = stdDev > 0 ? Math.min((tolerance - mean) / (3 * stdDev), (mean + tolerance) / (3 * stdDev)) : 1;
        if (cpk < 0.67) telemetryScore = 20;
        else if (cpk < 1.0) telemetryScore = 50;
        else if (cpk < 1.33) telemetryScore = 80;
        else telemetryScore = 100;
      }

      // Weighted composite score (enhanced with new factors)
      const healthScore = Math.round(
        readingScore * 0.25 +
        maintenanceScore * 0.15 +
        calibrationScore * 0.15 +
        alertScore * 0.10 +
        freshnessScore * 0.10 +
        failureScore * 0.15 +
        telemetryScore * 0.10
      );

      scores.push({
        deviceId: d.id,
        deviceName: d.name,
        healthScore,
        readingScore,
        maintenanceScore,
        calibrationScore,
        alertScore,
        freshnessScore,
        failureScore,
        telemetryScore,
        status: healthScore >= 80 ? "healthy" : healthScore >= 50 ? "warning" : "critical"
      });
    }
    return scores;
  },

  // --- Batches / Lot Tracking ---
  async listBatches(status) {
    const query = status && status !== "all"
      ? "SELECT * FROM batches WHERE status = $1 ORDER BY created_at DESC LIMIT 100"
      : "SELECT * FROM batches ORDER BY created_at DESC LIMIT 100";
    const params = status && status !== "all" ? [status] : [];
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, name: r.name, customer: r.customer, productId: r.product_id, deviceId: r.device_id, status: r.status, startedAt: r.started_at, completedAt: r.completed_at, totalBags: r.total_bags, targetBags: r.target_bags, notes: r.notes }));
  },
  async createBatch(batch) {
    const id = `bt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      "INSERT INTO batches (id, name, customer, product_id, device_id, status, target_bags, notes, created_at) VALUES ($1,$2,$3,$4,$5,'active',$6,$7,now())",
      [id, batch.name, batch.customer || null, batch.productId || null, batch.deviceId || null, batch.targetBags || null, batch.notes || null]
    );
    return { id, ...batch, status: "active", totalBags: 0, startedAt: new Date().toISOString() };
  },
  async updateBatch(id, updates) {
    const sets = [];
    const params = [id];
    let idx = 2;
    if (updates.status !== undefined) { sets.push(`status = $${idx}`); params.push(updates.status); idx++; }
    if (updates.totalBags !== undefined) { sets.push(`total_bags = $${idx}`); params.push(updates.totalBags); idx++; }
    if (updates.notes !== undefined) { sets.push(`notes = $${idx}`); params.push(updates.notes); idx++; }
    if (updates.status === "completed") { sets.push("completed_at = now()"); }
    if (sets.length) await db.query(`UPDATE batches SET ${sets.join(", ")} WHERE id = $1`, params);
  },
  async deleteBatch(id) {
    await db.query("DELETE FROM batches WHERE id = $1", [id]);
  },
  async getBatchReadings(batchId) {
    const { rows } = await db.query("SELECT * FROM readings WHERE batch_id = $1 ORDER BY ts", [batchId]);
    return rows;
  },
  async linkReadingToBatch(readingId, batchId) {
    await db.query("UPDATE readings SET batch_id = $1 WHERE id = $2", [batchId, readingId]);
  },

  // --- AI Insights ---
  async listAIInsights(deviceId, type) {
    let query = "SELECT * FROM ai_insights WHERE 1=1";
    const params = [];
    let idx = 1;
    if (deviceId) { query += ` AND device_id = $${idx}`; params.push(deviceId); idx++; }
    if (type) { query += ` AND insight_type = $${idx}`; params.push(type); idx++; }
    query += " ORDER BY created_at DESC LIMIT 100";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, deviceId: r.device_id, type: r.insight_type, severity: r.severity, title: r.title, description: r.description, confidence: r.confidence, data: r.data, createdAt: r.created_at, acknowledged: r.acknowledged }));
  },
  async createAIInsight(insight) {
    const id = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      "INSERT INTO ai_insights (id, device_id, insight_type, severity, title, description, confidence, data, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())",
      [id, insight.deviceId, insight.type, insight.severity || "info", insight.title, insight.description, insight.confidence || 0.5, insight.data ? JSON.stringify(insight.data) : null]
    );
    return { id, ...insight };
  },
  async acknowledgeInsight(id) {
    await db.query("UPDATE ai_insights SET acknowledged = true WHERE id = $1", [id]);
  },
  async runAIAnalysis() {
    const devices = await this.listDevices();
    const insights = [];
    for (const d of devices) {
      // 1. Weight drift analysis
      const { rows: readings } = await db.query(
        "SELECT actual_weight, target_weight, ts FROM readings WHERE device_id = $1 ORDER BY ts DESC LIMIT 100",
        [d.id]
      );
      if (readings.length >= 10) {
        const weights = readings.map(r => Number(r.actual_weight));
        const target = Number(readings[0]?.target_weight || d.targetWeight || 25);
        const mean = weights.reduce((a, b) => a + b, 0) / weights.length;
        const stdDev = Math.sqrt(weights.reduce((s, w) => s + Math.pow(w - mean, 2), 0) / weights.length);
        const recentMean = weights.slice(0, 20).reduce((a, b) => a + b, 0) / Math.min(20, weights.length);
        const oldMean = weights.slice(20).reduce((a, b) => a + b, 0) / Math.max(1, weights.length - 20);
        const drift = recentMean - oldMean;
        const driftPct = (drift / target) * 100;

        // Detect significant drift (>1% shift)
        if (Math.abs(driftPct) > 1) {
          const existing = await db.query(
            "SELECT 1 FROM ai_insights WHERE device_id = $1 AND insight_type = 'drift' AND created_at > now() - interval '24 hours'",
            [d.id]
          );
          if (existing.rows.length === 0) {
            const insight = await this.createAIInsight({
              deviceId: d.id,
              type: "drift",
              severity: Math.abs(driftPct) > 3 ? "critical" : "warning",
              title: `Weight drift detected: ${driftPct > 0 ? "+" : ""}${driftPct.toFixed(1)}%`,
              description: `Recent readings trend ${driftPct > 0 ? "heavier" : "lighter"} by ${Math.abs(drift).toFixed(2)}g. Mean shifted from ${oldMean.toFixed(2)}g to ${recentMean.toFixed(2)}g.`,
              confidence: Math.min(0.95, 0.5 + (readings.length / 200)),
              data: { drift, driftPct, recentMean, oldMean, stdDev, sampleSize: readings.length }
            });
            insights.push(insight);
          }
        }
      }

      // 2. Predictive maintenance
      const { rows: maint } = await db.query(
        "SELECT performed_at FROM maintenance WHERE device_id = $1 ORDER BY performed_at DESC LIMIT 1",
        [d.id]
      );
      if (maint.length) {
        const daysSince = (Date.now() - new Date(maint[0].performed_at).getTime()) / 86400000;
        const maintInterval = 30; // days
        const remaining = maintInterval - daysSince;
        if (remaining <= 5 && remaining > 0) {
          const existing = await db.query(
            "SELECT 1 FROM ai_insights WHERE device_id = $1 AND insight_type = 'maintenance_due' AND created_at > now() - interval '7 days'",
            [d.id]
          );
          if (existing.rows.length === 0) {
            const insight = await this.createAIInsight({
              deviceId: d.id,
              type: "maintenance_due",
              severity: remaining <= 2 ? "critical" : "warning",
              title: `Maintenance due in ${Math.ceil(remaining)} days`,
              description: `Last maintenance was ${Math.floor(daysSince)} days ago. Recommended interval is ${maintInterval} days.`,
              confidence: 0.9,
              data: { daysSince, remaining, interval: maintInterval }
            });
            insights.push(insight);
          }
        }
      }

      // 3. Precision degradation
      if (readings.length >= 20) {
        const weights = readings.map(r => Number(r.actual_weight));
        const target = Number(readings[0]?.target_weight || d.targetWeight || 25);
        const tolerance = d.tolerance || 5;
        const recent = weights.slice(0, 20);
        const older = weights.slice(20, 40);
        const recentCpk = this._calculateCpk(recent, target, tolerance);
        const olderCpk = older.length >= 10 ? this._calculateCpk(older, target, tolerance) : recentCpk;

        if (olderCpk > 1.33 && recentCpk < olderCpk * 0.8) {
          const existing = await db.query(
            "SELECT 1 FROM ai_insights WHERE device_id = $1 AND insight_type = 'precision_drop' AND created_at > now() - interval '48 hours'",
            [d.id]
          );
          if (existing.rows.length === 0) {
            const insight = await this.createAIInsight({
              deviceId: d.id,
              type: "precision_drop",
              severity: recentCpk < 1.0 ? "critical" : "warning",
              title: `Precision degradation detected (Cpk: ${olderCpk.toFixed(2)} → ${recentCpk.toFixed(2)})`,
              description: `Process capability index dropped by ${((1 - recentCpk / olderCpk) * 100).toFixed(0)}%. Consider calibration or maintenance.`,
              confidence: 0.85,
              data: { recentCpk, olderCpk, sampleSize: readings.length }
            });
            insights.push(insight);
          }
        }
      }
    }
    return insights;
  },
  _calculateCpk(values, target, tolerance) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const stdDev = Math.sqrt(values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length) || 0.001;
    const upperCpu = (target + tolerance - mean) / (3 * stdDev);
    const lowerCpl = (mean - (target - tolerance)) / (3 * stdDev);
    return Math.min(upperCpu, lowerCpl);
  },

  // ============================================================
  // PHASE 5: Machine Learning Pipeline
  // ============================================================

  // --- ML Model Management ---
  async listMLModels(filters = {}) {
    let query = "SELECT * FROM ml_models";
    const params = [];
    const conditions = [];
    if (filters.deviceId) { params.push(filters.deviceId); conditions.push(`device_id = $${params.length}`); }
    if (filters.modelType) { params.push(filters.modelType); conditions.push(`model_type = $${params.length}`); }
    if (filters.orgId) { params.push(filters.orgId); conditions.push(`org_id = $${params.length}`); }
    if (conditions.length) query += " WHERE " + conditions.join(" AND ");
    query += " ORDER BY updated_at DESC";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, orgId: r.org_id, deviceId: r.device_id, name: r.name, modelType: r.model_type, metric: r.metric, parameters: r.parameters, trainingDataSize: r.training_data_size, accuracy: r.accuracy, mae: r.mae, rmse: r.rmse, r2: r.r2, status: r.status, lastTrainedAt: r.last_trained_at, lastPredictionAt: r.last_prediction_at, createdAt: r.created_at, updatedAt: r.updated_at }));
  },
  async getMLModel(id) {
    const { rows } = await db.query("SELECT * FROM ml_models WHERE id = $1", [id]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { id: r.id, orgId: r.org_id, deviceId: r.device_id, name: r.name, modelType: r.model_type, metric: r.metric, parameters: r.parameters, trainingDataSize: r.training_data_size, accuracy: r.accuracy, mae: r.mae, rmse: r.rmse, r2: r.r2, status: r.status, lastTrainedAt: r.last_trained_at, lastPredictionAt: r.last_prediction_at, createdAt: r.created_at, updatedAt: r.updated_at };
  },
  async createMLModel(model) {
    const id = `ml_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      `INSERT INTO ml_models (id, org_id, device_id, name, model_type, metric, parameters, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now())`,
      [id, model.orgId || null, model.deviceId || null, model.name, model.modelType, model.metric,
       JSON.stringify(model.parameters || {}), model.status || "trained"]
    );
    return { id, ...model, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  },
  async updateMLModel(id, updates) {
    const sets = [];
    const params = [id];
    let idx = 2;
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined && k !== "id") {
        const col = k === "orgId" ? "org_id" : k === "deviceId" ? "device_id" : k === "modelType" ? "model_type" : k === "trainingDataSize" ? "training_data_size" : k === "lastTrainedAt" ? "last_trained_at" : k === "lastPredictionAt" ? "last_prediction_at" : k;
        const val = (k === "parameters" || k === "trainingDataSize") && typeof v === "object" ? JSON.stringify(v) : v;
        sets.push(`${col} = $${idx}`); params.push(val); idx++;
      }
    }
    sets.push("updated_at = now()");
    if (sets.length > 1) await db.query(`UPDATE ml_models SET ${sets.join(", ")} WHERE id = $1`, params);
  },
  async deleteMLModel(id) {
    await db.query("DELETE FROM ml_predictions WHERE model_id = $1", [id]);
    await db.query("DELETE FROM ml_models WHERE id = $1", [id]);
  },

  // --- ML Predictions ---
  async listMLPredictions(filters = {}) {
    let query = "SELECT * FROM ml_predictions";
    const params = [];
    const conditions = [];
    if (filters.modelId) { params.push(filters.modelId); conditions.push(`model_id = $${params.length}`); }
    if (filters.deviceId) { params.push(filters.deviceId); conditions.push(`device_id = $${params.length}`); }
    if (conditions.length) query += " WHERE " + conditions.join(" AND ");
    query += " ORDER BY created_at DESC LIMIT 200";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, modelId: r.model_id, deviceId: r.device_id, metric: r.metric, predictedValue: r.predicted_value, actualValue: r.actual_value, confidence: r.confidence, predictionHorizonHours: r.prediction_horizon_hours, error: r.error, createdAt: r.created_at }));
  },
  async addMLPrediction(prediction) {
    const id = `mp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      `INSERT INTO ml_predictions (id, model_id, device_id, metric, predicted_value, actual_value, confidence, prediction_horizon_hours, error, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
      [id, prediction.modelId || null, prediction.deviceId, prediction.metric,
       prediction.predictedValue, prediction.actualValue || null, prediction.confidence || 0,
       prediction.predictionHorizonHours || 1, prediction.error || null]
    );
    return { id, ...prediction, createdAt: new Date().toISOString() };
  },

  // --- Anomaly Detection (Z-score + IQR) ---
  async detectAnomalies(deviceId, metric, options = {}) {
    const { threshold = 3, minSamples = 20 } = options;
    // Fetch recent telemetry values
    const { rows } = await db.query(
      "SELECT value, ts FROM telemetry WHERE device_id = $1 AND metric = $2 ORDER BY ts DESC LIMIT 200",
      [deviceId, metric]
    );
    if (rows.length < minSamples) return { deviceId, metric, anomalies: [], message: `Need at least ${minSamples} samples` };

    const values = rows.map(r => Number(r.value));
    const timestamps = rows.map(r => r.ts);
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const stdDev = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) || 0.001;

    // Z-score anomaly detection
    const anomalies = [];
    for (let i = 0; i < Math.min(20, n); i++) {
      const zScore = Math.abs((values[i] - mean) / stdDev);
      if (zScore > threshold) {
        anomalies.push({
          index: i, value: values[i], zScore: Math.round(zScore * 100) / 100,
          timestamp: timestamps[i],
          type: zScore > threshold * 1.5 ? "extreme" : "moderate",
          deviation: values[i] - mean,
        });
      }
    }

    // IQR-based detection
    const sorted = [...values].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(n * 0.25)];
    const q3 = sorted[Math.floor(n * 0.75)];
    const iqr = q3 - q1;
    const lowerFence = q1 - 1.5 * iqr;
    const upperFence = q3 + 1.5 * iqr;
    const iqrAnomalies = values.filter((v, i) => (v < lowerFence || v > upperFence) && i < 20).length;

    return {
      deviceId, metric, mean: Math.round(mean * 1000) / 1000,
      stdDev: Math.round(stdDev * 1000) / 1000,
      sampleSize: n, anomalies,
      iqr: { q1, q3, iqr: Math.round(iqr * 1000) / 1000, lowerFence, upperFence, outlierCount: iqrAnomalies },
      anomalyRate: Math.round((anomalies.length / Math.min(20, n)) * 100),
    };
  },

  // --- Drift Detection (CUSUM + EWMA) ---
  async detectDrift(deviceId, metric, options = {}) {
    const { cusumThreshold = 5, ewmaAlpha = 0.2, windowSize = 50 } = options;
    const { rows } = await db.query(
      "SELECT value, ts FROM telemetry WHERE device_id = $1 AND metric = $2 ORDER BY ts DESC LIMIT $3",
      [deviceId, metric, windowSize]
    );
    if (rows.length < 10) return { deviceId, metric, drift: null, message: "Insufficient data" };

    const values = rows.map(r => Number(r.value)).reverse(); // oldest first
    const timestamps = rows.map(r => r.ts).reverse();
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const target = mean; // baseline

    // CUSUM (Cumulative Sum) detection
    let cusumPos = 0, cusumNeg = 0;
    const cusumStats = [];
    let driftDetected = false;
    let driftPoint = -1;
    for (let i = 0; i < n; i++) {
      cusumPos = Math.max(0, cusumPos + (values[i] - target) - 0.5);
      cusumNeg = Math.max(0, cusumNeg - (values[i] - target) - 0.5);
      cusumStats.push({ cusumPos: Math.round(cusumPos * 100) / 100, cusumNeg: Math.round(cusumNeg * 100) / 100 });
      if ((cusumPos > cusumThreshold || cusumNeg > cusumThreshold) && !driftDetected) {
        driftDetected = true;
        driftPoint = i;
      }
    }

    // EWMA (Exponentially Weighted Moving Average)
    const ewma = [values[0]];
    for (let i = 1; i < n; i++) {
      ewma.push(ewmaAlpha * values[i] + (1 - ewmaAlpha) * ewma[i - 1]);
    }
    const ewmaStd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n) || 0.001;
    const ewmaUCL = mean + 3 * ewmaStd * Math.sqrt(ewmaAlpha / (2 - ewmaAlpha));
    const ewmaLCL = mean - 3 * ewmaStd * Math.sqrt(ewmaAlpha / (2 - ewmaAlpha));
    const ewmaBreaches = ewma.filter(v => v > ewmaUCL || v < ewmaLCL).length;

    // Trend detection (linear regression)
    const xMean = (n - 1) / 2;
    const yMean = mean;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - xMean) * (values[i] - yMean);
      den += (i - xMean) ** 2;
    }
    const slope = den ? num / den : 0;
    const trendDirection = Math.abs(slope) < ewmaStd * 0.01 ? "stable" : slope > 0 ? "increasing" : "decreasing";
    const trendSignificance = Math.abs(slope) / (ewmaStd || 0.001);

    // Recent vs old comparison
    const half = Math.floor(n / 2);
    const oldMean = values.slice(0, half).reduce((a, b) => a + b, 0) / half;
    const recentMean = values.slice(half).reduce((a, b) => a + b, 0) / (n - half);
    const percentShift = ((recentMean - oldMean) / oldMean) * 100;

    return {
      deviceId, metric,
      baseline: { mean: Math.round(mean * 1000) / 1000, stdDev: Math.round(ewmaStd * 1000) / 1000 },
      cusum: { threshold: cusumThreshold, detected: driftDetected, driftPoint, driftPointTime: driftPoint >= 0 ? timestamps[driftPoint] : null, maxCusumPos: Math.max(...cusumStats.map(s => s.cusumPos)), maxCusumNeg: Math.max(...cusumStats.map(s => s.cusumNeg)) },
      ewma: { alpha: ewmaAlpha, ucl: Math.round(ewmaUCL * 1000) / 1000, lcl: Math.round(ewmaLCL * 1000) / 1000, breaches: ewmaBreaches, current: Math.round(ewma[n - 1] * 1000) / 1000 },
      trend: { direction: trendDirection, slope: Math.round(slope * 10000) / 10000, significance: Math.round(trendSignificance * 100) / 100 },
      comparison: { oldMean: Math.round(oldMean * 1000) / 1000, recentMean: Math.round(recentMean * 1000) / 1000, percentShift: Math.round(percentShift * 100) / 100 },
      sampleSize: n,
    };
  },

  // --- Time-Series Forecasting ---
  async forecastMetric(deviceId, metric, options = {}) {
    const { horizonHours = 24, windowSize = 100 } = options;
    const { rows } = await db.query(
      "SELECT value, ts FROM telemetry WHERE device_id = $1 AND metric = $2 ORDER BY ts DESC LIMIT $3",
      [deviceId, metric, windowSize]
    );
    if (rows.length < 20) return { deviceId, metric, forecast: [], message: "Need at least 20 data points" };

    const values = rows.map(r => Number(r.value)).reverse();
    const timestamps = rows.map(r => new Date(r.ts).getTime()).reverse();
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const stdDev = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n) || 0.001;

    // Calculate time interval between samples
    const avgInterval = (timestamps[n - 1] - timestamps[0]) / (n - 1);
    const steps = Math.ceil(horizonHours * 3600000 / avgInterval);

    // Method 1: Moving Average forecast
    const maWindow = Math.min(20, Math.floor(n / 2));
    const ma = values.slice(-maWindow).reduce((a, b) => a + b, 0) / maWindow;

    // Method 2: Linear trend forecast
    const xMean = (n - 1) / 2;
    const yMean = mean;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - xMean) * (values[i] - yMean);
      den += (i - xMean) ** 2;
    }
    const slope = den ? num / den : 0;
    const intercept = yMean - slope * xMean;

    // Method 3: Exponential Smoothing (Holt's method for trend)
    const alpha = 0.3, beta = 0.1;
    let level = values[0], trendVal = values[1] - values[0];
    for (let i = 1; i < n; i++) {
      const prevLevel = level;
      level = alpha * values[i] + (1 - alpha) * (level + trendVal);
      trendVal = beta * (level - prevLevel) + (1 - beta) * trendVal;
    }

    // Generate forecasts
    const forecasts = [];
    const lastTime = timestamps[n - 1];
    for (let h = 1; h <= Math.min(steps, 48); h++) {
      const futureTime = lastTime + h * avgInterval;
      const linearForecast = intercept + slope * (n + h - 1);
      const holtForecast = level + trendVal * h;
      const combinedForecast = (ma * 0.2 + linearForecast * 0.3 + holtForecast * 0.5);

      // Confidence interval widens with horizon
      const confidenceWidth = stdDev * Math.sqrt(1 + h / n) * 1.96;

      forecasts.push({
        timestamp: new Date(futureTime).toISOString(),
        hoursAhead: Math.round(h * avgInterval / 3600000 * 10) / 10,
        movingAverage: Math.round(ma * 1000) / 1000,
        linearTrend: Math.round(linearForecast * 1000) / 1000,
        holtExponential: Math.round(holtForecast * 1000) / 1000,
        combined: Math.round(combinedForecast * 1000) / 1000,
        lowerBound: Math.round((combinedForecast - confidenceWidth) * 1000) / 1000,
        upperBound: Math.round((combinedForecast + confidenceWidth) * 1000) / 1000,
      });
    }

    // Calculate model accuracy on training data
    let sse = 0, sst = 0;
    for (let i = 0; i < n; i++) {
      const predicted = intercept + slope * i;
      sse += (values[i] - predicted) ** 2;
      sst += (values[i] - mean) ** 2;
    }
    const r2 = sst > 0 ? 1 - sse / sst : 0;

    return {
      deviceId, metric,
      methods: { movingAverage: Math.round(ma * 1000) / 1000, linearTrend: Math.round(intercept * 1000) / 1000, holtExponential: Math.round(level * 1000) / 1000 },
      trend: { slope: Math.round(slope * 10000) / 10000, direction: Math.abs(slope) < stdDev * 0.01 ? "stable" : slope > 0 ? "up" : "down" },
      stats: { mean: Math.round(mean * 1000) / 1000, stdDev: Math.round(stdDev * 1000) / 1000, r2: Math.round(r2 * 1000) / 1000 },
      forecast: forecasts.slice(0, 12), // return first 12 predictions
      sampleSize: n,
    };
  },

  // --- ML Model Training (simple linear regression / moving average) ---
  async trainMLModel(modelId) {
    const model = await store.getMLModel(modelId);
    if (!model) return null;

    const { rows } = await db.query(
      "SELECT value FROM telemetry WHERE device_id = $1 AND metric = $2 ORDER BY ts DESC LIMIT 200",
      [model.deviceId, model.metric]
    );
    if (rows.length < 10) return { error: "Insufficient training data" };

    const values = rows.map(r => Number(r.value));
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;

    // Linear regression
    const xMean = (n - 1) / 2;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - xMean) * (values[i] - mean);
      den += (i - xMean) ** 2;
    }
    const slope = den ? num / den : 0;
    const intercept = mean - slope * xMean;

    // Calculate metrics
    let sse = 0, sst = 0;
    for (let i = 0; i < n; i++) {
      const predicted = intercept + slope * i;
      sse += (values[i] - predicted) ** 2;
      sst += (values[i] - mean) ** 2;
    }
    const r2 = sst > 0 ? 1 - sse / sst : 0;
    const mae = values.reduce((s, v, i) => s + Math.abs(v - (intercept + slope * i)), 0) / n;
    const rmse = Math.sqrt(sse / n);

    // Moving average parameters
    const maWindow = Math.min(20, Math.floor(n / 2));
    const ma = values.slice(-maWindow).reduce((a, b) => a + b, 0) / maWindow;

    await store.updateMLModel(modelId, {
      parameters: { slope, intercept, maWindow, mean: Math.round(mean * 1000) / 1000, type: "linear_regression" },
      trainingDataSize: n,
      accuracy: Math.round(r2 * 1000) / 1000,
      mae: Math.round(mae * 1000) / 1000,
      rmse: Math.round(rmse * 1000) / 1000,
      r2: Math.round(r2 * 1000) / 1000,
      lastTrainedAt: new Date().toISOString(),
      status: "trained",
    });

    return await store.getMLModel(modelId);
  },

  // --- ML Prediction using trained model ---
  async generateMLPrediction(modelId, horizonHours = 1) {
    const model = await store.getMLModel(modelId);
    if (!model || model.status !== "trained") return { error: "Model not trained" };

    const { rows } = await db.query(
      "SELECT value FROM telemetry WHERE device_id = $1 AND metric = $2 ORDER BY ts DESC LIMIT 1",
      [model.deviceId, model.metric]
    );
    if (!rows.length) return { error: "No recent data" };

    const currentValue = Number(rows[0].value);
    const params = model.parameters;
    let predicted;

    if (params.type === "linear_regression") {
      // Use slope to project forward
      predicted = currentValue + (params.slope || 0) * horizonHours;
    } else {
      predicted = params.mean || currentValue;
    }

    // Confidence based on model accuracy and horizon
    const confidence = Math.max(0, Math.min(1, (model.r2 || 0.5) * Math.exp(-0.05 * horizonHours)));
    const error = Math.abs(predicted - currentValue);

    const prediction = await store.addMLPrediction({
      modelId, deviceId: model.deviceId, metric: model.metric,
      predictedValue: Math.round(predicted * 1000) / 1000,
      confidence: Math.round(confidence * 100) / 100,
      predictionHorizonHours: horizonHours,
      error: Math.round(error * 1000) / 1000,
    });

    await store.updateMLModel(modelId, { lastPredictionAt: new Date().toISOString() });
    return prediction;
  },

  // ============================================================
  // PHASE 6: Predictive Maintenance — Health Trends, RUL, Optimization
  // ============================================================

  // --- Health History ---
  async recordHealthScore(deviceId, scores) {
    const id = `hh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      `INSERT INTO health_history (id, device_id, health_score, reading_score, maintenance_score, calibration_score, alert_score, freshness_score, failure_score, telemetry_score, status, notes, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())`,
      [id, deviceId, scores.healthScore, scores.readingScore || null, scores.maintenanceScore || null,
       scores.calibrationScore || null, scores.alertScore || null, scores.freshnessScore || null,
       scores.failureScore || null, scores.telemetryScore || null,
       scores.healthScore >= 80 ? "healthy" : scores.healthScore >= 50 ? "warning" : "critical",
       scores.notes || ""]
    );
    return id;
  },
  async getHealthHistory(deviceId, days = 30) {
    const { rows } = await db.query(
      "SELECT * FROM health_history WHERE device_id = $1 AND recorded_at > now() - ($2 || ' days')::interval ORDER BY recorded_at",
      [deviceId, days]
    );
    return rows.map(r => ({ id: r.id, deviceId: r.device_id, healthScore: r.health_score, readingScore: r.reading_score, maintenanceScore: r.maintenance_score, calibrationScore: r.calibration_score, alertScore: r.alert_score, freshnessScore: r.freshness_score, failureScore: r.failure_score, telemetryScore: r.telemetry_score, status: r.status, notes: r.notes, recordedAt: r.recorded_at }));
  },

  // --- Health Trend Analysis ---
  async analyzeHealthTrend(deviceId, days = 30) {
    const history = await store.getHealthHistory(deviceId, days);
    if (history.length < 3) return { deviceId, trend: null, message: "Need at least 3 health records" };

    const scores = history.map(h => h.healthScore);
    const timestamps = history.map(h => new Date(h.recordedAt).getTime());
    const n = scores.length;
    const mean = scores.reduce((a, b) => a + b, 0) / n;

    // Linear regression for trend
    const xMean = (timestamps.reduce((a, b) => a + b, 0) / n - timestamps[0]) / 86400000; // days
    const yMean = mean;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const xDay = (timestamps[i] - timestamps[0]) / 86400000;
      num += (xDay - xMean) * (scores[i] - yMean);
      den += (xDay - xMean) ** 2;
    }
    const slope = den ? num / den : 0; // score change per day
    const intercept = yMean - slope * xMean;

    // Degradation rate (points per week)
    const degradationRate = slope * 7;

    // Trend classification
    let trendDirection, trendSeverity;
    if (Math.abs(degradationRate) < 0.5) {
      trendDirection = "stable";
      trendSeverity = "info";
    } else if (degradationRate < 0) {
      trendDirection = "degrading";
      trendSeverity = Math.abs(degradationRate) > 5 ? "critical" : Math.abs(degradationRate) > 2 ? "warning" : "info";
    } else {
      trendDirection = "improving";
      trendSeverity = "info";
    }

    // Volatility (standard deviation of scores)
    const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    const volatility = Math.sqrt(variance);

    // Recent vs old comparison
    const half = Math.floor(n / 2);
    const oldAvg = scores.slice(0, half).reduce((a, b) => a + b, 0) / half;
    const recentAvg = scores.slice(half).reduce((a, b) => a + b, 0) / (n - half);

    return {
      deviceId,
      trend: {
        direction: trendDirection,
        severity: trendSeverity,
        slope: Math.round(slope * 1000) / 1000,
        degradationRate: Math.round(degradationRate * 100) / 100,
        degradationUnit: "points per week",
      },
      stats: {
        currentScore: scores[n - 1],
        averageScore: Math.round(mean * 10) / 10,
        minScore: Math.min(...scores),
        maxScore: Math.max(...scores),
        volatility: Math.round(volatility * 10) / 10,
        recordCount: n,
      },
      comparison: {
        oldAverage: Math.round(oldAvg * 10) / 10,
        recentAverage: Math.round(recentAvg * 10) / 10,
        change: Math.round((recentAvg - oldAvg) * 10) / 10,
      },
      history: history.slice(-20).map(h => ({ score: h.healthScore, status: h.status, at: h.recordedAt })),
    };
  },

  // --- Remaining Useful Life (RUL) Estimation ---
  async estimateRUL(deviceId, options = {}) {
    const { failureThreshold = 50, maxHorizonDays = 365 } = options;

    // Get health trend
    const trend = await store.analyzeHealthTrend(deviceId, 90);
    if (!trend.trend) return { deviceId, rul: null, message: "Insufficient health data for RUL estimation" };

    const currentScore = trend.stats.currentScore;
    const degradationRate = Math.abs(trend.trend.degradationRate); // points per week (positive = degrading)

    // If score is already below threshold
    if (currentScore <= failureThreshold) {
      return {
        deviceId, rulDays: 0, confidence: 0.9,
        currentScore, failureThreshold, degradationRate: trend.trend.degradationRate,
        method: "health_trend",
        message: "Health score below failure threshold — immediate action required",
      };
    }

    // If stable or improving
    if (trend.trend.direction === "stable" || trend.trend.direction === "improving") {
      return {
        deviceId, rulDays: maxHorizonDays, confidence: 0.6,
        currentScore, failureThreshold, degradationRate: trend.trend.degradationRate,
        method: "health_trend",
        message: "Device health is stable — no degradation-based failure predicted",
      };
    }

    // Calculate RUL based on degradation rate
    const scoreToLose = currentScore - failureThreshold;
    const weeksToThreshold = degradationRate > 0 ? scoreToLose / degradationRate : maxHorizonDays / 7;
    const rulDays = Math.min(Math.round(weeksToThreshold * 7), maxHorizonDays);

    // Confidence based on data quality
    const dataPoints = trend.stats.recordCount;
    const volatility = trend.stats.volatility;
    let confidence = 0.5;
    if (dataPoints >= 10) confidence += 0.15;
    if (dataPoints >= 20) confidence += 0.1;
    if (volatility < 10) confidence += 0.1;
    if (volatility < 5) confidence += 0.1;
    confidence = Math.min(0.95, confidence);

    // Store RUL estimate
    const id = `rul_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      `INSERT INTO rul_estimates (id, device_id, estimated_rul_days, confidence, degradation_rate, health_score, failure_threshold, method, metadata, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
      [id, deviceId, rulDays, confidence, trend.trend.degradationRate, currentScore, failureThreshold, "health_trend", JSON.stringify({ trend: trend.trend, stats: trend.stats })]
    );

    return {
      deviceId, rulDays, confidence: Math.round(confidence * 100) / 100,
      currentScore, failureThreshold,
      degradationRate: trend.trend.degradationRate,
      estimatedFailureDate: new Date(Date.now() + rulDays * 86400000).toISOString(),
      method: "health_trend",
      urgency: rulDays <= 7 ? "critical" : rulDays <= 30 ? "high" : rulDays <= 90 ? "medium" : "low",
      recommendation: rulDays <= 7 ? "Schedule maintenance within this week" :
                      rulDays <= 30 ? "Plan maintenance within the next month" :
                      rulDays <= 90 ? "Monitor closely — maintenance needed within 3 months" :
                      "No immediate action required",
    };
  },

  // --- Maintenance Optimization ---
  async generateMaintenanceRecommendations(deviceId) {
    const recommendations = [];
    const device = (await this.listDevices()).find(d => d.id === deviceId);
    if (!device) return recommendations;

    // 1. Check RUL
    const rul = await store.estimateRUL(deviceId);
    if (rul.rulDays !== null && rul.rulDays <= 30) {
      recommendations.push({
        type: "rul_warning",
        priority: rul.rulDays <= 7 ? "critical" : "high",
        title: `Device ${rul.rulDays <= 7 ? "needs immediate" : "needs soon"} maintenance`,
        description: `Remaining useful life: ${rul.rulDays} days. Health score degrading at ${Math.abs(rul.degradationRate)} points/week.`,
        estimatedCostSavings: 0,
        estimatedDowntimeSavings: rul.rulDays <= 7 ? 480 : 240,
      });
    }

    // 2. Check maintenance cost trends
    const costs = await store.getMaintenanceCosts(deviceId);
    const totalCost = costs.reduce((s, c) => s + c.totalCost, 0);
    const correctiveCost = costs.filter(c => c.maintenanceType === "corrective").reduce((s, c) => s + c.totalCost, 0);
    const preventiveCost = costs.filter(c => c.maintenanceType === "preventive").reduce((s, c) => s + c.totalCost, 0);
    if (correctiveCost > preventiveCost * 2 && correctiveCost > 100) {
      recommendations.push({
        type: "cost_optimization",
        priority: "medium",
        title: "Shift from corrective to preventive maintenance",
        description: `Corrective maintenance costs ($${correctiveCost.toFixed(2)}) are ${Math.round(correctiveCost / Math.max(1, preventiveCost))}x higher than preventive. Adding preventive schedules could reduce costs.`,
        estimatedCostSavings: correctiveCost * 0.3,
        estimatedDowntimeSavings: 120,
      });
    }

    // 3. Check failure patterns
    const failures = await store.listMaintenanceFailures({ deviceId });
    const failureTypes = {};
    failures.forEach(f => { failureTypes[f.failureType] = (failureTypes[f.failureType] || 0) + 1; });
    const topFailure = Object.entries(failureTypes).sort((a, b) => b[1] - a[1])[0];
    if (topFailure && topFailure[1] >= 3) {
      recommendations.push({
        type: "failure_pattern",
        priority: "high",
        title: `Recurring failure: ${topFailure[0]}`,
        description: `This failure type has occurred ${topFailure[1]} times. Consider root cause analysis or redesign.`,
        estimatedCostSavings: 0,
        estimatedDowntimeSavings: 0,
      });
    }

    // 4. Check calibration
    const { rows: cal } = await db.query(
      "SELECT performed_at FROM calibrations WHERE device_id = $1 ORDER BY performed_at DESC LIMIT 1",
      [deviceId]
    );
    if (cal.length) {
      const daysSinceCal = (Date.now() - new Date(cal[0].performed_at).getTime()) / 86400000;
      if (daysSinceCal > 60) {
        recommendations.push({
          type: "calibration_overdue",
          priority: "warning",
          title: "Calibration overdue",
          description: `Last calibration was ${Math.floor(daysSinceCal)} days ago. Recommended interval: 30-60 days.`,
          estimatedCostSavings: 0,
          estimatedDowntimeSavings: 60,
        });
      }
    }

    // 5. Health score below threshold
    const healthScores = await store.getDeviceHealthScores();
    const health = healthScores.find(h => h.deviceId === deviceId);
    if (health && health.healthScore < 60) {
      recommendations.push({
        type: "health_critical",
        priority: "critical",
        title: `Health score critical: ${health.healthScore}`,
        description: `Device health is at ${health.healthScore}/100. Multiple factors degraded: reading=${health.readingScore}, maintenance=${health.maintenanceScore}, calibration=${health.calibrationScore}.`,
        estimatedCostSavings: 0,
        estimatedDowntimeSavings: 240,
      });
    }

    // Store recommendations
    for (const rec of recommendations) {
      const id = `mr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await db.query(
        `INSERT INTO maintenance_recommendations (id, device_id, recommendation_type, priority, title, description, estimated_cost_savings, estimated_downtime_savings, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',now())`,
        [id, deviceId, rec.type, rec.priority, rec.title, rec.description, rec.estimatedCostSavings || 0, rec.estimatedDowntimeSavings || 0]
      );
    }

    return recommendations;
  },

  // --- Failure Mode Analysis ---
  async analyzeFailureModes(deviceId) {
    const failures = await store.listMaintenanceFailures({ deviceId });
    if (failures.length === 0) return { deviceId, analysis: null, message: "No failure data" };

    // Group by failure type
    const byType = {};
    failures.forEach(f => {
      if (!byType[f.failureType]) byType[f.failureType] = { count: 0, totalDowntime: 0, totalCost: 0, modes: {} };
      byType[f.failureType].count++;
      byType[f.failureType].totalDowntime += f.downtimeMinutes || 0;
      byType[f.failureType].totalCost += f.cost || 0;
      const mode = f.failureMode || "unknown";
      byType[f.failureType].modes[mode] = (byType[f.failureType].modes[mode] || 0) + 1;
    });

    // Group by failure mode
    const byMode = {};
    failures.forEach(f => {
      const mode = f.failureMode || "unknown";
      if (!byMode[mode]) byMode[mode] = { count: 0, types: {} };
      byMode[mode].count++;
      byMode[mode].types[f.failureType] = (byMode[mode].types[f.failureType] || 0) + 1;
    });

    // Time analysis
    const timestamps = failures.map(f => new Date(f.occurredAt).getTime()).sort((a, b) => a - b);
    const intervals = [];
    for (let i = 1; i < timestamps.length; i++) {
      intervals.push((timestamps[i] - timestamps[i - 1]) / 3600000);
    }
    const avgInterval = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : null;

    // Top root causes
    const rootCauses = {};
    failures.filter(f => f.rootCause).forEach(f => {
      rootCauses[f.rootCause] = (rootCauses[f.rootCause] || 0) + 1;
    });

    return {
      deviceId,
      totalFailures: failures.length,
      byType: Object.entries(byType).map(([type, data]) => ({
        type, count: data.count, totalDowntime: data.totalDowntime, totalCost: data.totalCost,
        topMode: Object.entries(data.modes).sort((a, b) => b[1] - a[1])[0]?.[0],
      })).sort((a, b) => b.count - a.count),
      byMode: Object.entries(byMode).map(([mode, data]) => ({
        mode, count: data.count, types: Object.keys(data.types),
      })).sort((a, b) => b.count - a.count),
      timeAnalysis: {
        avgIntervalHours: avgInterval ? Math.round(avgInterval * 10) / 10 : null,
        minInterval: intervals.length ? Math.round(Math.min(...intervals) * 10) / 10 : null,
        maxInterval: intervals.length ? Math.round(Math.max(...intervals) * 10) / 10 : null,
      },
      topRootCauses: Object.entries(rootCauses).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([cause, count]) => ({ cause, count })),
    };
  },

  // --- Maintenance Cost Optimization ---
  async analyzeMaintenanceCosts(deviceId) {
    const costs = await store.getMaintenanceCosts(deviceId);
    if (costs.length === 0) return { deviceId, analysis: null, message: "No cost data" };

    const totalCost = costs.reduce((s, c) => s + c.totalCost, 0);
    const totalLabour = costs.reduce((s, c) => s + c.totalLabour, 0);
    const totalParts = costs.reduce((s, c) => s + c.totalParts, 0);
    const totalDowntime = costs.reduce((s, c) => s + c.totalDowntime, 0);
    const totalRecords = costs.reduce((s, c) => s + c.recordCount, 0);

    // By type breakdown
    const byType = {};
    costs.forEach(c => {
      if (!byType[c.maintenanceType]) byType[c.maintenanceType] = { cost: 0, count: 0, downtime: 0 };
      byType[c.maintenanceType].cost += c.totalCost;
      byType[c.maintenanceType].count += c.recordCount;
      byType[c.maintenanceType].downtime += c.totalDowntime;
    });

    const corrective = byType.corrective || { cost: 0, count: 0, downtime: 0 };
    const preventive = byType.preventive || { cost: 0, count: 0, downtime: 0 };

    // Cost per maintenance event
    const avgCostPerEvent = totalRecords > 0 ? totalCost / totalRecords : 0;
    const avgDowntimePerEvent = totalRecords > 0 ? totalDowntime / totalRecords : 0;

    // Ratio analysis
    const correctiveRatio = totalCost > 0 ? corrective.cost / totalCost : 0;
    const preventiveRatio = totalCost > 0 ? preventive.cost / totalCost : 0;

    // Savings opportunity
    const potentialSavings = corrective.cost * 0.3; // 30% savings by shifting to preventive
    const potentialDowntimeReduction = corrective.downtime * 0.4; // 40% downtime reduction

    return {
      deviceId,
      summary: {
        totalCost: Math.round(totalCost * 100) / 100,
        totalLabour: Math.round(totalLabour * 100) / 100,
        totalParts: Math.round(totalParts * 100) / 100,
        totalDowntime, totalRecords,
        avgCostPerEvent: Math.round(avgCostPerEvent * 100) / 100,
        avgDowntimePerEvent: Math.round(avgDowntimePerEvent),
      },
      byType: Object.entries(byType).map(([type, data]) => ({
        type, cost: Math.round(data.cost * 100) / 100, count: data.count, downtime: data.downtime,
        costPerEvent: data.count > 0 ? Math.round(data.cost / data.count * 100) / 100 : 0,
      })),
      optimization: {
        correctiveRatio: Math.round(correctiveRatio * 100),
        preventiveRatio: Math.round(preventiveRatio * 100),
        potentialSavings: Math.round(potentialSavings * 100) / 100,
        potentialDowntimeReduction,
        recommendation: correctiveRatio > 0.6 ? "High corrective ratio — increase preventive maintenance" :
                       correctiveRatio > 0.3 ? "Balanced — consider targeted preventive maintenance" :
                       "Good preventive maintenance ratio",
      },
    };
  },

  // --- Bulk Record Health Scores (for scheduled jobs) ---
  async recordAllDeviceHealthScores() {
    const scores = await store.getDeviceHealthScores();
    const recorded = [];
    for (const s of scores) {
      await store.recordHealthScore(s.deviceId, s);
      recorded.push(s.deviceId);
    }
    return recorded;
  },

  // --- Organizations (Multi-Tenancy) ---
  async listOrganizations() {
    const { rows } = await db.query("SELECT * FROM organizations ORDER BY created_at");
    return rows.map(r => ({ id: r.id, name: r.name, slug: r.slug, plan: r.plan, maxDevices: r.max_devices, maxUsers: r.max_users, enabled: r.enabled, settings: r.settings, createdAt: r.created_at }));
  },
  async getOrganization(id) {
    const { rows } = await db.query("SELECT * FROM organizations WHERE id = $1", [id]);
    return rows[0] || null;
  },
  async createOrganization(org) {
    const id = `org_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const slug = org.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    await db.query(
      "INSERT INTO organizations (id, name, slug, plan, max_devices, max_users, settings, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())",
      [id, org.name, slug, org.plan || "free", org.maxDevices || 10, org.maxUsers || 5, org.settings ? JSON.stringify(org.settings) : null]
    );
    return { id, name: org.name, slug, plan: org.plan || "free", maxDevices: org.maxDevices || 10, maxUsers: org.maxUsers || 5 };
  },
  async updateOrganization(id, updates) {
    const sets = [];
    const params = [id];
    let idx = 2;
    if (updates.name !== undefined) { sets.push(`name = $${idx}`); params.push(updates.name); idx++; }
    if (updates.plan !== undefined) { sets.push(`plan = $${idx}`); params.push(updates.plan); idx++; }
    if (updates.maxDevices !== undefined) { sets.push(`max_devices = $${idx}`); params.push(updates.maxDevices); idx++; }
    if (updates.maxUsers !== undefined) { sets.push(`max_users = $${idx}`); params.push(updates.maxUsers); idx++; }
    if (updates.enabled !== undefined) { sets.push(`enabled = $${idx}`); params.push(updates.enabled); idx++; }
    if (updates.settings !== undefined) { sets.push(`settings = $${idx}`); params.push(JSON.stringify(updates.settings)); idx++; }
    if (sets.length) await db.query(`UPDATE organizations SET ${sets.join(", ")} WHERE id = $1`, params);
  },
  async deleteOrganization(id) {
    await db.query("UPDATE users SET org_id = NULL WHERE org_id = $1", [id]);
    await db.query("UPDATE devices SET org_id = NULL WHERE org_id = $1", [id]);
    await db.query("DELETE FROM organizations WHERE id = $1", [id]);
  },
  async assignUserToOrg(userId, orgId) {
    await db.query("UPDATE users SET org_id = $1 WHERE id = $2", [orgId, userId]);
  },
  async assignDeviceToOrg(deviceId, orgId) {
    await db.query("UPDATE devices SET org_id = $1 WHERE id = $2", [orgId, deviceId]);
  },
  async getOrgUsers(orgId) {
    const { rows } = await db.query("SELECT id, username, role FROM users WHERE org_id = $1", [orgId]);
    return rows;
  },
  async getOrgDevices(orgId) {
    const { rows } = await db.query("SELECT id, name, ip, protocol FROM devices WHERE org_id = $1", [orgId]);
    return rows;
  },

  // --- Report Templates ---
  async listReportTemplates() {
    const { rows } = await db.query("SELECT * FROM report_templates ORDER BY created_at DESC");
    return rows.map(r => ({ id: r.id, name: r.name, type: r.type, config: r.config, createdBy: r.created_by, createdAt: r.created_at }));
  },
  async createReportTemplate(template) {
    const id = `rpt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      "INSERT INTO report_templates (id, name, type, config, created_by, created_at) VALUES ($1,$2,$3,$4,$5,now())",
      [id, template.name, template.type, JSON.stringify(template.config), template.createdBy]
    );
    return { id, ...template };
  },
  async updateReportTemplate(id, updates) {
    const sets = [];
    const params = [id];
    let idx = 2;
    if (updates.name !== undefined) { sets.push(`name = $${idx}`); params.push(updates.name); idx++; }
    if (updates.config !== undefined) { sets.push(`config = $${idx}`); params.push(JSON.stringify(updates.config)); idx++; }
    if (sets.length) await db.query(`UPDATE report_templates SET ${sets.join(", ")} WHERE id = $1`, params);
  },
  async deleteReportTemplate(id) {
    await db.query("DELETE FROM report_templates WHERE id = $1", [id]);
  },
  async generateReport(templateId, params) {
    const { rows } = await db.query("SELECT * FROM report_templates WHERE id = $1", [templateId]);
    if (!rows.length) throw new Error("Template not found");
    const template = rows[0];
    const cfg = template.config;
    let data = [];
    let columns = [];

    if (template.type === "readings") {
      let query = "SELECT r.*, d.name as device_name FROM readings r LEFT JOIN devices d ON r.device_id = d.id WHERE 1=1";
      const qParams = [];
      let idx = 1;
      if (cfg.deviceIds?.length) { query += ` AND r.device_id IN (${cfg.deviceIds.map((_, i) => `$${idx + i}`).join(",")})`; qParams.push(...cfg.deviceIds); idx += cfg.deviceIds.length; }
      if (cfg.from) { query += ` AND r.ts >= $${idx}`; qParams.push(cfg.from); idx++; }
      if (cfg.to) { query += ` AND r.ts <= $${idx}`; qParams.push(cfg.to); idx++; }
      query += " ORDER BY r.ts DESC";
      if (cfg.limit) { query += ` LIMIT ${Math.min(cfg.limit, 10000)}`; }
      const { rows: rData } = await db.query(query, qParams);
      data = rData.map(r => ({ timestamp: r.ts, device: r.device_name, deviceId: r.device_id, target: r.target_weight, actual: r.actual_weight, diff: r.actual_weight - r.target_weight, batchId: r.batch_id }));
      columns = ["timestamp", "device", "target", "actual", "diff", "batchId"];
    } else if (template.type === "alerts") {
      let query = "SELECT ah.*, d.name as device_name FROM alert_history ah LEFT JOIN devices d ON ah.device_id = d.id WHERE 1=1";
      const qParams = [];
      let idx = 1;
      if (cfg.deviceIds?.length) { query += ` AND ah.device_id IN (${cfg.deviceIds.map((_, i) => `$${idx + i}`).join(",")})`; qParams.push(...cfg.deviceIds); idx += cfg.deviceIds.length; }
      if (cfg.from) { query += ` AND ah.ts >= $${idx}`; qParams.push(cfg.from); idx++; }
      if (cfg.to) { query += ` AND ah.ts <= $${idx}`; qParams.push(cfg.to); idx++; }
      if (cfg.severity) { query += ` AND ah.severity = $${idx}`; qParams.push(cfg.severity); idx++; }
      query += " ORDER BY ah.ts DESC LIMIT 10000";
      const { rows: aData } = await db.query(query, qParams);
      data = aData.map(r => ({ timestamp: r.ts, device: r.device_name, severity: r.severity, message: r.message, resolved: r.resolved }));
      columns = ["timestamp", "device", "severity", "message", "resolved"];
    } else if (template.type === "production") {
      let query = "SELECT b.*, d.name as device_name, p.name as product_name FROM batches b LEFT JOIN devices d ON b.device_id = d.id LEFT JOIN products p ON b.product_id = p.id WHERE 1=1";
      const qParams = [];
      let idx = 1;
      if (cfg.status) { query += ` AND b.status = $${idx}`; qParams.push(cfg.status); idx++; }
      if (cfg.from) { query += ` AND b.started_at >= $${idx}`; qParams.push(cfg.from); idx++; }
      if (cfg.to) { query += ` AND b.started_at <= $${idx}`; qParams.push(cfg.to); idx++; }
      query += " ORDER BY b.started_at DESC LIMIT 10000";
      const { rows: pData } = await db.query(query, qParams);
      data = pData.map(r => ({ name: r.name, customer: r.customer, product: r.product_name, device: r.device_name, status: r.status, totalBags: r.total_bags, targetBags: r.target_bags, started: r.started_at, completed: r.completed_at }));
      columns = ["name", "customer", "product", "device", "status", "totalBags", "targetBags", "started", "completed"];
    }

    return { template: template.name, type: template.type, columns, data, generatedAt: new Date().toISOString(), rowCount: data.length };
  },

  // --- Integrations ---
  async listIntegrations() {
    const { rows } = await db.query("SELECT * FROM integrations ORDER BY created_at");
    return rows.map(r => ({ id: r.id, name: r.name, type: r.type, config: { ...r.config, apiKey: r.config.apiKey ? "••••••" : undefined }, enabled: r.enabled, lastSyncAt: r.last_sync_at }));
  },
  async createIntegration(integration) {
    const id = `int_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      "INSERT INTO integrations (id, name, type, config, enabled, created_at) VALUES ($1,$2,$3,$4,$5,now())",
      [id, integration.name, integration.type, JSON.stringify(integration.config), integration.enabled !== false]
    );
    return { id, ...integration };
  },
  async updateIntegration(id, updates) {
    const sets = [];
    const params = [id];
    let idx = 2;
    if (updates.name !== undefined) { sets.push(`name = $${idx}`); params.push(updates.name); idx++; }
    if (updates.config !== undefined) { sets.push(`config = $${idx}`); params.push(JSON.stringify(updates.config)); idx++; }
    if (updates.enabled !== undefined) { sets.push(`enabled = $${idx}`); params.push(updates.enabled); idx++; }
    if (sets.length) await db.query(`UPDATE integrations SET ${sets.join(", ")} WHERE id = $1`, params);
  },
  async deleteIntegration(id) {
    await db.query("DELETE FROM integration_logs WHERE integration_id = $1", [id]);
    await db.query("DELETE FROM integrations WHERE id = $1", [id]);
  },
  async logIntegration(integrationId, direction, status, request, response, error) {
    const id = `il_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      "INSERT INTO integration_logs (id, integration_id, direction, status, request, response, error, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())",
      [id, integrationId, direction, status, request ? JSON.stringify(request) : null, response ? JSON.stringify(response) : null, error || null]
    );
  },
  async listIntegrationLogs(integrationId, limit) {
    const query = integrationId
      ? "SELECT * FROM integration_logs WHERE integration_id = $1 ORDER BY created_at DESC LIMIT $2"
      : "SELECT * FROM integration_logs ORDER BY created_at DESC LIMIT $1";
    const params = integrationId ? [integrationId, limit || 50] : [limit || 50];
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, integrationId: r.integration_id, direction: r.direction, status: r.status, request: r.request, response: r.response, error: r.error, createdAt: r.created_at }));
  },
  async sendWebhook(url, payload) {
    const fetch = require("node-fetch");
    const startTime = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeout: 10000
      });
      const elapsed = Date.now() - startTime;
      const responseText = await res.text();
      return { status: res.ok ? "success" : "error", statusCode: res.status, response: responseText.slice(0, 1000), elapsed };
    } catch (e) {
      return { status: "error", error: e.message, elapsed: Date.now() - startTime };
    }
  },

  // ============================================================
  // PHASE 7: Integrations + Enterprise — ERP/MES, Export, Webhooks
  // ============================================================

  // --- Integration Mappings ---
  async listIntegrationMappings(integrationId) {
    let query = "SELECT * FROM integration_mappings";
    const params = [];
    if (integrationId) { query += " WHERE integration_id = $1"; params.push(integrationId); }
    query += " ORDER BY created_at";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, integrationId: r.integration_id, entityType: r.entity_type, fieldMapping: r.field_mapping, transformRules: r.transform_rules, enabled: r.enabled, createdAt: r.created_at }));
  },
  async createIntegrationMapping(mapping) {
    const id = `im_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      `INSERT INTO integration_mappings (id, integration_id, entity_type, field_mapping, transform_rules, enabled, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())`,
      [id, mapping.integrationId, mapping.entityType, JSON.stringify(mapping.fieldMapping || {}), JSON.stringify(mapping.transformRules || {}), mapping.enabled !== false]
    );
    return { id, ...mapping, createdAt: new Date().toISOString() };
  },
  async updateIntegrationMapping(id, updates) {
    const sets = [];
    const params = [id];
    let idx = 2;
    if (updates.fieldMapping !== undefined) { sets.push(`field_mapping = $${idx}`); params.push(JSON.stringify(updates.fieldMapping)); idx++; }
    if (updates.transformRules !== undefined) { sets.push(`transform_rules = $${idx}`); params.push(JSON.stringify(updates.transformRules)); idx++; }
    if (updates.enabled !== undefined) { sets.push(`enabled = $${idx}`); params.push(updates.enabled); idx++; }
    if (sets.length) await db.query(`UPDATE integration_mappings SET ${sets.join(", ")} WHERE id = $1`, params);
  },
  async deleteIntegrationMapping(id) {
    await db.query("DELETE FROM integration_mappings WHERE id = $1", [id]);
  },

  // --- Webhook Configurations ---
  async listWebhookConfigs(integrationId) {
    let query = "SELECT * FROM webhook_configs";
    const params = [];
    if (integrationId) { query += " WHERE integration_id = $1"; params.push(integrationId); }
    query += " ORDER BY created_at";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, integrationId: r.integration_id, url: r.url, secret: r.secret ? "••••••" : null, events: r.events, retryCount: r.retry_count, retryDelayMs: r.retry_delay_ms, timeoutMs: r.timeout_ms, headers: r.headers, enabled: r.enabled, lastTriggeredAt: r.last_triggered_at, createdAt: r.created_at }));
  },
  async createWebhookConfig(config) {
    const id = `wh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      `INSERT INTO webhook_configs (id, integration_id, url, secret, events, retry_count, retry_delay_ms, timeout_ms, headers, enabled, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
      [id, config.integrationId, config.url, config.secret || null, config.events || "*", config.retryCount || 3, config.retryDelayMs || 5000, config.timeoutMs || 10000, JSON.stringify(config.headers || {}), config.enabled !== false]
    );
    return { id, ...config, createdAt: new Date().toISOString() };
  },
  async updateWebhookConfig(id, updates) {
    const sets = [];
    const params = [id];
    let idx = 2;
    if (updates.url !== undefined) { sets.push(`url = $${idx}`); params.push(updates.url); idx++; }
    if (updates.secret !== undefined) { sets.push(`secret = $${idx}`); params.push(updates.secret); idx++; }
    if (updates.events !== undefined) { sets.push(`events = $${idx}`); params.push(updates.events); idx++; }
    if (updates.retryCount !== undefined) { sets.push(`retry_count = $${idx}`); params.push(updates.retryCount); idx++; }
    if (updates.enabled !== undefined) { sets.push(`enabled = $${idx}`); params.push(updates.enabled); idx++; }
    if (sets.length) await db.query(`UPDATE webhook_configs SET ${sets.join(", ")} WHERE id = $1`, params);
  },
  async deleteWebhookConfig(id) {
    await db.query("DELETE FROM webhook_configs WHERE id = $1", [id]);
  },
  async fireWebhookWithRetry(webhookId, event, payload) {
    const { rows } = await db.query("SELECT * FROM webhook_configs WHERE id = $1 AND enabled = true", [webhookId]);
    if (!rows[0]) return { success: false, error: "Webhook not found or disabled" };
    const wh = rows[0];
    if (wh.events.length && !wh.events.includes("*") && !wh.events.includes(event)) return { success: false, error: "Event not in webhook events list" };

    // Generate signature if secret exists
    let signature = null;
    if (wh.secret) {
      const crypto = require("crypto");
      signature = crypto.createHmac("sha256", wh.secret).update(JSON.stringify(payload)).digest("hex");
    }

    let lastError = null;
    for (let attempt = 0; attempt <= wh.retry_count; attempt++) {
      try {
        const fetch = require("node-fetch");
        const headers = { "Content-Type": "application/json", ...wh.headers };
        if (signature) headers["X-Webhook-Signature"] = signature;
        headers["X-Webhook-Event"] = event;
        headers["X-Webhook-Attempt"] = String(attempt + 1);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), wh.timeout_ms);
        const res = await fetch(wh.url, { method: "POST", headers, body: JSON.stringify({ event, payload, timestamp: new Date().toISOString() }), signal: controller.signal });
        clearTimeout(timeout);

        await db.query("UPDATE webhook_configs SET last_triggered_at = now() WHERE id = $1", [webhookId]);
        if (res.ok) return { success: true, statusCode: res.status, attempt: attempt + 1 };
        lastError = `HTTP ${res.status}`;
      } catch (e) {
        lastError = e.message;
      }
      if (attempt < wh.retry_count) await new Promise(r => setTimeout(r, wh.retry_delay_ms));
    }
    return { success: false, error: lastError, attempts: wh.retry_count + 1 };
  },

  // --- Data Export Jobs ---
  async createExportJob(job) {
    const id = `ej_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      `INSERT INTO data_export_jobs (id, user_id, export_type, format, filters, status, created_at)
       VALUES ($1,$2,$3,$4,$5,'pending',now())`,
      [id, job.userId, job.exportType, job.format || "csv", JSON.stringify(job.filters || {})]
    );
    return { id, ...job, status: "pending", createdAt: new Date().toISOString() };
  },
  async updateExportJob(id, updates) {
    const sets = [];
    const params = [id];
    let idx = 2;
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined) {
        const col = k === "userId" ? "user_id" : k === "exportType" ? "export_type" : k === "fileUrl" ? "file_url" : k === "fileSize" ? "file_size" : k === "recordCount" ? "record_count" : k === "completedAt" ? "completed_at" : k;
        sets.push(`${col} = $${idx}`); params.push(typeof v === "object" ? JSON.stringify(v) : v); idx++;
      }
    }
    if (sets.length) await db.query(`UPDATE data_export_jobs SET ${sets.join(", ")} WHERE id = $1`, params);
  },
  async getExportJob(id) {
    const { rows } = await db.query("SELECT * FROM data_export_jobs WHERE id = $1", [id]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { id: r.id, userId: r.user_id, exportType: r.export_type, format: r.format, filters: r.filters, status: r.status, fileUrl: r.file_url, fileSize: r.file_size, recordCount: r.record_count, error: r.error, createdAt: r.created_at, completedAt: r.completed_at };
  },
  async generateExportData(exportType, filters = {}) {
    let data = [], columns = [];
    if (exportType === "readings") {
      let query = "SELECT * FROM readings";
      const params = [];
      if (filters.deviceId) { params.push(filters.deviceId); query += ` WHERE device_id = $${params.length}`; }
      if (filters.from) { params.push(filters.from); query += `${params.length > 1 ? " AND" : " WHERE"} ts >= $${params.length}`; }
      if (filters.to) { params.push(filters.to); query += `${params.length > 1 ? " AND" : " WHERE"} ts <= $${params.length}`; }
      query += " ORDER BY ts DESC LIMIT 50000";
      const { rows } = await db.query(query, params);
      data = rows.map(r => ({ timestamp: r.ts, device_id: r.device_id, weight: r.weight, phase: r.phase, bag_count: r.bag_count, connected: r.connected }));
      columns = ["timestamp", "device_id", "weight", "phase", "bag_count", "connected"];
    } else if (exportType === "telemetry") {
      let query = "SELECT * FROM telemetry";
      const params = [];
      if (filters.deviceId) { params.push(filters.deviceId); query += ` WHERE device_id = $${params.length}`; }
      if (filters.metric) { params.push(filters.metric); query += `${params.length > 1 ? " AND" : " WHERE"} metric = $${params.length}`; }
      if (filters.from) { params.push(filters.from); query += `${params.length > 1 ? " AND" : " WHERE"} ts >= $${params.length}`; }
      if (filters.to) { params.push(filters.to); query += `${params.length > 1 ? " AND" : " WHERE"} ts <= $${params.length}`; }
      query += " ORDER BY ts DESC LIMIT 50000";
      const { rows } = await db.query(query, params);
      data = rows.map(r => ({ timestamp: r.ts, device_id: r.device_id, metric: r.metric, value: r.value, unit: r.unit }));
      columns = ["timestamp", "device_id", "metric", "value", "unit"];
    } else if (exportType === "alerts") {
      let query = "SELECT * FROM alert_history";
      const params = [];
      if (filters.deviceId) { params.push(filters.deviceId); query += ` WHERE device_id = $${params.length}`; }
      if (filters.from) { params.push(filters.from); query += `${params.length > 1 ? " AND" : " WHERE"} ts >= $${params.length}`; }
      query += " ORDER BY ts DESC LIMIT 50000";
      const { rows } = await db.query(query, params);
      data = rows.map(r => ({ timestamp: r.ts, device_id: r.device_id, device_name: r.device_name, type: r.type, severity: r.severity, message: r.message, active: r.active, resolved_at: r.resolved_at }));
      columns = ["timestamp", "device_id", "device_name", "type", "severity", "message", "active", "resolved_at"];
    } else if (exportType === "maintenance") {
      const records = await store.listMaintenanceRecords(filters.deviceId);
      data = records.map(r => ({ id: r.id, device_id: r.deviceId, work_order: r.workOrderNumber, status: r.status, type: r.maintenanceType, priority: r.priority, due_date: r.dueDate, completed_at: r.completedAt, technician: r.technician, total_cost: r.totalCost, downtime_minutes: r.downtimeMinutes, failure_mode: r.failureMode, root_cause: r.rootCause }));
      columns = ["id", "device_id", "work_order", "status", "type", "priority", "due_date", "completed_at", "technician", "total_cost", "downtime_minutes", "failure_mode", "root_cause"];
    } else if (exportType === "production") {
      const orders = await store.listProductionOrders(filters);
      data = orders.map(o => ({ id: o.id, order_number: o.orderNumber, product_id: o.productId, device_id: o.deviceId, status: o.status, planned_quantity: o.plannedQuantity, actual_quantity: o.actualQuantity, good_quantity: o.goodQuantity, reject_quantity: o.rejectQuantity, unit: o.unit, planned_start: o.plannedStart, actual_end: o.actualEnd, customer: o.customer }));
      columns = ["id", "order_number", "product_id", "device_id", "status", "planned_quantity", "actual_quantity", "good_quantity", "reject_quantity", "unit", "planned_start", "actual_end", "customer"];
    } else if (exportType === "devices") {
      const devs = await store.listDevices();
      data = devs.map(d => ({ id: d.id, name: d.name, protocol: d.protocol, ip: d.ip, port: d.port, product_id: d.productId, target: d.target, tolerance: d.tolerance, status: d.status, group_id: d.groupId, site_id: d.siteId, asset_type_id: d.assetTypeId }));
      columns = ["id", "name", "protocol", "ip", "port", "product_id", "target", "tolerance", "status", "group_id", "site_id", "asset_type_id"];
    }
    return { data, columns, count: data.length };
  },
  async convertToCSV(data, columns) {
    if (!data.length) return "";
    const header = columns.join(",");
    const rows = data.map(row => columns.map(col => {
      const val = row[col];
      if (val === null || val === undefined) return "";
      const str = String(val);
      return str.includes(",") || str.includes('"') || str.includes("\n") ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(","));
    return [header, ...rows].join("\n");
  },

  // --- Data Import Jobs ---
  async createImportJob(job) {
    const id = `ij_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      `INSERT INTO data_import_jobs (id, user_id, import_type, file_name, status, created_at)
       VALUES ($1,$2,$3,$4,'pending',now())`,
      [id, job.userId, job.importType, job.fileName || null]
    );
    return { id, ...job, status: "pending", createdAt: new Date().toISOString() };
  },
  async updateImportJob(id, updates) {
    const sets = [];
    const params = [id];
    let idx = 2;
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined) {
        const col = k === "userId" ? "user_id" : k === "importType" ? "import_type" : k === "fileName" ? "file_name" : k === "totalRows" ? "total_rows" : k === "processedRows" ? "processed_rows" : k === "validRows" ? "valid_rows" : k === "errorRows" ? "error_rows" : k === "completedAt" ? "completed_at" : k;
        sets.push(`${col} = $${idx}`); params.push(typeof v === "object" ? JSON.stringify(v) : v); idx++;
      }
    }
    if (sets.length) await db.query(`UPDATE data_import_jobs SET ${sets.join(", ")} WHERE id = $1`, params);
  },
  async getImportJob(id) {
    const { rows } = await db.query("SELECT * FROM data_import_jobs WHERE id = $1", [id]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { id: r.id, userId: r.user_id, importType: r.import_type, fileName: r.file_name, status: r.status, totalRows: r.total_rows, processedRows: r.processed_rows, validRows: r.valid_rows, errorRows: r.error_rows, errors: r.errors, result: r.result, createdAt: r.created_at, completedAt: r.completed_at };
  },
  async validateImportData(importType, data) {
    const errors = [];
    let validCount = 0;
    let errorCount = 0;

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowErrors = [];

      if (importType === "devices") {
        if (!row.name) rowErrors.push("name is required");
        if (!row.protocol) rowErrors.push("protocol is required");
      } else if (importType === "products") {
        if (!row.name) rowErrors.push("name is required");
        if (row.targetWeight && isNaN(Number(row.targetWeight))) rowErrors.push("targetWeight must be a number");
      } else if (importType === "telemetry") {
        if (!row.device_id && !row.deviceId) rowErrors.push("device_id is required");
        if (!row.metric) rowErrors.push("metric is required");
        if (row.value === undefined || row.value === null) rowErrors.push("value is required");
        else if (isNaN(Number(row.value))) rowErrors.push("value must be a number");
      }

      if (rowErrors.length) {
        errors.push({ row: i + 1, errors: rowErrors });
        errorCount++;
      } else {
        validCount++;
      }
    }

    return { total: data.length, valid: validCount, errors: errorCount, validationErrors: errors.slice(0, 100) };
  },

  // --- API Discovery ---
  async getAPIDiscovery() {
    return {
      version: "1.0.0",
      name: "Scale IoT Platform API",
      description: "Industrial Operations Intelligence Platform API",
      baseUrl: "/api",
      modules: [
        { name: "Devices", path: "/devices", methods: ["GET", "POST", "PUT", "DELETE"], description: "Manage IoT devices" },
        { name: "Readings", path: "/devices/:id/readings", methods: ["GET"], description: "Device readings" },
        { name: "Telemetry", path: "/telemetry", methods: ["GET", "POST"], description: "Telemetry data" },
        { name: "Products", path: "/products", methods: ["GET", "POST", "PUT", "DELETE"], description: "Product management" },
        { name: "Alerts", path: "/alerts", methods: ["GET"], description: "Active alerts" },
        { name: "Alert Rules", path: "/alert-rules", methods: ["GET", "POST", "PUT", "DELETE"], description: "Alert rule configuration" },
        { name: "Maintenance", path: "/maintenance", methods: ["GET", "POST", "PUT", "DELETE"], description: "Maintenance records" },
        { name: "Maintenance Schedules", path: "/maintenance-schedules", methods: ["GET", "POST", "PUT", "DELETE"], description: "Preventive maintenance schedules" },
        { name: "Maintenance Failures", path: "/maintenance-failures", methods: ["GET", "POST", "PUT"], description: "Failure tracking" },
        { name: "Calibration", path: "/calibrations", methods: ["GET", "POST", "DELETE"], description: "Calibration records" },
        { name: "Production Orders", path: "/production-orders", methods: ["GET", "POST", "PUT", "DELETE"], description: "Production order management" },
        { name: "Quality Metrics", path: "/quality-metrics", methods: ["GET", "POST"], description: "Quality measurements" },
        { name: "Shift Templates", path: "/shift-templates", methods: ["GET", "POST", "PUT", "DELETE"], description: "Shift schedule templates" },
        { name: "SPC Analysis", path: "/devices/:id/spc", methods: ["GET"], description: "Statistical Process Control" },
        { name: "OEE Dashboard", path: "/devices/:id/oee", methods: ["GET"], description: "Overall Equipment Effectiveness" },
        { name: "AI Insights", path: "/ai-insights", methods: ["GET", "POST", "PUT"], description: "AI-generated insights" },
        { name: "ML Models", path: "/ml-models", methods: ["GET", "POST", "DELETE"], description: "Machine learning models" },
        { name: "ML Predictions", path: "/ml-predictions", methods: ["GET"], description: "ML prediction history" },
        { name: "Anomaly Detection", path: "/devices/:id/anomalies", methods: ["GET"], description: "Anomaly detection" },
        { name: "Drift Detection", path: "/devices/:id/drift", methods: ["GET"], description: "Drift detection" },
        { name: "Forecasting", path: "/devices/:id/forecast", methods: ["GET"], description: "Time-series forecasting" },
        { name: "Health History", path: "/devices/:id/health-history", methods: ["GET", "POST"], description: "Health score history" },
        { name: "Health Trend", path: "/devices/:id/health-trend", methods: ["GET"], description: "Health trend analysis" },
        { name: "RUL Estimation", path: "/devices/:id/rul", methods: ["GET"], description: "Remaining Useful Life" },
        { name: "Failure Analysis", path: "/devices/:id/failure-analysis", methods: ["GET"], description: "Failure mode analysis" },
        { name: "Cost Analysis", path: "/devices/:id/cost-analysis", methods: ["GET"], description: "Maintenance cost optimization" },
        { name: "Maintenance Recommendations", path: "/devices/:id/maintenance-recommendations", methods: ["GET"], description: "Maintenance optimization" },
        { name: "Device Health", path: "/device-health", methods: ["GET"], description: "Device health scores" },
        { name: "Hierarchy", path: "/hierarchy", methods: ["GET"], description: "Site/Area/Line/Station hierarchy" },
        { name: "Asset Types", path: "/asset-types", methods: ["GET", "POST", "PUT", "DELETE"], description: "Asset type definitions" },
        { name: "Sensors", path: "/sensors", methods: ["GET", "POST", "PUT", "DELETE"], description: "Sensor management" },
        { name: "Integrations", path: "/integrations", methods: ["GET", "POST", "PUT", "DELETE"], description: "External integrations" },
        { name: "Integration Mappings", path: "/integration-mappings", methods: ["GET", "POST", "PUT", "DELETE"], description: "Field mapping configuration" },
        { name: "Webhooks", path: "/webhook-configs", methods: ["GET", "POST", "PUT", "DELETE"], description: "Webhook configurations" },
        { name: "Export", path: "/export", methods: ["POST"], description: "Data export" },
        { name: "Import", path: "/import", methods: ["POST"], description: "Data import" },
        { name: "Reports", path: "/reports", methods: ["GET", "POST"], description: "Report generation" },
        { name: "Users", path: "/users", methods: ["GET", "POST", "PUT", "DELETE"], description: "User management" },
        { name: "Organizations", path: "/organizations", methods: ["GET", "POST", "PUT", "DELETE"], description: "Multi-tenancy" },
      ],
      authentication: { type: "JWT Bearer Token", header: "Authorization: Bearer <token>" },
    };
  },

  // --- Push Subscriptions ---
  async savePushSubscription(userId, subscription) {
    const id = `ps_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    // Remove existing subscription for this endpoint
    await db.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [subscription.endpoint]);
    await db.query(
      "INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES ($1,$2,$3,$4,$5,now())",
      [id, userId, subscription.endpoint, subscription.keys?.p256dh || "", subscription.keys?.auth || ""]
    );
    return { id };
  },
  async removePushSubscription(endpoint) {
    await db.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
  },
  async getPushSubscriptions(userId) {
    const { rows } = await db.query("SELECT * FROM push_subscriptions WHERE user_id = $1", [userId]);
    return rows.map(r => ({ id: r.id, userId: r.user_id, endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
  },
  async getAllPushSubscriptions() {
    const { rows } = await db.query("SELECT * FROM push_subscriptions");
    return rows.map(r => ({ id: r.id, userId: r.user_id, endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
  },

  // --- gateway keys ---
  async listGatewayKeys() {
    const { rows } = await db.query("SELECT * FROM gateway_keys ORDER BY created_at");
    return rows.map(gatewayKeyFromRow);
  },
  async findGatewayKey(key) {
    const { rows } = await db.query("SELECT * FROM gateway_keys WHERE key = $1", [key]);
    return rows[0] ? gatewayKeyFromRow(rows[0]) : null;
  },
  async addGatewayKey(entry) {
    await db.query(
      "INSERT INTO gateway_keys (id, key, label, created_at) VALUES ($1,$2,$3,$4)",
      [entry.id, entry.key, entry.label, entry.createdAt]
    );
    return entry;
  },
  async removeGatewayKey(id) {
    await db.query("DELETE FROM gateway_keys WHERE id = $1", [id]);
  },

  // --- alert config ---
  async getAlertConfig() {
    const { rows } = await db.query("SELECT value FROM kv_config WHERE key = 'alertConfig'");
    return rows[0] ? { ...DEFAULT_ALERT_CONFIG, ...rows[0].value } : { ...DEFAULT_ALERT_CONFIG };
  },
  async setAlertConfig(partial) {
    const current = await store.getAlertConfig();
    const updated = { ...current, ...partial };
    await db.query(
      `INSERT INTO kv_config (key, value) VALUES ('alertConfig', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
      [JSON.stringify(updated)]
    );
    return updated;
  },

  // --- notification config (email + WhatsApp) ---
  DEFAULT_NOTIFICATION_CONFIG: {
    emailEnabled: false,
    emailRecipients: "",
    smtpUser: "",
    smtpPass: "",
    whatsappEnabled: false,
    whatsappRecipients: "",
    ultrammsgUrl: "https://api.ultramsg.com",
    ultrammsgToken: "",
    ultrammsgInstanceId: "",
    slackEnabled: false,
    slackWebhookUrl: "",
    teamsEnabled: false,
    teamsWebhookUrl: "",
    downtimeNotifyEnabled: true,
  },
  async getNotificationConfig() {
    const { rows } = await db.query("SELECT value FROM kv_config WHERE key = 'notificationConfig'");
    return rows[0] ? { ...store.DEFAULT_NOTIFICATION_CONFIG, ...rows[0].value } : { ...store.DEFAULT_NOTIFICATION_CONFIG };
  },
  async setNotificationConfig(partial) {
    const current = await store.getNotificationConfig();
    const updated = { ...current, ...partial };
    await db.query(
      `INSERT INTO kv_config (key, value) VALUES ('notificationConfig', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
      [JSON.stringify(updated)]
    );
    return updated;
  },

  // --- tolerance streaks (ephemeral) ---
  recordToleranceOutcome(deviceId, withinTolerance) {
    const current = toleranceStreaks.get(deviceId) || 0;
    const next = withinTolerance ? 0 : current + 1;
    toleranceStreaks.set(deviceId, next);
    return next;
  },

  // --- alerts ---
  async triggerAlert(deviceId, deviceName, type, message, severity = "warning") {
    const key = alertKey(deviceId, type);
    if (activeAlerts.has(key)) return null;
    const alert = { id: newId("a"), deviceId, deviceName, type, message, severity, since: new Date().toISOString(), active: true, resolvedAt: null };
    activeAlerts.set(key, alert);
    await db.query(
      `INSERT INTO alert_history (id, device_id, device_name, type, message, severity, since, active, resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [alert.id, alert.deviceId, alert.deviceName, alert.type, alert.message, alert.severity, alert.since, alert.active, alert.resolvedAt]
    );
    await enqueueSyncOutbox("alert", alert.id, "upsert", alert);
    return alert;
  },
  async resolveAlert(deviceId, type) {
    const key = alertKey(deviceId, type);
    const alert = activeAlerts.get(key);
    if (!alert) return null;
    activeAlerts.delete(key);
    alert.active = false;
    alert.resolvedAt = new Date().toISOString();
    await db.query("UPDATE alert_history SET active=false, resolved_at=$2 WHERE id=$1", [alert.id, alert.resolvedAt]);
    await enqueueSyncOutbox("alert", alert.id, "upsert", { ...alert });
    return { ...alert };
  },
  listActiveAlerts() {
    return [...activeAlerts.values()];
  },
  async listAlertHistory(limit = 50) {
    const { rows } = await db.query("SELECT * FROM alert_history ORDER BY since DESC LIMIT $1", [limit]);
    return rows.map(alertFromRow);
  },
  async listAlertHistoryInRange(fromIso, toIso, limit = 500) {
    const { rows } = await db.query(
      "SELECT * FROM alert_history WHERE since BETWEEN $1 AND $2 ORDER BY since DESC LIMIT $3",
      [fromIso, toIso, limit]
    );
    return rows.map(alertFromRow);
  },

  // --- audit log ---
  async logAudit(entry) {
    const record = { id: newId("log"), ts: new Date().toISOString(), ...entry };
    await db.query(
      "INSERT INTO audit_log (id, ts, username, role, action, details) VALUES ($1,$2,$3,$4,$5,$6)",
      [record.id, record.ts, record.username, record.role, record.action, JSON.stringify(record.details || {})]
    );
    await enqueueSyncOutbox("audit_log", record.id, "upsert", record);
    return record;
  },
  async listAuditLog(limit = 100) {
    const { rows } = await db.query("SELECT * FROM audit_log ORDER BY ts DESC LIMIT $1", [limit]);
    return rows.map((r) => ({ id: r.id, ts: r.ts, username: r.username, role: r.role, action: r.action, details: r.details }));
  },

  // --- products ---
  async listProducts() {
    const { rows } = await db.query("SELECT * FROM products ORDER BY created_at");
    return rows.map(productFromRow);
  },
  async getProduct(id) {
    const { rows } = await db.query("SELECT * FROM products WHERE id = $1", [id]);
    return rows[0] ? productFromRow(rows[0]) : null;
  },
  async addProduct(input) {
    const bounds = normalizeProductBounds(input);
    const product = {
      id: newId("p"), code: input.code, name: input.name, description: input.description || "",
      unit: input.unit || "kg", status: input.status || "active", createdAt: new Date().toISOString(), ...bounds,
    };
    await db.query(
      `INSERT INTO products (id, code, name, description, target_weight, min_weight, max_weight, unit, tolerance_type, tolerance_value, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [product.id, product.code, product.name, product.description, product.targetWeight, product.minWeight, product.maxWeight,
       product.unit, product.toleranceType, product.toleranceValue, product.status, product.createdAt]
    );
    await enqueueSyncOutbox("product", product.id, "upsert", product);
    return product;
  },
  async updateProduct(id, input) {
    const existing = await store.getProduct(id);
    if (!existing) return null;
    const bounds = normalizeProductBounds({ ...existing, ...input });
    const merged = {
      ...existing,
      code: input.code ?? existing.code, name: input.name ?? existing.name,
      description: input.description ?? existing.description, unit: input.unit ?? existing.unit,
      status: input.status ?? existing.status, ...bounds,
    };
    await db.query(
      `UPDATE products SET code=$2, name=$3, description=$4, target_weight=$5, min_weight=$6, max_weight=$7,
         unit=$8, tolerance_type=$9, tolerance_value=$10, status=$11 WHERE id=$1`,
      [id, merged.code, merged.name, merged.description, merged.targetWeight, merged.minWeight, merged.maxWeight,
       merged.unit, merged.toleranceType, merged.toleranceValue, merged.status]
    );
    const updated = await store.getProduct(id);
    await enqueueSyncOutbox("product", id, "upsert", updated);
    return updated;
  },
  async removeProduct(id) {
    const { rows: affected } = await db.query("SELECT id FROM devices WHERE product_id=$1", [id]);
    await db.query("DELETE FROM products WHERE id = $1", [id]);
    await db.query("UPDATE devices SET product_id=NULL WHERE product_id=$1", [id]);
    await enqueueSyncOutbox("product", id, "delete", null);
    // devices that referenced this product changed too (product_id cleared)
    // via raw SQL above, not through updateDevice() — sync those explicitly.
    for (const d of affected) {
      const updatedDevice = await store.getDevice(d.id);
      await enqueueSyncOutbox("device", d.id, "upsert", updatedDevice);
    }
  },
  // --- bag-level stats for a date range (used by date-range reports) ---
  async getBagStatsInRange(deviceId, fromIso, toIso) {
    const device = await store.getDevice(deviceId);
    if (!device) return { totalBags: 0, totalOverKg: 0, totalUnderKg: 0, totalCost: 0, countUnder: 0, countPass: 0, countOver: 0 };

    const product = device.productId ? await store.getProduct(device.productId) : null;
    const target = product ? product.targetWeight : device.target;

    const { rows } = await db.query(
      `SELECT weight, phase FROM readings
       WHERE device_id=$1 AND ts BETWEEN $2 AND $3 AND phase = 'settling' ORDER BY ts`,
      [deviceId, fromIso, toIso]
    );

    let totalBags = 0, totalOverKg = 0, totalUnderKg = 0, totalCost = 0;
    let countUnder = 0, countPass = 0, countOver = 0;

    for (const r of rows) {
      const w = Number(r.weight);
      const delta = w - target;
      const over = Math.max(delta, 0);
      const under = Math.max(-delta, 0);
      totalBags += 1;
      totalOverKg += over;
      totalUnderKg += under;
      totalCost += over * (device.costPerUnit || 0);

      const classification = product ? store.classifyWeight(w, product) : null;
      if (classification === "UNDER") countUnder++;
      else if (classification === "PASS") countPass++;
      else if (classification === "OVER") countOver++;
      else {
        // no product — use generic tolerance check
        const pct = Math.abs(delta / target) * 100;
        if (pct <= (await store.getAlertConfig()).toleranceThresholdPercent) countPass++;
        else if (delta > 0) countOver++;
        else countUnder++;
      }
    }

    return { totalBags, totalOverKg, totalUnderKg, totalCost, countUnder, countPass, countOver, since: fromIso };
  },

  classifyWeight,

  // --- maintenance ---
  async listMaintenanceRecords(deviceId) {
    const { rows } = deviceId
      ? await db.query("SELECT * FROM maintenance_records WHERE device_id=$1 ORDER BY created_at DESC", [deviceId])
      : await db.query("SELECT * FROM maintenance_records ORDER BY created_at DESC");
    return rows.map(maintenanceFromRow);
  },
  async getMaintenanceRecord(id) {
    const { rows } = await db.query("SELECT * FROM maintenance_records WHERE id=$1", [id]);
    return rows[0] ? maintenanceFromRow(rows[0]) : null;
  },
  async addMaintenanceRecord(input) {
    const partsCost = Number(input.partsCost) || 0;
    const labourCost = Number(input.labourCost) || 0;
    const record = {
      id: newId("m"), deviceId: input.deviceId, workOrderNumber: input.workOrderNumber || `WO-${Date.now()}`,
      status: input.status || "SCHEDULED", maintenanceType: input.maintenanceType || "corrective",
      priority: input.priority || "normal",
      scheduledDate: input.scheduledDate || null, dueDate: input.dueDate || null,
      intervalDays: input.intervalDays ? Number(input.intervalDays) : null, technician: input.technician || "",
      notes: input.notes || "", failureMode: input.failureMode || "", rootCause: input.rootCause || "",
      parts: input.parts || [], labourHours: Number(input.labourHours) || 0,
      labourCost, partsCost, totalCost: labourCost + partsCost,
      downtimeMinutes: Number(input.downtimeMinutes) || 0,
      attachments: input.attachments || [], metadata: input.metadata || {},
      createdAt: new Date().toISOString(), completedAt: null,
    };
    await db.query(
      `INSERT INTO maintenance_records (id, device_id, work_order_number, status, maintenance_type, priority, scheduled_date, due_date, interval_days,
         technician, notes, failure_mode, root_cause, parts, labour_hours, labour_cost, parts_cost, total_cost, downtime_minutes, attachments, metadata, created_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [record.id, record.deviceId, record.workOrderNumber, record.status, record.maintenanceType, record.priority,
       record.scheduledDate, record.dueDate, record.intervalDays, record.technician, record.notes,
       record.failureMode, record.rootCause, JSON.stringify(record.parts), record.labourHours,
       record.labourCost, record.partsCost, record.totalCost, record.downtimeMinutes,
       JSON.stringify(record.attachments), JSON.stringify(record.metadata), record.createdAt, record.completedAt]
    );
    await enqueueSyncOutbox("maintenance", record.id, "upsert", record);
    return record;
  },
  async updateMaintenanceRecord(id, input) {
    const existing = await store.getMaintenanceRecord(id);
    if (!existing) return null;
    const wasCompleted = existing.status === "COMPLETED";
    const merged = {
      ...existing,
      status: input.status ?? existing.status,
      maintenanceType: input.maintenanceType ?? existing.maintenanceType,
      priority: input.priority ?? existing.priority,
      scheduledDate: input.scheduledDate ?? existing.scheduledDate,
      dueDate: input.dueDate ?? existing.dueDate,
      intervalDays: input.intervalDays !== undefined ? (Number(input.intervalDays) || null) : existing.intervalDays,
      technician: input.technician ?? existing.technician, notes: input.notes ?? existing.notes,
      failureMode: input.failureMode ?? existing.failureMode,
      rootCause: input.rootCause ?? existing.rootCause,
      parts: input.parts ?? existing.parts,
      labourHours: input.labourHours !== undefined ? Number(input.labourHours) : existing.labourHours,
      labourCost: input.labourCost !== undefined ? Number(input.labourCost) : existing.labourCost,
      partsCost: input.partsCost !== undefined ? Number(input.partsCost) : existing.partsCost,
      downtimeMinutes: input.downtimeMinutes !== undefined ? Number(input.downtimeMinutes) : existing.downtimeMinutes,
      attachments: input.attachments ?? existing.attachments,
      metadata: input.metadata ?? existing.metadata,
    };
    merged.totalCost = (merged.labourCost || 0) + (merged.partsCost || 0);
    if (!wasCompleted && merged.status === "COMPLETED") merged.completedAt = new Date().toISOString();

    await db.query(
      `UPDATE maintenance_records SET status=$2, maintenance_type=$3, priority=$4, scheduled_date=$5, due_date=$6, interval_days=$7, technician=$8,
         notes=$9, failure_mode=$10, root_cause=$11, parts=$12, labour_hours=$13, labour_cost=$14, parts_cost=$15, total_cost=$16,
         downtime_minutes=$17, attachments=$18, metadata=$19, completed_at=$20
       WHERE id=$1`,
      [id, merged.status, merged.maintenanceType, merged.priority, merged.scheduledDate, merged.dueDate, merged.intervalDays,
       merged.technician, merged.notes, merged.failureMode, merged.rootCause,
       JSON.stringify(merged.parts), merged.labourHours, merged.labourCost, merged.partsCost, merged.totalCost,
       merged.downtimeMinutes, JSON.stringify(merged.attachments), JSON.stringify(merged.metadata), merged.completedAt]
    );

    let nextRecord = null;
    if (!wasCompleted && merged.status === "COMPLETED" && merged.intervalDays) {
      const nextDue = new Date(Date.now() + merged.intervalDays * 24 * 60 * 60 * 1000).toISOString();
      nextRecord = await store.addMaintenanceRecord({
        deviceId: merged.deviceId, workOrderNumber: `WO-${Date.now()}`, status: "SCHEDULED",
        maintenanceType: merged.maintenanceType, priority: merged.priority,
        dueDate: nextDue, intervalDays: merged.intervalDays, technician: merged.technician,
      });
    }
    const record = await store.getMaintenanceRecord(id);
    await enqueueSyncOutbox("maintenance", id, "upsert", record);
    return { record, nextRecord };
  },
  async removeMaintenanceRecord(id) {
    await db.query("DELETE FROM maintenance_records WHERE id=$1", [id]);
    await enqueueSyncOutbox("maintenance", id, "delete", null);
  },
  async listMaintenanceDue(withinDays = 7) {
    const { rows } = await db.query(
      `SELECT * FROM maintenance_records WHERE status='SCHEDULED' AND due_date IS NOT NULL
         AND due_date <= now() + ($1 || ' days')::interval ORDER BY due_date`,
      [withinDays]
    );
    return rows.map(maintenanceFromRow);
  },

  // --- maintenance schedules (preventive maintenance) ---
  async listMaintenanceSchedules(filters = {}) {
    let query = "SELECT * FROM maintenance_schedules";
    const params = [];
    const conditions = [];
    if (filters.deviceId) { params.push(filters.deviceId); conditions.push(`device_id = $${params.length}`); }
    if (filters.orgId) { params.push(filters.orgId); conditions.push(`org_id = $${params.length}`); }
    if (conditions.length) query += " WHERE " + conditions.join(" AND ");
    query += " ORDER BY created_at DESC";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, orgId: r.org_id, deviceId: r.device_id, name: r.name, maintenanceType: r.maintenance_type, intervalDays: r.interval_days, intervalHours: r.interval_hours, intervalCycles: r.interval_cycles, reminderDays: r.reminder_days, priority: r.priority, technician: r.technician, notes: r.notes, checklist: r.checklist, enabled: r.enabled, lastGeneratedAt: r.last_generated_at, createdAt: r.created_at }));
  },
  async createMaintenanceSchedule(schedule) {
    const id = `ms_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      `INSERT INTO maintenance_schedules (id, org_id, device_id, name, maintenance_type, interval_days, interval_hours, interval_cycles, reminder_days, priority, technician, notes, checklist, enabled, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())`,
      [id, schedule.orgId || null, schedule.deviceId, schedule.name, schedule.maintenanceType || "preventive",
       schedule.intervalDays, schedule.intervalHours || null, schedule.intervalCycles || null,
       schedule.reminderDays || 7, schedule.priority || "normal", schedule.technician || "",
       schedule.notes || "", JSON.stringify(schedule.checklist || []), schedule.enabled !== false]
    );
    return { id, ...schedule, createdAt: new Date().toISOString() };
  },
  async updateMaintenanceSchedule(id, updates) {
    const sets = [];
    const params = [id];
    let idx = 2;
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined && k !== "id") {
        const col = k === "orgId" ? "org_id" : k === "deviceId" ? "device_id" : k === "maintenanceType" ? "maintenance_type" : k === "intervalDays" ? "interval_days" : k === "intervalHours" ? "interval_hours" : k === "intervalCycles" ? "interval_cycles" : k === "reminderDays" ? "reminder_days" : k === "checklist" ? "checklist" : k;
        const val = k === "checklist" ? JSON.stringify(v) : v;
        sets.push(`${col} = $${idx}`); params.push(val); idx++;
      }
    }
    if (sets.length) await db.query(`UPDATE maintenance_schedules SET ${sets.join(", ")} WHERE id = $1`, params);
  },
  async deleteMaintenanceSchedule(id) {
    await db.query("DELETE FROM maintenance_schedules WHERE id = $1", [id]);
  },
  async generateMaintenanceFromSchedules() {
    const { rows: schedules } = await db.query(
      "SELECT * FROM maintenance_schedules WHERE enabled = true"
    );
    const generated = [];
    for (const s of schedules) {
      if (!s.interval_days) continue;
      const lastGen = s.last_generated_at ? new Date(s.last_generated_at).getTime() : 0;
      const intervalMs = s.interval_days * 24 * 60 * 60 * 1000;
      if (Date.now() - lastGen >= intervalMs) {
        const dueDate = new Date(Date.now() + (s.reminder_days || 7) * 24 * 60 * 60 * 1000).toISOString();
        const record = await store.addMaintenanceRecord({
          deviceId: s.device_id, workOrderNumber: `PM-${Date.now()}`, status: "SCHEDULED",
          maintenanceType: s.maintenance_type || "preventive", priority: s.priority,
          dueDate, intervalDays: s.interval_days, technician: s.technician,
          notes: s.notes || "", metadata: { scheduleId: s.id, checklist: s.checklist },
        });
        await db.query("UPDATE maintenance_schedules SET last_generated_at = now() WHERE id = $1", [s.id]);
        generated.push(record);
      }
    }
    return generated;
  },

  // --- maintenance failures ---
  async listMaintenanceFailures(filters = {}) {
    let query = "SELECT * FROM maintenance_failures";
    const params = [];
    const conditions = [];
    if (filters.deviceId) { params.push(filters.deviceId); conditions.push(`device_id = $${params.length}`); }
    if (conditions.length) query += " WHERE " + conditions.join(" AND ");
    query += " ORDER BY occurred_at DESC LIMIT 200";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, deviceId: r.device_id, failureType: r.failure_type, failureMode: r.failure_mode, severity: r.severity, description: r.description, rootCause: r.root_cause, resolution: r.resolution, downtimeMinutes: r.downtime_minutes, cost: Number(r.cost), occurredAt: r.occurred_at, resolvedAt: r.resolved_at, maintenanceId: r.maintenance_id, createdAt: r.created_at }));
  },
  async addMaintenanceFailure(failure) {
    const id = `mf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      `INSERT INTO maintenance_failures (id, device_id, failure_type, failure_mode, severity, description, root_cause, resolution, downtime_minutes, cost, occurred_at, maintenance_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())`,
      [id, failure.deviceId, failure.failureType, failure.failureMode || "", failure.severity || "normal",
       failure.description || "", failure.rootCause || "", failure.resolution || "",
       failure.downtimeMinutes || 0, failure.cost || 0, failure.occurredAt || new Date().toISOString(), failure.maintenanceId || null]
    );
    return { id, ...failure, createdAt: new Date().toISOString() };
  },
  async resolveMaintenanceFailure(id, resolution) {
    await db.query("UPDATE maintenance_failures SET resolved_at = now(), resolution = $2 WHERE id = $1", [id, resolution || ""]);
  },

  // --- MTBF (Mean Time Between Failures) ---
  async calculateMTBF(deviceId) {
    const { rows: failures } = await db.query(
      `SELECT occurred_at, resolved_at FROM maintenance_failures
       WHERE device_id = $1 AND occurred_at IS NOT NULL ORDER BY occurred_at`,
      [deviceId]
    );
    if (failures.length < 2) return { deviceId, mtbf: null, failureCount: failures.length, message: "Insufficient data" };

    let totalInterval = 0;
    let intervals = [];
    for (let i = 1; i < failures.length; i++) {
      const prev = new Date(failures[i - 1].occurred_at).getTime();
      const curr = new Date(failures[i].occurred_at).getTime();
      const diff = (curr - prev) / 3600000; // hours
      intervals.push(diff);
      totalInterval += diff;
    }
    const mtbf = totalInterval / intervals.length;
    const sorted = [...intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    return { deviceId, mtbf: Math.round(mtbf * 10) / 10, medianInterval: Math.round(median * 10) / 10, minInterval: Math.round(min * 10) / 10, maxInterval: Math.round(max * 10) / 10, failureCount: failures.length, unit: "hours" };
  },

  // --- maintenance cost analytics ---
  async getMaintenanceCosts(deviceId, from, to) {
    let query = "SELECT device_id, maintenance_type, SUM(labour_cost) as total_labour, SUM(parts_cost) as total_parts, SUM(total_cost) as total_cost, SUM(downtime_minutes) as total_downtime, COUNT(*) as record_count FROM maintenance_records WHERE status = 'COMPLETED'";
    const params = [];
    if (deviceId) { params.push(deviceId); query += " AND device_id = $" + params.length; }
    if (from) { params.push(from); query += " AND completed_at >= $" + params.length; }
    if (to) { params.push(to); query += " AND completed_at <= $" + params.length; }
    query += " GROUP BY device_id, maintenance_type ORDER BY total_cost DESC";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ deviceId: r.device_id, maintenanceType: r.maintenance_type, totalLabour: Number(r.total_labour), totalParts: Number(r.total_parts), totalCost: Number(r.total_cost), totalDowntime: Number(r.total_downtime), recordCount: Number(r.record_count) }));
  },

  // --- failure prediction ---
  async predictNextFailure(deviceId) {
    const mtbf = await store.calculateMTBF(deviceId);
    if (!mtbf.mtbf) return { deviceId, prediction: null, message: "Insufficient failure data for prediction" };

    const { rows: lastFailure } = await db.query(
      "SELECT occurred_at FROM maintenance_failures WHERE device_id = $1 ORDER BY occurred_at DESC LIMIT 1",
      [deviceId]
    );
    if (!lastFailure.length) return { deviceId, prediction: null, message: "No failure history" };

    const lastFailureTime = new Date(lastFailure[0].occurred_at).getTime();
    const predictedNext = lastFailureTime + mtbf.mtbf * 3600000;
    const now = Date.now();
    const hoursUntil = (predictedNext - now) / 3600000;
    const confidence = Math.max(0, Math.min(100, 100 - Math.abs(hoursUntil / mtbf.mtbf) * 50));

    // Get recent failures for context
    const { rows: recentFailures } = await db.query(
      "SELECT failure_type, failure_mode, occurred_at FROM maintenance_failures WHERE device_id = $1 ORDER BY occurred_at DESC LIMIT 5",
      [deviceId]
    );

    return {
      deviceId,
      predictedNextFailure: new Date(predictedNext).toISOString(),
      hoursUntilFailure: Math.round(hoursUntil * 10) / 10,
      confidence: Math.round(confidence),
      mtbf: mtbf.mtbf,
      recentFailures: recentFailures.map(f => ({ type: f.failure_type, mode: f.failure_mode, at: f.occurred_at })),
      recommendation: hoursUntil <= 0 ? "Failure may have already occurred — inspect immediately" :
                      hoursUntil <= 24 ? "Failure imminent — schedule immediate maintenance" :
                      hoursUntil <= 168 ? "Failure expected within a week — plan maintenance soon" :
                      "No immediate action needed",
    };
  },

  // --- calibration ---
  async listCalibrationRecords(deviceId) {
    const { rows } = deviceId
      ? await db.query("SELECT * FROM calibration_records WHERE device_id=$1 ORDER BY calibration_date DESC", [deviceId])
      : await db.query("SELECT * FROM calibration_records ORDER BY calibration_date DESC");
    return rows.map(calibrationFromRow);
  },
  async getLatestCalibration(deviceId) {
    const { rows } = await db.query(
      "SELECT * FROM calibration_records WHERE device_id=$1 ORDER BY calibration_date DESC LIMIT 1",
      [deviceId]
    );
    return rows[0] ? calibrationFromRow(rows[0]) : null;
  },
  async addCalibrationRecord(input) {
    const referenceWeight = Number(input.referenceWeight);
    const actualWeight = Number(input.actualWeight);
    const error = actualWeight - referenceWeight;
    const errorPercent = referenceWeight ? (error / referenceWeight) * 100 : 0;
    const record = {
      id: newId("c"), deviceId: input.deviceId, calibrationDate: input.calibrationDate || new Date().toISOString(),
      nextCalibrationDate: input.nextCalibrationDate || null, certificateNumber: input.certificateNumber || "",
      certificateFileUrl: input.certificateFileUrl || "", technician: input.technician || "",
      calibrationCompany: input.calibrationCompany || "", referenceWeight, actualWeight, error, errorPercent,
      passFail: input.passFail || (Math.abs(errorPercent) <= 0.5 ? "PASS" : "FAIL"),
      notes: input.notes || "", createdAt: new Date().toISOString(),
    };
    await db.query(
      `INSERT INTO calibration_records (id, device_id, calibration_date, next_calibration_date, certificate_number,
         certificate_file_url, technician, calibration_company, reference_weight, actual_weight, error, error_percent,
         pass_fail, notes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [record.id, record.deviceId, record.calibrationDate, record.nextCalibrationDate, record.certificateNumber,
       record.certificateFileUrl, record.technician, record.calibrationCompany, record.referenceWeight, record.actualWeight,
       record.error, record.errorPercent, record.passFail, record.notes, record.createdAt]
    );
    await enqueueSyncOutbox("calibration", record.id, "upsert", record);
    return record;
  },
  async removeCalibrationRecord(id) {
    await db.query("DELETE FROM calibration_records WHERE id=$1", [id]);
    await enqueueSyncOutbox("calibration", id, "delete", null);
  },

  // --- templates ---
  async listTemplates() {
    const { rows } = await db.query("SELECT * FROM templates ORDER BY built_in DESC, name");
    return rows.map(templateFromRow);
  },
  async getTemplate(id) {
    const { rows } = await db.query("SELECT * FROM templates WHERE id=$1", [id]);
    return rows[0] ? templateFromRow(rows[0]) : null;
  },
  async addTemplate(input) {
    const template = {
      id: newId("tmpl"), name: input.name, protocol: input.protocol, port: Number(input.port) || null,
      registerMap: input.registerMap || {}, unit: input.unit || "kg", pollingMs: Number(input.pollingMs) || 500, builtIn: false,
    };
    await db.query(
      "INSERT INTO templates (id, name, protocol, port, register_map, unit, polling_ms, built_in) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [template.id, template.name, template.protocol, template.port, JSON.stringify(template.registerMap), template.unit, template.pollingMs, template.builtIn]
    );
    return template;
  },
  async removeTemplate(id) {
    const t = await store.getTemplate(id);
    if (t && t.builtIn) return false;
    await db.query("DELETE FROM templates WHERE id=$1", [id]);
    return true;
  },

  // --- engineering mode comm log (ephemeral) ---
  logComm(deviceId, entry) {
    if (!commLogs.has(deviceId)) commLogs.set(deviceId, []);
    const arr = commLogs.get(deviceId);
    arr.push({ ts: Date.now(), ...entry });
    if (arr.length > MAX_COMM_LOG_PER_DEVICE) arr.shift();
  },
  getCommLog(deviceId, limit = 50) {
    const arr = commLogs.get(deviceId) || [];
    return arr.slice(-limit).reverse();
  },

  // ---------- Multi-site sync ----------

  // --- local-side: reading the outbox to push out ---
  async listUnsyncedOutbox(limit = 500) {
    const { rows } = await db.query(
      "SELECT * FROM sync_outbox WHERE synced_at IS NULL ORDER BY id ASC LIMIT $1",
      [limit]
    );
    return rows.map((r) => ({
      id: r.id, entityType: r.entity_type, entityId: r.entity_id,
      operation: r.operation, payload: r.payload, createdAt: r.created_at,
    }));
  },
  async markOutboxSynced(ids) {
    if (!ids || ids.length === 0) return;
    await db.query("UPDATE sync_outbox SET synced_at = now() WHERE id = ANY($1::bigint[])", [ids]);
  },
  async countUnsyncedOutbox() {
    const { rows } = await db.query("SELECT count(*) FROM sync_outbox WHERE synced_at IS NULL");
    return Number(rows[0].count);
  },

  // --- cloud-side: sync keys, one per site ---
  async listSyncKeys() {
    const { rows } = await db.query("SELECT * FROM sync_keys ORDER BY created_at");
    return rows.map((r) => ({ id: r.id, key: r.key, siteId: r.site_id, siteLabel: r.site_label, createdAt: r.created_at }));
  },
  async findSyncKey(key) {
    const { rows } = await db.query("SELECT * FROM sync_keys WHERE key=$1", [key]);
    return rows[0] ? { id: rows[0].id, key: rows[0].key, siteId: rows[0].site_id, siteLabel: rows[0].site_label, createdAt: rows[0].created_at } : null;
  },
  async addSyncKey(entry) {
    await db.query(
      "INSERT INTO sync_keys (id, key, site_id, site_label, created_at) VALUES ($1,$2,$3,$4,$5)",
      [entry.id, entry.key, entry.siteId, entry.siteLabel, entry.createdAt]
    );
    return entry;
  },
  async removeSyncKey(id) {
    await db.query("DELETE FROM sync_keys WHERE id=$1", [id]);
  },

  // --- data retention ---
  async purgeOldReadings(retentionDays) {
    const { rows } = await db.query(
      "DELETE FROM readings WHERE ts < now() - ($1 || ' days')::interval RETURNING id",
      [retentionDays]
    );
    return rows.length;
  },

  // --- cloud-side: applying a synced record from a site ---
  // Every ID (and every device_id/product_id reference) is prefixed with the
  // site's ID before touching the database, so multiple sites can sync into
  // the same cloud instance without ever colliding — a device's local ID
  // `d_123` becomes `durban-plant:d_123` here, and every table that
  // references it (device_stats, alerts, maintenance, calibration) gets the
  // same prefixed value, so relationships stay consistent within the cloud
  // DB even though the schema has no real foreign keys enforcing it.
  async upsertSyncedEntity(entityType, operation, entityId, record, siteId, siteLabel) {
    const pid = (id) => (id ? `${siteId}:${id}` : id);

    if (entityType === "device") {
      const id = pid(entityId);
      if (operation === "delete") {
        await db.query("DELETE FROM devices WHERE id=$1", [id]);
        return;
      }
      const displayName = `[${siteLabel || siteId}] ${record.name}`;
      await db.query(
        `INSERT INTO devices (id, name, ip, protocol, target, unit, cost_per_unit, product_id, connection_config, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET name=$2, ip=$3, protocol=$4, target=$5, unit=$6, cost_per_unit=$7, product_id=$8, connection_config=$9`,
        [id, displayName, record.ip, record.protocol, record.target, record.unit, record.costPerUnit,
         pid(record.productId), record.connectionConfig ? JSON.stringify(record.connectionConfig) : null, record.createdAt]
      );
      return;
    }

    if (entityType === "product") {
      const id = pid(entityId);
      if (operation === "delete") {
        await db.query("DELETE FROM products WHERE id=$1", [id]);
        return;
      }
      await db.query(
        `INSERT INTO products (id, code, name, description, target_weight, min_weight, max_weight, unit, tolerance_type, tolerance_value, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO UPDATE SET code=$2, name=$3, description=$4, target_weight=$5, min_weight=$6, max_weight=$7,
           unit=$8, tolerance_type=$9, tolerance_value=$10, status=$11`,
        [id, record.code, record.name, record.description, record.targetWeight, record.minWeight, record.maxWeight,
         record.unit, record.toleranceType, record.toleranceValue, record.status, record.createdAt]
      );
      return;
    }

    if (entityType === "device_stats") {
      const deviceId = pid(entityId);
      await ensureStatsRow(deviceId);
      await db.query(
        `UPDATE device_stats SET total_bags=$2, total_over_kg=$3, total_under_kg=$4, total_cost=$5,
           count_under=$6, count_pass=$7, count_over=$8, since=$9 WHERE device_id=$1`,
        [deviceId, record.totalBags, record.totalOverKg, record.totalUnderKg, record.totalCost,
         record.countUnder, record.countPass, record.countOver, record.since]
      );
      return;
    }

    if (entityType === "alert") {
      const id = pid(entityId);
      await db.query(
        `INSERT INTO alert_history (id, device_id, device_name, type, message, severity, since, active, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET active=$8, resolved_at=$9, message=$5`,
        [id, pid(record.deviceId), record.deviceName, record.type, record.message, record.severity, record.since, record.active, record.resolvedAt]
      );
      return;
    }

    if (entityType === "maintenance") {
      const id = pid(entityId);
      if (operation === "delete") {
        await db.query("DELETE FROM maintenance_records WHERE id=$1", [id]);
        return;
      }
      await db.query(
        `INSERT INTO maintenance_records (id, device_id, work_order_number, status, scheduled_date, due_date, interval_days,
           technician, notes, parts, labour_hours, labour_cost, downtime_minutes, attachments, created_at, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (id) DO UPDATE SET status=$4, scheduled_date=$5, due_date=$6, interval_days=$7, technician=$8,
           notes=$9, parts=$10, labour_hours=$11, labour_cost=$12, downtime_minutes=$13, attachments=$14, completed_at=$16`,
        [id, pid(record.deviceId), record.workOrderNumber, record.status, record.scheduledDate, record.dueDate, record.intervalDays,
         record.technician, record.notes, JSON.stringify(record.parts || []), record.labourHours, record.labourCost,
         record.downtimeMinutes, JSON.stringify(record.attachments || []), record.createdAt, record.completedAt]
      );
      return;
    }

    if (entityType === "calibration") {
      const id = pid(entityId);
      if (operation === "delete") {
        await db.query("DELETE FROM calibration_records WHERE id=$1", [id]);
        return;
      }
      await db.query(
        `INSERT INTO calibration_records (id, device_id, calibration_date, next_calibration_date, certificate_number,
           certificate_file_url, technician, calibration_company, reference_weight, actual_weight, error, error_percent,
           pass_fail, notes, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (id) DO UPDATE SET calibration_date=$3, next_calibration_date=$4, certificate_number=$5,
           certificate_file_url=$6, technician=$7, calibration_company=$8, reference_weight=$9, actual_weight=$10,
           error=$11, error_percent=$12, pass_fail=$13, notes=$14`,
        [id, pid(record.deviceId), record.calibrationDate, record.nextCalibrationDate, record.certificateNumber,
         record.certificateFileUrl, record.technician, record.calibrationCompany, record.referenceWeight, record.actualWeight,
         record.error, record.errorPercent, record.passFail, record.notes, record.createdAt]
      );
      return;
    }

    if (entityType === "audit_log") {
      const id = pid(entityId);
      await db.query(
        `INSERT INTO audit_log (id, ts, username, role, action, details) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
        [id, record.ts, record.username, record.role, record.action, JSON.stringify(record.details || {})]
      );
      return;
    }

    throw new Error(`unknown sync entity type: ${entityType}`);
  },

  // --- downtime logs ---
  async logDowntimeStart(deviceId, deviceName) {
    const id = `dt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO downtime_logs (id, device_id, device_name, started_at, created_at) VALUES ($1,$2,$3,$4,$4)`,
      [id, deviceId, deviceName, now]
    );
    return { id, deviceId, deviceName, startedAt: now, endedAt: null, reasonCode: null, reasonNote: null, reportedBy: null, createdAt: now };
  },
  async logDowntimeEnd(deviceId) {
    const { rows } = await db.query(
      `SELECT * FROM downtime_logs WHERE device_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      [deviceId]
    );
    if (!rows[0]) return null;
    const endedAt = new Date().toISOString();
    await db.query("UPDATE downtime_logs SET ended_at = $2 WHERE id = $1", [rows[0].id, endedAt]);
    return downtimeFromRow({ ...rows[0], ended_at: endedAt });
  },
  async updateDowntimeReason(id, reasonCode, reasonNote, reportedBy) {
    const { rows } = await db.query("SELECT * FROM downtime_logs WHERE id = $1", [id]);
    if (!rows[0]) return null;
    await db.query(
      "UPDATE downtime_logs SET reason_code = $2, reason_note = $3, reported_by = $4 WHERE id = $1",
      [id, reasonCode || null, reasonNote || null, reportedBy || null]
    );
    const { rows: updated } = await db.query("SELECT * FROM downtime_logs WHERE id = $1", [id]);
    return downtimeFromRow(updated[0]);
  },
  async listDowntimeLogs(filters = {}) {
    let query = "SELECT * FROM downtime_logs";
    const params = [];
    const conditions = [];
    if (filters.deviceId) { params.push(filters.deviceId); conditions.push(`device_id = $${params.length}`); }
    if (filters.from) { params.push(filters.from); conditions.push(`started_at >= $${params.length}`); }
    if (filters.to) { params.push(filters.to); conditions.push(`started_at <= $${params.length}`); }
    if (conditions.length) query += " WHERE " + conditions.join(" AND ");
    query += " ORDER BY started_at DESC";
    if (filters.limit) { params.push(filters.limit); query += ` LIMIT $${params.length}`; }
    const { rows } = await db.query(query, params);
    return rows.map(downtimeFromRow);
  },
  async getDowntimeStats(deviceId) {
    let query = `SELECT reason_code, COUNT(*) as count,
      COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at))), 0) as total_seconds
      FROM downtime_logs`;
    const params = [];
    if (deviceId) { params.push(deviceId); query += ` WHERE device_id = $1`; }
    query += " GROUP BY reason_code ORDER BY total_seconds DESC";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ reasonCode: r.reason_code || "unassigned", count: Number(r.count), totalSeconds: Number(r.total_seconds) }));
  },

  // ============================================================
  // PHASE 1: Platform Foundation — Hierarchy, Asset Types, Telemetry, Sensors
  // ============================================================

  // --- Sites ---
  async listSites(orgId) {
    let query = "SELECT * FROM sites";
    const params = [];
    if (orgId) { query += " WHERE org_id = $1"; params.push(orgId); }
    query += " ORDER BY created_at";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, orgId: r.org_id, name: r.name, code: r.code, address: r.address, timezone: r.timezone, lat: r.lat, lng: r.lng, enabled: r.enabled, settings: r.settings, createdAt: r.created_at }));
  },
  async getSite(id) {
    const { rows } = await db.query("SELECT * FROM sites WHERE id = $1", [id]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { id: r.id, orgId: r.org_id, name: r.name, code: r.code, address: r.address, timezone: r.timezone, lat: r.lat, lng: r.lng, enabled: r.enabled, settings: r.settings, createdAt: r.created_at };
  },
  async createSite(site) {
    const id = `site_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      "INSERT INTO sites (id, org_id, name, code, address, timezone, lat, lng, settings, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())",
      [id, site.orgId || null, site.name, site.code || null, site.address || null, site.timezone || "UTC", site.lat || null, site.lng || null, site.settings ? JSON.stringify(site.settings) : null]
    );
    return { id, ...site, createdAt: new Date().toISOString() };
  },
  async updateSite(id, updates) {
    const sets = [];
    const params = [id];
    let idx = 2;
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined && k !== "id") {
        const col = k === "orgId" ? "org_id" : k === "lat" ? "lat" : k === "lng" ? "lng" : k;
        sets.push(`${col} = $${idx}`); params.push(v); idx++;
      }
    }
    if (sets.length) await db.query(`UPDATE sites SET ${sets.join(", ")} WHERE id = $1`, params);
    return await store.getSite(id);
  },
  async deleteSite(id) {
    await db.query("DELETE FROM sites WHERE id = $1", [id]);
  },

  // --- Areas ---
  async listAreas(siteId) {
    let query = "SELECT * FROM areas";
    const params = [];
    if (siteId) { query += " WHERE site_id = $1"; params.push(siteId); }
    query += " ORDER BY sort_order, name";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, siteId: r.site_id, name: r.name, code: r.code, description: r.description, color: r.color, sortOrder: r.sort_order, createdAt: r.created_at }));
  },
  async getArea(id) {
    const { rows } = await db.query("SELECT * FROM areas WHERE id = $1", [id]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { id: r.id, siteId: r.site_id, name: r.name, code: r.code, description: r.description, color: r.color, sortOrder: r.sort_order, createdAt: r.created_at };
  },
  async createArea(area) {
    const id = `area_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const maxOrder = await db.query("SELECT COALESCE(MAX(sort_order),0)+1 as next FROM areas WHERE site_id=$1", [area.siteId]);
    await db.query(
      "INSERT INTO areas (id, site_id, name, code, description, color, sort_order, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())",
      [id, area.siteId, area.name, area.code || null, area.description || "", area.color || "#3B82F6", maxOrder.rows[0].next]
    );
    return { id, ...area, createdAt: new Date().toISOString() };
  },
  async updateArea(id, updates) {
    const sets = [];
    const params = [id];
    let idx = 2;
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined && k !== "id") {
        const col = k === "siteId" ? "site_id" : k === "sortOrder" ? "sort_order" : k;
        sets.push(`${col} = $${idx}`); params.push(v); idx++;
      }
    }
    if (sets.length) await db.query(`UPDATE areas SET ${sets.join(", ")} WHERE id = $1`, params);
    return await store.getArea(id);
  },
  async deleteArea(id) {
    await db.query("DELETE FROM areas WHERE id = $1", [id]);
  },

  // --- Lines ---
  async listLines(areaId) {
    let query = "SELECT * FROM lines";
    const params = [];
    if (areaId) { query += " WHERE area_id = $1"; params.push(areaId); }
    query += " ORDER BY sort_order, name";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, areaId: r.area_id, name: r.name, code: r.code, description: r.description, color: r.color, sortOrder: r.sort_order, createdAt: r.created_at }));
  },
  async getLine(id) {
    const { rows } = await db.query("SELECT * FROM lines WHERE id = $1", [id]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { id: r.id, areaId: r.area_id, name: r.name, code: r.code, description: r.description, color: r.color, sortOrder: r.sort_order, createdAt: r.created_at };
  },
  async createLine(line) {
    const id = `line_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const maxOrder = await db.query("SELECT COALESCE(MAX(sort_order),0)+1 as next FROM lines WHERE area_id=$1", [line.areaId]);
    await db.query(
      "INSERT INTO lines (id, area_id, name, code, description, color, sort_order, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())",
      [id, line.areaId, line.name, line.code || null, line.description || "", line.color || "#10B981", maxOrder.rows[0].next]
    );
    return { id, ...line, createdAt: new Date().toISOString() };
  },
  async updateLine(id, updates) {
    const sets = [];
    const params = [id];
    let idx = 2;
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined && k !== "id") {
        const col = k === "areaId" ? "area_id" : k === "sortOrder" ? "sort_order" : k;
        sets.push(`${col} = $${idx}`); params.push(v); idx++;
      }
    }
    if (sets.length) await db.query(`UPDATE lines SET ${sets.join(", ")} WHERE id = $1`, params);
    return await store.getLine(id);
  },
  async deleteLine(id) {
    await db.query("DELETE FROM lines WHERE id = $1", [id]);
  },

  // --- Stations ---
  async listStations(lineId) {
    let query = "SELECT * FROM stations";
    const params = [];
    if (lineId) { query += " WHERE line_id = $1"; params.push(lineId); }
    query += " ORDER BY sort_order, name";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, lineId: r.line_id, name: r.name, code: r.code, description: r.description, sortOrder: r.sort_order, createdAt: r.created_at }));
  },
  async getStation(id) {
    const { rows } = await db.query("SELECT * FROM stations WHERE id = $1", [id]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { id: r.id, lineId: r.line_id, name: r.name, code: r.code, description: r.description, sortOrder: r.sort_order, createdAt: r.created_at };
  },
  async createStation(station) {
    const id = `stn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const maxOrder = await db.query("SELECT COALESCE(MAX(sort_order),0)+1 as next FROM stations WHERE line_id=$1", [station.lineId]);
    await db.query(
      "INSERT INTO stations (id, line_id, name, code, description, sort_order, created_at) VALUES ($1,$2,$3,$4,$5,$6,now())",
      [id, station.lineId, station.name, station.code || null, station.description || "", maxOrder.rows[0].next]
    );
    return { id, ...station, createdAt: new Date().toISOString() };
  },
  async updateStation(id, updates) {
    const sets = [];
    const params = [id];
    let idx = 2;
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined && k !== "id") {
        const col = k === "lineId" ? "line_id" : k === "sortOrder" ? "sort_order" : k;
        sets.push(`${col} = $${idx}`); params.push(v); idx++;
      }
    }
    if (sets.length) await db.query(`UPDATE stations SET ${sets.join(", ")} WHERE id = $1`, params);
    return await store.getStation(id);
  },
  async deleteStation(id) {
    await db.query("DELETE FROM stations WHERE id = $1", [id]);
  },

  // --- Asset Types ---
  async listAssetTypes(orgId) {
    let query = "SELECT * FROM asset_types";
    const params = [];
    if (orgId) { query += " WHERE org_id = $1"; params.push(orgId); }
    query += " ORDER BY category, name";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, orgId: r.org_id, name: r.name, code: r.code, description: r.description, icon: r.icon, color: r.color, category: r.category, isSystem: r.is_system, settings: r.settings, createdAt: r.created_at }));
  },
  async getAssetType(id) {
    const { rows } = await db.query("SELECT * FROM asset_types WHERE id = $1", [id]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { id: r.id, orgId: r.org_id, name: r.name, code: r.code, description: r.description, icon: r.icon, color: r.color, category: r.category, isSystem: r.is_system, settings: r.settings, createdAt: r.created_at };
  },
  async createAssetType(assetType) {
    const id = `at_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      "INSERT INTO asset_types (id, org_id, name, code, description, icon, color, category, settings, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())",
      [id, assetType.orgId || null, assetType.name, assetType.code || null, assetType.description || "", assetType.icon || "device", assetType.color || "#6366F1", assetType.category || "general", assetType.settings ? JSON.stringify(assetType.settings) : null]
    );
    return { id, ...assetType, createdAt: new Date().toISOString() };
  },
  async updateAssetType(id, updates) {
    const sets = [];
    const params = [id];
    let idx = 2;
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined && k !== "id") {
        const col = k === "orgId" ? "org_id" : k === "isSystem" ? "is_system" : k;
        sets.push(`${col} = $${idx}`); params.push(v); idx++;
      }
    }
    if (sets.length) await db.query(`UPDATE asset_types SET ${sets.join(", ")} WHERE id = $1`, params);
    return await store.getAssetType(id);
  },
  async deleteAssetType(id) {
    await db.query("DELETE FROM asset_type_metrics WHERE asset_type_id = $1", [id]);
    await db.query("DELETE FROM asset_types WHERE id = $1", [id]);
  },

  // --- Asset Type Metrics ---
  async listAssetTypeMetrics(assetTypeId) {
    const { rows } = await db.query("SELECT * FROM asset_type_metrics WHERE asset_type_id = $1 ORDER BY sort_order", [assetTypeId]);
    return rows.map(r => ({ id: r.id, assetTypeId: r.asset_type_id, name: r.name, displayName: r.display_name, unit: r.unit, dataType: r.data_type, minValue: r.min_value, maxValue: r.max_value, precision: r.precision, category: r.category, sortOrder: r.sort_order, settings: r.settings }));
  },
  async createAssetTypeMetric(metric) {
    const id = `atm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      "INSERT INTO asset_type_metrics (id, asset_type_id, name, display_name, unit, data_type, min_value, max_value, precision, category, sort_order, settings, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())",
      [id, metric.assetTypeId, metric.name, metric.displayName, metric.unit || "", metric.dataType || "number", metric.minValue || null, metric.maxValue || null, metric.precision !== undefined ? metric.precision : 2, metric.category || "primary", metric.sortOrder || 0, metric.settings ? JSON.stringify(metric.settings) : null]
    );
    return { id, ...metric };
  },
  async deleteAssetTypeMetric(id) {
    await db.query("DELETE FROM asset_type_metrics WHERE id = $1", [id]);
  },

  // --- Sensors ---
  async listSensors(deviceId) {
    let query = "SELECT * FROM sensors";
    const params = [];
    if (deviceId) { query += " WHERE device_id = $1"; params.push(deviceId); }
    query += " ORDER BY created_at";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, deviceId: r.device_id, name: r.name, type: r.type, unit: r.unit, enabled: r.enabled, config: r.config, minValue: r.min_value, maxValue: r.max_value, warningMin: r.warning_min, warningMax: r.warning_max, alarmMin: r.alarm_min, alarmMax: r.alarm_max, createdAt: r.created_at }));
  },
  async getSensor(id) {
    const { rows } = await db.query("SELECT * FROM sensors WHERE id = $1", [id]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { id: r.id, deviceId: r.device_id, name: r.name, type: r.type, unit: r.unit, enabled: r.enabled, config: r.config, minValue: r.min_value, maxValue: r.max_value, warningMin: r.warning_min, warningMax: r.warning_max, alarmMin: r.alarm_min, alarmMax: r.alarm_max, createdAt: r.created_at };
  },
  async createSensor(sensor) {
    const id = `sens_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      "INSERT INTO sensors (id, device_id, name, type, unit, enabled, config, min_value, max_value, warning_min, warning_max, alarm_min, alarm_max, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())",
      [id, sensor.deviceId, sensor.name, sensor.type, sensor.unit || "", sensor.enabled !== false, sensor.config ? JSON.stringify(sensor.config) : "{}", sensor.minValue || null, sensor.maxValue || null, sensor.warningMin || null, sensor.warningMax || null, sensor.alarmMin || null, sensor.alarmMax || null]
    );
    return { id, ...sensor, createdAt: new Date().toISOString() };
  },
  async updateSensor(id, updates) {
    const sets = [];
    const params = [id];
    let idx = 2;
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined && k !== "id") {
        const col = k === "deviceId" ? "device_id" : k === "minValue" ? "min_value" : k === "maxValue" ? "max_value" : k === "warningMin" ? "warning_min" : k === "warningMax" ? "warning_max" : k === "alarmMin" ? "alarm_min" : k === "alarmMax" ? "alarm_max" : k;
        sets.push(`${col} = $${idx}`); params.push(v); idx++;
      }
    }
    if (sets.length) await db.query(`UPDATE sensors SET ${sets.join(", ")} WHERE id = $1`, params);
    return await store.getSensor(id);
  },
  async deleteSensor(id) {
    await db.query("DELETE FROM sensors WHERE id = $1", [id]);
  },

  // --- Generic Telemetry ---
  async pushTelemetry(deviceId, metrics, connected, quality) {
    await db.query(
      "INSERT INTO telemetry (device_id, metrics, connected, quality, ts) VALUES ($1,$2,$3,$4,now())",
      [deviceId, JSON.stringify(metrics), connected !== false, quality || null]
    );
  },
  async getTelemetry(deviceId, metricName, limit = 100) {
    if (metricName) {
      const { rows } = await db.query(
        "SELECT metrics->>$2 as value, ts FROM telemetry WHERE device_id = $1 ORDER BY ts DESC LIMIT $3",
        [deviceId, metricName, limit]
      );
      return rows.map(r => ({ value: r.value !== null ? Number(r.value) : null, ts: r.ts }));
    }
    const { rows } = await db.query(
      "SELECT metrics, ts FROM telemetry WHERE device_id = $1 ORDER BY ts DESC LIMIT $2",
      [deviceId, limit]
    );
    return rows.map(r => ({ metrics: r.metrics, ts: r.ts }));
  },
  async getTelemetryInRange(deviceId, fromIso, toIso, metricName) {
    if (metricName) {
      const { rows } = await db.query(
        "SELECT metrics->>$3 as value, ts FROM telemetry WHERE device_id = $1 AND ts BETWEEN $2 AND $4 ORDER BY ts",
        [deviceId, fromIso, metricName, toIso]
      );
      return rows.map(r => ({ value: r.value !== null ? Number(r.value) : null, ts: r.ts }));
    }
    const { rows } = await db.query(
      "SELECT metrics, ts FROM telemetry WHERE device_id = $1 AND ts BETWEEN $2 AND $3 ORDER BY ts",
      [deviceId, fromIso, toIso]
    );
    return rows.map(r => ({ metrics: r.metrics, ts: r.ts }));
  },
  async getLatestTelemetry(deviceId) {
    const { rows } = await db.query(
      "SELECT metrics, connected, quality, ts FROM telemetry WHERE device_id = $1 ORDER BY ts DESC LIMIT 1",
      [deviceId]
    );
    return rows[0] || null;
  },
  async purgeOldTelemetry(days) {
    const result = await db.query("DELETE FROM telemetry WHERE ts < now() - interval '$1 days'", [days]);
    return result.rowCount || 0;
  },

  // --- Hierarchy tree (full tree in one query) ---
  async getHierarchyTree(orgId) {
    let siteQuery = "SELECT * FROM sites";
    const siteParams = [];
    if (orgId) { siteQuery += " WHERE org_id = $1"; siteParams.push(orgId); }
    siteQuery += " ORDER BY name";
    const { rows: sites } = await db.query(siteQuery, siteParams);

    const tree = [];
    for (const site of sites) {
      const { rows: areas } = await db.query("SELECT * FROM areas WHERE site_id = $1 ORDER BY sort_order, name", [site.id]);
      const areaList = [];
      for (const area of areas) {
        const { rows: lines } = await db.query("SELECT * FROM lines WHERE area_id = $1 ORDER BY sort_order, name", [area.id]);
        const lineList = [];
        for (const line of lines) {
          const { rows: stations } = await db.query("SELECT * FROM stations WHERE line_id = $1 ORDER BY sort_order, name", [line.id]);
          const { rows: devices } = await db.query("SELECT id, name, status FROM devices WHERE line_id = $1", [line.id]);
          lineList.push({ ...line, stations, devices });
        }
        const { rows: areaDevices } = await db.query("SELECT id, name, status FROM devices WHERE area_id = $1 AND line_id IS NULL", [area.id]);
        areaList.push({ ...area, lines: lineList, devices: areaDevices });
      }
      const { rows: siteDevices } = await db.query("SELECT id, name, status FROM devices WHERE site_id = $1 AND area_id IS NULL", [site.id]);
      tree.push({ ...site, areas: areaList, devices: siteDevices });
    }
    return tree;
  },

  // ============================================================
  // PHASE 2: Real-Time Operations — Asset Status + Rules Engine
  // ============================================================

  // --- Asset Status ---
  async getAssetStatus(deviceId) {
    const { rows } = await db.query("SELECT * FROM asset_status WHERE device_id = $1", [deviceId]);
    if (!rows[0]) return { deviceId, status: "offline", statusText: "", lastSeenAt: null, lastMetricValues: {}, updatedAt: null };
    const r = rows[0];
    return { deviceId: r.device_id, status: r.status, statusText: r.status_text, lastSeenAt: r.last_seen_at, lastMetricValues: r.last_metric_values, updatedAt: r.updated_at };
  },
  async getAllAssetStatuses() {
    const { rows } = await db.query("SELECT * FROM asset_status ORDER BY status, device_id");
    return rows.map(r => ({ deviceId: r.device_id, status: r.status, statusText: r.status_text, lastSeenAt: r.last_seen_at, lastMetricValues: r.last_metric_values, updatedAt: r.updated_at }));
  },
  async updateAssetStatus(deviceId, status, statusText, metricValues) {
    await db.query(
      `INSERT INTO asset_status (device_id, status, status_text, last_seen_at, last_metric_values, updated_at)
       VALUES ($1,$2,$3,now(),$4,now())
       ON CONFLICT (device_id) DO UPDATE SET status=$2, status_text=$3, last_seen_at=now(), last_metric_values=$4, updated_at=now()`,
      [deviceId, status, statusText || "", metricValues ? JSON.stringify(metricValues) : "{}"]
    );
  },

  // --- Alert Rules ---
  async listAlertRules(orgId) {
    let query = "SELECT * FROM alert_rules";
    const params = [];
    if (orgId) { query += " WHERE org_id = $1"; params.push(orgId); }
    query += " ORDER BY created_at";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, orgId: r.org_id, name: r.name, description: r.description, enabled: r.enabled, deviceId: r.device_id, deviceIds: r.device_ids, metric: r.metric, operator: r.operator, threshold: Number(r.threshold), severity: r.severity, messageTemplate: r.message_template, cooldownSeconds: r.cooldown_seconds, consecutiveCount: r.consecutive_count, tags: r.tags, createdAt: r.created_at, lastTriggeredAt: r.last_triggered_at }));
  },
  async getAlertRule(id) {
    const { rows } = await db.query("SELECT * FROM alert_rules WHERE id = $1", [id]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { id: r.id, orgId: r.org_id, name: r.name, description: r.description, enabled: r.enabled, deviceId: r.device_id, deviceIds: r.device_ids, metric: r.metric, operator: r.operator, threshold: Number(r.threshold), severity: r.severity, messageTemplate: r.message_template, cooldownSeconds: r.cooldown_seconds, consecutiveCount: r.consecutive_count, tags: r.tags, createdAt: r.created_at, lastTriggeredAt: r.last_triggered_at };
  },
  async createAlertRule(rule) {
    const id = `ar_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      `INSERT INTO alert_rules (id, org_id, name, description, enabled, device_id, device_ids, metric, operator, threshold, severity, message_template, cooldown_seconds, consecutive_count, tags, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())`,
      [id, rule.orgId || null, rule.name, rule.description || "", rule.enabled !== false, rule.deviceId || null, JSON.stringify(rule.deviceIds || []), rule.metric, rule.operator || ">", Number(rule.threshold), rule.severity || "warning", rule.messageTemplate || null, rule.cooldownSeconds || 300, rule.consecutiveCount || 1, JSON.stringify(rule.tags || [])]
    );
    return { id, ...rule, createdAt: new Date().toISOString() };
  },
  async updateAlertRule(id, updates) {
    const sets = [];
    const params = [id];
    let idx = 2;
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined && k !== "id") {
        const col = k === "orgId" ? "org_id" : k === "deviceId" ? "device_id" : k === "deviceIds" ? "device_ids" : k === "messageTemplate" ? "message_template" : k === "cooldownSeconds" ? "cooldown_seconds" : k === "consecutiveCount" ? "consecutive_count" : k === "lastTriggeredAt" ? "last_triggered_at" : k;
        sets.push(`${col} = $${idx}`); params.push(v); idx++;
      }
    }
    if (sets.length) await db.query(`UPDATE alert_rules SET ${sets.join(", ")} WHERE id = $1`, params);
    return await store.getAlertRule(id);
  },
  async deleteAlertRule(id) {
    await db.query("DELETE FROM rule_state WHERE rule_id = $1", [id]);
    await db.query("DELETE FROM alert_rules WHERE id = $1", [id]);
  },
  async markRuleTriggered(id) {
    await db.query("UPDATE alert_rules SET last_triggered_at = now() WHERE id = $1", [id]);
  },

  // --- Rule State ---
  async getRuleState(ruleId, deviceId) {
    const { rows } = await db.query("SELECT * FROM rule_state WHERE rule_id = $1 AND device_id = $2", [ruleId, deviceId]);
    return rows[0] || { consecutive_violations: 0, last_violation_at: null, last_alert_at: null };
  },
  async incrementRuleViolation(ruleId, deviceId) {
    await db.query(
      `INSERT INTO rule_state (rule_id, device_id, consecutive_violations, last_violation_at, last_alert_at)
       VALUES ($1,$2,1,now(),NULL)
       ON CONFLICT (rule_id, device_id) DO UPDATE SET consecutive_violations = rule_state.consecutive_violations + 1, last_violation_at = now()`,
      [ruleId, deviceId]
    );
    const { rows } = await db.query("SELECT consecutive_violations FROM rule_state WHERE rule_id=$1 AND device_id=$2", [ruleId, deviceId]);
    return rows[0] ? Number(rows[0].consecutive_violations) : 0;
  },
  async resetRuleViolation(ruleId, deviceId) {
    await db.query(
      `INSERT INTO rule_state (rule_id, device_id, consecutive_violations, last_violation_at, last_alert_at)
       VALUES ($1,$2,0,NULL,NULL)
       ON CONFLICT (rule_id, device_id) DO UPDATE SET consecutive_violations = 0`,
      [ruleId, deviceId]
    );
  },
  async markRuleStateAlerted(ruleId, deviceId) {
    await db.query("UPDATE rule_state SET last_alert_at = now() WHERE rule_id=$1 AND device_id=$2", [ruleId, deviceId]);
  },

  // --- Rules Evaluation Engine ---
  async evaluateRulesForDevice(deviceId, metricName, metricValue) {
    const triggered = [];
    const { rows: rules } = await db.query(
      "SELECT * FROM alert_rules WHERE enabled = true AND (device_id = $1 OR device_id IS NULL)",
      [deviceId]
    );

    for (const rule of rules) {
      // Check if this rule targets this metric
      if (rule.metric !== metricName) continue;

      // Check if this device is in the rule's scope
      if (rule.device_id && rule.device_id !== deviceId) continue;
      if (rule.device_ids && rule.device_ids.length > 0 && !rule.device_ids.includes(deviceId)) continue;

      // Evaluate the condition
      let violated = false;
      switch (rule.operator) {
        case ">": violated = metricValue > Number(rule.threshold); break;
        case ">=": violated = metricValue >= Number(rule.threshold); break;
        case "<": violated = metricValue < Number(rule.threshold); break;
        case "<=": violated = metricValue <= Number(rule.threshold); break;
        case "==": violated = metricValue === Number(rule.threshold); break;
        case "!=": violated = metricValue !== Number(rule.threshold); break;
        default: continue;
      }

      if (violated) {
        const count = await store.incrementRuleViolation(rule.id, deviceId);
        if (count >= (rule.consecutive_count || 1)) {
          // Check cooldown
          const state = await store.getRuleState(rule.id, deviceId);
          if (state.last_alert_at) {
            const elapsed = (Date.now() - new Date(state.last_alert_at).getTime()) / 1000;
            if (elapsed < (rule.cooldown_seconds || 300)) continue;
          }

          // Trigger alert
          const device = await store.getDevice(deviceId);
          const deviceName = device ? device.name : deviceId;
          const message = rule.message_template
            ? rule.message_template.replace(/\{value\}/g, metricValue).replace(/\{threshold\}/g, rule.threshold).replace(/\{device\}/g, deviceName).replace(/\{metric\}/g, metricName)
            : `${deviceName}: ${metricName} is ${metricValue} (threshold: ${rule.operator} ${rule.threshold})`;

          const alert = await store.triggerAlert(deviceId, deviceName, `rule_${rule.id}`, message, rule.severity);
          if (alert) {
            await store.markRuleTriggered(rule.id);
            await store.markRuleStateAlerted(rule.id, deviceId);
            triggered.push({ rule: rule.name, alert, metric: metricName, value: metricValue });
          }
        }
      } else {
        await store.resetRuleViolation(rule.id, deviceId);
        await store.resolveAlert(deviceId, `rule_${rule.id}`);
      }
    }
    return triggered;
  },

  // ============================================================
  // PHASE 3: Manufacturing — Production Orders, Events, Quality, Shifts
  // ============================================================

  // --- Production Orders ---
  async listProductionOrders(filters = {}) {
    let query = "SELECT * FROM production_orders";
    const params = [];
    const conditions = [];
    if (filters.status) { params.push(filters.status); conditions.push(`status = $${params.length}`); }
    if (filters.productId) { params.push(filters.productId); conditions.push(`product_id = $${params.length}`); }
    if (filters.deviceId) { params.push(filters.deviceId); conditions.push(`device_id = $${params.length}`); }
    if (filters.lineId) { params.push(filters.lineId); conditions.push(`line_id = $${params.length}`); }
    if (filters.from) { params.push(filters.from); conditions.push(`planned_start >= $${params.length}`); }
    if (filters.to) { params.push(filters.to); conditions.push(`planned_end <= $${params.length}`); }
    if (conditions.length) query += " WHERE " + conditions.join(" AND ");
    query += " ORDER BY created_at DESC LIMIT 200";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, orgId: r.org_id, orderNumber: r.order_number, productId: r.product_id, deviceId: r.device_id, lineId: r.line_id, status: r.status, priority: r.priority, plannedQuantity: r.planned_quantity, actualQuantity: r.actual_quantity, goodQuantity: r.good_quantity, rejectQuantity: r.reject_quantity, unit: r.unit, plannedStart: r.planned_start, plannedEnd: r.planned_end, actualStart: r.actual_start, actualEnd: r.actual_end, customer: r.customer, notes: r.notes, metadata: r.metadata, createdAt: r.created_at, updatedAt: r.updated_at }));
  },
  async getProductionOrder(id) {
    const { rows } = await db.query("SELECT * FROM production_orders WHERE id = $1", [id]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { id: r.id, orgId: r.org_id, orderNumber: r.order_number, productId: r.product_id, deviceId: r.device_id, lineId: r.line_id, status: r.status, priority: r.priority, plannedQuantity: r.planned_quantity, actualQuantity: r.actual_quantity, goodQuantity: r.good_quantity, rejectQuantity: r.reject_quantity, unit: r.unit, plannedStart: r.planned_start, plannedEnd: r.planned_end, actualStart: r.actual_start, actualEnd: r.actual_end, customer: r.customer, notes: r.notes, metadata: r.metadata, createdAt: r.created_at, updatedAt: r.updated_at };
  },
  async createProductionOrder(order) {
    const id = `po_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      `INSERT INTO production_orders (id, org_id, order_number, product_id, device_id, line_id, status, priority, planned_quantity, unit, planned_start, planned_end, customer, notes, metadata, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),now())`,
      [id, order.orgId || null, order.orderNumber, order.productId || null, order.deviceId || null, order.lineId || null, order.status || "planned", order.priority || 0, order.plannedQuantity || 0, order.unit || "units", order.plannedStart || null, order.plannedEnd || null, order.customer || null, order.notes || null, order.metadata ? JSON.stringify(order.metadata) : "{}"]
    );
    return { id, ...order, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  },
  async updateProductionOrder(id, updates) {
    const sets = [];
    const params = [id];
    let idx = 2;
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined && k !== "id") {
        const col = k === "orgId" ? "org_id" : k === "orderNumber" ? "order_number" : k === "productId" ? "product_id" : k === "deviceId" ? "device_id" : k === "lineId" ? "line_id" : k === "plannedQuantity" ? "planned_quantity" : k === "actualQuantity" ? "actual_quantity" : k === "goodQuantity" ? "good_quantity" : k === "rejectQuantity" ? "reject_quantity" : k === "plannedStart" ? "planned_start" : k === "plannedEnd" ? "planned_end" : k === "actualStart" ? "actual_start" : k === "actualEnd" ? "actual_end" : k;
        sets.push(`${col} = $${idx}`); params.push(v); idx++;
      }
    }
    sets.push("updated_at = now()");
    if (sets.length > 1) await db.query(`UPDATE production_orders SET ${sets.join(", ")} WHERE id = $1`, params);
    return await store.getProductionOrder(id);
  },
  async deleteProductionOrder(id) {
    await db.query("DELETE FROM production_events WHERE order_id = $1", [id]);
    await db.query("DELETE FROM quality_metrics WHERE order_id = $1", [id]);
    await db.query("DELETE FROM production_orders WHERE id = $1", [id]);
  },

  // --- Production Events ---
  async listProductionEvents(filters = {}) {
    let query = "SELECT * FROM production_events";
    const params = [];
    const conditions = [];
    if (filters.orderId) { params.push(filters.orderId); conditions.push(`order_id = $${params.length}`); }
    if (filters.deviceId) { params.push(filters.deviceId); conditions.push(`device_id = $${params.length}`); }
    if (filters.eventType) { params.push(filters.eventType); conditions.push(`event_type = $${params.length}`); }
    if (conditions.length) query += " WHERE " + conditions.join(" AND ");
    query += " ORDER BY start_time DESC LIMIT 200";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, orderId: r.order_id, deviceId: r.device_id, eventType: r.event_type, eventCode: r.event_code, message: r.message, quantity: r.quantity, durationSeconds: r.duration_seconds, startTime: r.start_time, endTime: r.end_time, metadata: r.metadata, createdBy: r.created_by, createdAt: r.created_at }));
  },
  async createProductionEvent(event) {
    const id = `pe_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      `INSERT INTO production_events (id, order_id, device_id, event_type, event_code, message, quantity, duration_seconds, start_time, metadata, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())`,
      [id, event.orderId || null, event.deviceId, event.eventType, event.eventCode || null, event.message || "", event.quantity || 0, event.durationSeconds || 0, event.startTime || new Date().toISOString(), event.metadata ? JSON.stringify(event.metadata) : "{}", event.createdBy || null]
    );
    return { id, ...event, createdAt: new Date().toISOString() };
  },
  async endProductionEvent(id) {
    await db.query("UPDATE production_events SET end_time = now(), duration_seconds = EXTRACT(EPOCH FROM (now() - start_time))::INTEGER WHERE id = $1 AND end_time IS NULL", [id]);
    const { rows } = await db.query("SELECT * FROM production_events WHERE id = $1", [id]);
    return rows[0] ? { id: rows[0].id, endTime: rows[0].end_time, durationSeconds: rows[0].duration_seconds } : null;
  },

  // --- Quality Metrics ---
  async listQualityMetrics(filters = {}) {
    let query = "SELECT * FROM quality_metrics";
    const params = [];
    const conditions = [];
    if (filters.orderId) { params.push(filters.orderId); conditions.push(`order_id = $${params.length}`); }
    if (filters.deviceId) { params.push(filters.deviceId); conditions.push(`device_id = $${params.length}`); }
    if (filters.metricName) { params.push(filters.metricName); conditions.push(`metric_name = $${params.length}`); }
    if (conditions.length) query += " WHERE " + conditions.join(" AND ");
    query += " ORDER BY measured_at DESC LIMIT 200";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, orderId: r.order_id, deviceId: r.device_id, metricName: r.metric_name, metricValue: Number(r.metric_value), targetValue: r.target_value !== null ? Number(r.target_value) : null, minValue: r.min_value !== null ? Number(r.min_value) : null, maxValue: r.max_value !== null ? Number(r.max_value) : null, unit: r.unit, pass: r.pass, notes: r.notes, measuredAt: r.measured_at, createdAt: r.created_at }));
  },
  async addQualityMetric(metric) {
    const id = `qm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    // Auto-determine pass/fail based on min/max thresholds
    let pass = true;
    if (metric.minValue !== null && metric.minValue !== undefined && metric.metricValue < metric.minValue) pass = false;
    if (metric.maxValue !== null && metric.maxValue !== undefined && metric.metricValue > metric.maxValue) pass = false;
    await db.query(
      `INSERT INTO quality_metrics (id, order_id, device_id, metric_name, metric_value, target_value, min_value, max_value, unit, pass, notes, measured_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())`,
      [id, metric.orderId || null, metric.deviceId, metric.metricName, Number(metric.metricValue), metric.targetValue !== undefined ? Number(metric.targetValue) : null, metric.minValue !== undefined ? Number(metric.minValue) : null, metric.maxValue !== undefined ? Number(metric.maxValue) : null, metric.unit || "", pass, metric.notes || null, metric.measuredAt || new Date().toISOString()]
    );
    return { id, ...metric, pass, createdAt: new Date().toISOString() };
  },

  // --- Shift Templates ---
  async listShiftTemplates(orgId) {
    let query = "SELECT * FROM shift_templates";
    const params = [];
    if (orgId) { query += " WHERE org_id = $1"; params.push(orgId); }
    query += " ORDER BY start_time";
    const { rows } = await db.query(query, params);
    return rows.map(r => ({ id: r.id, orgId: r.org_id, name: r.name, startTime: r.start_time, endTime: r.end_time, breakMinutes: r.break_minutes, daysOfWeek: r.days_of_week, color: r.color, enabled: r.enabled, createdAt: r.created_at }));
  },
  async createShiftTemplate(template) {
    const id = `st_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.query(
      `INSERT INTO shift_templates (id, org_id, name, start_time, end_time, break_minutes, days_of_week, color, enabled, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
      [id, template.orgId || null, template.name, template.startTime, template.endTime, template.breakMinutes || 0, template.daysOfWeek || "{1,2,3,4,5}", template.color || "#3B82F6", template.enabled !== false]
    );
    return { id, ...template, createdAt: new Date().toISOString() };
  },
  async updateShiftTemplate(id, updates) {
    const sets = [];
    const params = [id];
    let idx = 2;
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined && k !== "id") {
        const col = k === "orgId" ? "org_id" : k === "startTime" ? "start_time" : k === "endTime" ? "end_time" : k === "breakMinutes" ? "break_minutes" : k === "daysOfWeek" ? "days_of_week" : k;
        sets.push(`${col} = $${idx}`); params.push(v); idx++;
      }
    }
    if (sets.length) await db.query(`UPDATE shift_templates SET ${sets.join(", ")} WHERE id = $1`, params);
  },
  async deleteShiftTemplate(id) {
    await db.query("DELETE FROM shift_templates WHERE id = $1", [id]);
  },
};

module.exports = store;
