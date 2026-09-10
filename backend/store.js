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
    scheduledDate: r.scheduled_date, dueDate: r.due_date, intervalDays: r.interval_days,
    technician: r.technician, notes: r.notes, parts: r.parts, labourHours: Number(r.labour_hours),
    labourCost: Number(r.labour_cost), downtimeMinutes: Number(r.downtime_minutes), attachments: r.attachments,
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
  async listDashboardViews() {
    const { rows } = await db.query("SELECT * FROM dashboard_views ORDER BY is_default DESC, name");
    return rows.map(r => ({ id: r.id, name: r.name, isDefault: r.is_default, createdBy: r.created_by, createdAt: r.created_at }));
  },
  async addDashboardView(name, createdBy) {
    const id = `dv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const existing = await db.query("SELECT count(*) FROM dashboard_views");
    const isDefault = Number(existing.rows[0].count) === 0;
    await db.query(
      "INSERT INTO dashboard_views (id, name, is_default, created_by, created_at) VALUES ($1,$2,$3,$4,now())",
      [id, name, isDefault, createdBy]
    );
    return { id, name, isDefault, createdBy };
  },
  async removeDashboardView(id) {
    await db.query("DELETE FROM dashboard_views WHERE id = $1 AND is_default = false", [id]);
  },
  async getDashboardWidgets(viewId) {
    const { rows } = await db.query("SELECT * FROM dashboard_widgets WHERE view_id = $1 ORDER BY sort_order", [viewId]);
    return rows.map(r => ({ id: r.id, deviceId: r.device_id, metric: r.metric, sortOrder: r.sort_order }));
  },
  async addDashboardWidget(viewId, deviceId, metric) {
    const id = `dw_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const maxOrder = await db.query("SELECT COALESCE(MAX(sort_order),0)+1 as next FROM dashboard_widgets WHERE view_id=$1", [viewId]);
    await db.query(
      "INSERT INTO dashboard_widgets (id, view_id, device_id, metric, sort_order, created_at) VALUES ($1,$2,$3,$4,$5,now())",
      [id, viewId, deviceId, metric, maxOrder.rows[0].next]
    );
    return { id, viewId, deviceId, metric, sortOrder: maxOrder.rows[0].next };
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
    await db.query("UPDATE alert_history SET acknowledged_by = $2, acknowledged_at = now() WHERE id = $1", [id, username]);
    for (const [key, alert] of activeAlerts) {
      if (alert.id === id) { alert.acknowledgedBy = username; alert.acknowledgedAt = new Date().toISOString(); }
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
        "SELECT target_weight, actual_weight FROM readings WHERE device_id = $1 ORDER BY ts DESC LIMIT 20",
        [d.id]
      );
      let readingScore = 100;
      if (readings.length > 0) {
        const withinTolerance = readings.filter(r => Math.abs(r.actual_weight - r.target_weight) <= (d.tolerance || 5)).length;
        readingScore = Math.round((withinTolerance / readings.length) * 100);
      } else {
        readingScore = 50; // no data = unknown
      }

      // Factor 2: Maintenance recency (last maintenance within 30 days = 100, 60 days = 75, 90+ = 50)
      let maintenanceScore = 100;
      const { rows: maint } = await db.query(
        "SELECT performed_at FROM maintenance WHERE device_id = $1 ORDER BY performed_at DESC LIMIT 1",
        [d.id]
      );
      if (maint.length) {
        const daysSince = (Date.now() - new Date(maint[0].performed_at).getTime()) / 86400000;
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

      // Weighted composite score
      const healthScore = Math.round(
        readingScore * 0.30 +
        maintenanceScore * 0.20 +
        calibrationScore * 0.20 +
        alertScore * 0.15 +
        freshnessScore * 0.15
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
    const record = {
      id: newId("m"), deviceId: input.deviceId, workOrderNumber: input.workOrderNumber || `WO-${Date.now()}`,
      status: input.status || "SCHEDULED", scheduledDate: input.scheduledDate || null, dueDate: input.dueDate || null,
      intervalDays: input.intervalDays ? Number(input.intervalDays) : null, technician: input.technician || "",
      notes: input.notes || "", parts: input.parts || [], labourHours: Number(input.labourHours) || 0,
      labourCost: Number(input.labourCost) || 0, downtimeMinutes: Number(input.downtimeMinutes) || 0,
      attachments: input.attachments || [], createdAt: new Date().toISOString(), completedAt: null,
    };
    await db.query(
      `INSERT INTO maintenance_records (id, device_id, work_order_number, status, scheduled_date, due_date, interval_days,
         technician, notes, parts, labour_hours, labour_cost, downtime_minutes, attachments, created_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [record.id, record.deviceId, record.workOrderNumber, record.status, record.scheduledDate, record.dueDate, record.intervalDays,
       record.technician, record.notes, JSON.stringify(record.parts), record.labourHours, record.labourCost, record.downtimeMinutes,
       JSON.stringify(record.attachments), record.createdAt, record.completedAt]
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
      status: input.status ?? existing.status, scheduledDate: input.scheduledDate ?? existing.scheduledDate,
      dueDate: input.dueDate ?? existing.dueDate,
      intervalDays: input.intervalDays !== undefined ? (Number(input.intervalDays) || null) : existing.intervalDays,
      technician: input.technician ?? existing.technician, notes: input.notes ?? existing.notes,
      parts: input.parts ?? existing.parts,
      labourHours: input.labourHours !== undefined ? Number(input.labourHours) : existing.labourHours,
      labourCost: input.labourCost !== undefined ? Number(input.labourCost) : existing.labourCost,
      downtimeMinutes: input.downtimeMinutes !== undefined ? Number(input.downtimeMinutes) : existing.downtimeMinutes,
      attachments: input.attachments ?? existing.attachments,
    };
    if (!wasCompleted && merged.status === "COMPLETED") merged.completedAt = new Date().toISOString();

    await db.query(
      `UPDATE maintenance_records SET status=$2, scheduled_date=$3, due_date=$4, interval_days=$5, technician=$6,
         notes=$7, parts=$8, labour_hours=$9, labour_cost=$10, downtime_minutes=$11, attachments=$12, completed_at=$13
       WHERE id=$1`,
      [id, merged.status, merged.scheduledDate, merged.dueDate, merged.intervalDays, merged.technician, merged.notes,
       JSON.stringify(merged.parts), merged.labourHours, merged.labourCost, merged.downtimeMinutes, JSON.stringify(merged.attachments), merged.completedAt]
    );

    let nextRecord = null;
    if (!wasCompleted && merged.status === "COMPLETED" && merged.intervalDays) {
      const nextDue = new Date(Date.now() + merged.intervalDays * 24 * 60 * 60 * 1000).toISOString();
      nextRecord = await store.addMaintenanceRecord({
        deviceId: merged.deviceId, workOrderNumber: `WO-${Date.now()}`, status: "SCHEDULED",
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
};

module.exports = store;
