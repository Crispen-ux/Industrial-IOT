require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const PDFDocument = require("pdfkit");
const store = require("./store");
const auth = require("./auth");
const notify = require("./notify");
const { encrypt, decrypt, isEncrypted } = require("./crypto");
const db = require("./db");
const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");

const PORT = process.env.PORT || 4000;
const ROLES = ["operator", "manager", "admin"];
const ROLE_RANK = { operator: 0, manager: 1, admin: 2 };

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "frontend")));

// ---------- Swagger API Docs ----------
const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: { title: "Scale Ops IoT API", version: "1.0.0", description: "Industrial bag-filling scale monitoring platform API" },
    servers: [{ url: "/", description: "Current server" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        gatewayKey: { type: "apiKey", in: "header", name: "X-Gateway-Key" },
      },
      schemas: {
        Device: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, ip: { type: "string" }, protocol: { type: "string" }, target: { type: "number" }, unit: { type: "string" }, costPerUnit: { type: "number" }, productId: { type: "string" } } },
        Product: { type: "object", properties: { id: { type: "string" }, code: { type: "string" }, name: { type: "string" }, targetWeight: { type: "number" }, toleranceType: { type: "string" }, toleranceValue: { type: "number" }, unit: { type: "string" }, status: { type: "string" } } },
        Reading: { type: "object", properties: { weight: { type: "number" }, phase: { type: "string" }, bagCount: { type: "integer" }, connected: { type: "boolean" }, ts: { type: "integer" } } },
        Alert: { type: "object", properties: { id: { type: "string" }, deviceId: { type: "string" }, deviceName: { type: "string" }, type: { type: "string" }, message: { type: "string" }, severity: { type: "string" }, since: { type: "string" }, active: { type: "boolean" } } },
        User: { type: "object", properties: { id: { type: "string" }, username: { type: "string" }, role: { type: "string" } } },
        DowntimeLog: { type: "object", properties: { id: { type: "string" }, deviceId: { type: "string" }, deviceName: { type: "string" }, startedAt: { type: "string" }, endedAt: { type: "string" }, reasonCode: { type: "string" }, reasonNote: { type: "string" }, reportedBy: { type: "string" } } },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: [],
});
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, { customCss: ".swagger-ui .topbar { display: none }", customSiteTitle: "Scale Ops API Docs" }));
app.get("/api-docs.json", (req, res) => res.json(swaggerSpec));

// Rate limiting middleware
const rateLimitStore = new Map(); // In-memory, reset on restart
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 200;

function rateLimitMiddleware(req, res, next) {
  if (!req.user?.id) return next();
  const key = req.user.id;
  const now = Date.now();
  let entry = rateLimitStore.get(key);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, start: now };
    rateLimitStore.set(key, entry);
  }
  entry.count++;
  res.set("X-RateLimit-Limit", RATE_LIMIT_MAX);
  res.set("X-RateLimit-Remaining", Math.max(0, RATE_LIMIT_MAX - entry.count));
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Rate limit exceeded. Try again later." });
  }
  next();
}

// Usage tracking middleware
app.use("/api", (req, res, next) => {
  const startTime = Date.now();
  res.on("finish", () => {
    if (req.user?.id && req.method !== "OPTIONS") {
      const userId = req.user.id;
      const endpoint = req.originalUrl.split("?")[0];
      const method = req.method;
      const statusCode = res.statusCode;
      const ip = req.ip;
      // Log async, don't block response
      db.query(
        "INSERT INTO api_usage (id, user_id, endpoint, method, status_code, ip, created_at) VALUES ($1,$2,$3,$4,$5,$6,now())",
        [`au_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, userId, endpoint, method, statusCode, ip]
      ).catch(() => {});
    }
  });
  next();
});

// Wraps an async route handler so a rejected promise becomes a clean 500
// instead of an unhandled rejection / hung request. Every store call now
// goes to Postgres and can fail (network blip, pool exhaustion, etc.) —
// this is what keeps that failure mode from crashing the process.
function ah(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error("[server] request error:", err);
      if (!res.headersSent) res.status(500).json({ error: "internal server error" });
    });
  };
}

// ---------- Auth middleware ----------

async function decodeUserToken(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const secret = await store.getJwtSecret();
  if (!token || !secret) return null;
  const payload = auth.verifyToken(token, secret);
  if (!payload) return null;
  // role is looked up live (not trusted from the token) so a role change or
  // account removal takes effect immediately, not after the token expires
  const user = await store.findUserById(payload.uid);
  if (!user) return null;
  return { id: user.id, username: user.username, role: user.role };
}

const requireUser = ah(async (req, res, next) => {
  const user = await decodeUserToken(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  req.user = user;
  next();
});
// ah() is written for (req,res) handlers, but middleware needs (req,res,next) —
// this thin variant does the same promise-safety for 3-arg middleware.
function ahmw(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error("[server] middleware error:", err);
      if (!res.headersSent) res.status(500).json({ error: "internal server error" });
    });
  };
}

const requireUserMw = ahmw(async (req, res, next) => {
  const user = await decodeUserToken(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  req.user = user;
  next();
});

// requireRole("manager") allows manager AND admin — ranks are hierarchical,
// not a strict allow-list, so admin always has everything manager has.
function requireRole(minRole) {
  return ahmw(async (req, res, next) => {
    const user = await decodeUserToken(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    if (ROLE_RANK[user.role] < ROLE_RANK[minRole]) {
      return res.status(403).json({ error: `requires ${minRole} role or higher` });
    }
    req.user = user;
    next();
  });
}

const requireGatewayKey = ahmw(async (req, res, next) => {
  const key = req.headers["x-gateway-key"];
  if (!key || !(await store.findGatewayKey(key))) {
    return res.status(401).json({ error: "missing or invalid gateway key" });
  }
  next();
});

// Some endpoints are read by both the dashboard (user token) and the
// gateway (API key, e.g. to fetch the device list it should poll).
const requireUserOrGatewayKey = ahmw(async (req, res, next) => {
  const user = await decodeUserToken(req);
  if (user) {
    req.user = user;
    return next();
  }
  const key = req.headers["x-gateway-key"];
  if (key && (await store.findGatewayKey(key))) return next();
  return res.status(401).json({ error: "not authenticated" });
});

// Fire-and-forget by design (never blocks the response on an audit write),
// but still logs failures instead of silently swallowing them.
function audit(req, action, details = {}) {
  store.logAudit({ username: req.user.username, role: req.user.role, action, details })
    .catch((err) => console.error("[audit] failed to log:", err.message));
}

// ---------- Auth routes ----------

app.post("/api/auth/login", ah(async (req, res) => {
  const { username, password, twoFactorCode } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }
  const user = await store.findUserByUsername(username);
  if (!user) return res.status(401).json({ error: "invalid username or password" });
  const ok = await auth.verifyPassword(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "invalid username or password" });

  // 2FA check
  const faStatus = await store.get2FASecret(user.id);
  if (faStatus?.enabled) {
    if (!twoFactorCode) {
      return res.json({ requires2FA: true, username: user.username });
    }
    const verified = speakeasy.totp.verify({ secret: faStatus.secret, encoding: "base32", code: twoFactorCode, window: 1 });
    if (!verified) return res.status(401).json({ error: "invalid 2FA code" });
  }

  const secret = await store.getJwtSecret();
  const token = auth.signToken({ uid: user.id }, secret);
  // Track session
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await store.createSession(user.id, tokenHash, req.ip, req.get("User-Agent"), expiresAt);
  store.logAudit({ username: user.username, role: user.role, action: "login", details: {} })
    .catch((err) => console.error("[audit] failed to log:", err.message));
  res.json({ token, username: user.username, role: user.role, twoFactorEnabled: faStatus?.enabled || false });
}));

app.get("/api/auth/me", requireUserMw, ah(async (req, res) => {
  res.json(req.user);
}));

app.post("/api/auth/revoke-sessions", requireUserMw, ah(async (req, res) => {
  await db.query("DELETE FROM user_sessions WHERE user_id = $1", [req.user.id]);
  audit(req, "sessions_revoked", {});
  res.json({ ok: true, message: "All other sessions revoked" });
}));

// ---------- User management (admin only) ----------

app.get("/api/users", requireRole("admin"), ah(async (req, res) => {
  const users = await store.listUsers();
  res.json(users.map((u) => ({ id: u.id, username: u.username, role: u.role, createdAt: u.createdAt })));
}));

app.post("/api/users", requireRole("admin"), ah(async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !ROLES.includes(role)) {
    return res.status(400).json({ error: `username, password, and role (one of ${ROLES.join("/")}) are required` });
  }
  if (await store.findUserByUsername(username)) {
    return res.status(409).json({ error: "username already exists" });
  }
  const passwordHash = await auth.hashPassword(password);
  const user = {
    id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    username,
    passwordHash,
    role,
    createdAt: new Date().toISOString(),
  };
  await store.addUser(user);
  audit(req, "user_create", { username, role });
  res.status(201).json({ id: user.id, username: user.username, role: user.role, createdAt: user.createdAt });
}));

app.patch("/api/users/:id/role", requireRole("admin"), ah(async (req, res) => {
  const { role } = req.body;
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of ${ROLES.join("/")}` });
  }
  const target = await store.findUserById(req.params.id);
  if (!target) return res.status(404).json({ error: "user not found" });
  if (target.role === "admin" && role !== "admin" && (await store.countAdmins()) <= 1) {
    return res.status(400).json({ error: "cannot demote the last admin" });
  }
  const updated = await store.setUserRole(req.params.id, role);
  audit(req, "user_role_change", { targetUsername: target.username, from: target.role, to: role });
  res.json({ id: updated.id, username: updated.username, role: updated.role });
}));

app.delete("/api/users/:id", requireRole("admin"), ah(async (req, res) => {
  const target = await store.findUserById(req.params.id);
  if (!target) return res.status(204).end();
  if (target.role === "admin" && (await store.countAdmins()) <= 1) {
    return res.status(400).json({ error: "cannot remove the last admin" });
  }
  await store.removeUser(req.params.id);
  audit(req, "user_remove", { targetUsername: target.username });
  res.status(204).end();
}));

// ---------- Password change (any logged-in user) ----------

app.post("/api/auth/change-password", requireUserMw, ah(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "currentPassword and newPassword are required" });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: "new password must be at least 6 characters" });
  }
  const user = await store.findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: "user not found" });
  const ok = await auth.verifyPassword(currentPassword, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "current password is incorrect" });
  const passwordHash = await auth.hashPassword(newPassword);
  await store.setUserPassword(req.user.id, passwordHash);
  audit(req, "password_change", {});
  res.json({ ok: true });
}));

// ---------- 2FA (TOTP) ----------
const speakeasy = require("speakeasy");
const QRCode = require("qrcode");
const crypto = require("crypto");

app.get("/api/auth/2fa/status", requireUserMw, ah(async (req, res) => {
  const status = await store.get2FASecret(req.user.id);
  res.json({ enabled: status?.enabled || false });
}));

app.post("/api/auth/2fa/setup", requireUserMw, ah(async (req, res) => {
  const secret = speakeasy.generateSecret({ name: `ScaleOps (${req.user.username})`, issuer: "ScaleOps" });
  await store.set2FASecret(req.user.id, secret.base32);
  const otpauth = secret.otpauth_url;
  const qrDataUrl = await QRCode.toDataURL(otpauth);
  res.json({ secret: secret.base32, qr: qrDataUrl });
}));

app.post("/api/auth/2fa/verify", requireUserMw, ah(async (req, res) => {
  const { code } = req.body;
  const status = await store.get2FASecret(req.user.id);
  if (!status?.secret) return res.status(400).json({ error: "2FA not set up" });
  const verified = speakeasy.totp.verify({ secret: status.secret, encoding: "base32", code, window: 1 });
  if (!verified) return res.status(400).json({ error: "Invalid code" });
  await store.enable2FA(req.user.id);
  audit(req, "2fa_enable", {});
  res.json({ ok: true });
}));

app.post("/api/auth/2fa/disable", requireUserMw, ah(async (req, res) => {
  const { password } = req.body;
  const user = await store.findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: "user not found" });
  const ok = await auth.verifyPassword(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "incorrect password" });
  await store.disable2FA(req.user.id);
  audit(req, "2fa_disable", {});
  res.json({ ok: true });
}));

// ---------- Sessions ----------
app.get("/api/auth/sessions", requireUserMw, ah(async (req, res) => {
  const sessions = await store.listUserSessions(req.user.id);
  res.json(sessions.map(s => ({ id: s.id, ip: s.ip, userAgent: s.user_agent, createdAt: s.created_at, expiresAt: s.expires_at })));
}));

app.delete("/api/auth/sessions/:id", requireUserMw, ah(async (req, res) => {
  await store.removeSession(req.params.id);
  audit(req, "session_revoke", { sessionId: req.params.id });
  res.status(204).end();
}));

app.delete("/api/auth/sessions", requireUserMw, ah(async (req, res) => {
  await store.removeUserSessions(req.user.id);
  audit(req, "session_revoke_all", {});
  res.status(204).end();
}));

// ---------- Gateway API keys (manager+) ----------

app.get("/api/gateway-keys", requireRole("manager"), ah(async (req, res) => {
  const keys = await store.listGatewayKeys();
  res.json(keys.map((k) => ({ id: k.id, label: k.label, createdAt: k.createdAt, keyPreview: k.key.slice(0, 10) + "…" })));
}));

app.post("/api/gateway-keys", requireRole("manager"), ah(async (req, res) => {
  const label = (req.body.label || "gateway").trim();
  const entry = {
    id: `k_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    key: auth.randomApiKey(),
    label,
    createdAt: new Date().toISOString(),
  };
  await store.addGatewayKey(entry);
  audit(req, "gateway_key_create", { label });
  res.status(201).json(entry); // full key returned once, here only
}));

app.delete("/api/gateway-keys/:id", requireRole("manager"), ah(async (req, res) => {
  const keys = await store.listGatewayKeys();
  const existing = keys.find((k) => k.id === req.params.id);
  await store.removeGatewayKey(req.params.id);
  audit(req, "gateway_key_revoke", { label: existing ? existing.label : req.params.id });
  res.status(204).end();
}));

// ---------- Multi-site sync ----------
// A "sync key" represents an entire remote site pushing its data up here —
// broader scope than a single gateway key (which can only post readings for
// devices that already exist), so this is admin-only, not manager+.

app.get("/api/sync-keys", requireRole("admin"), ah(async (req, res) => {
  const keys = await store.listSyncKeys();
  res.json(keys.map((k) => ({ id: k.id, siteId: k.siteId, siteLabel: k.siteLabel, createdAt: k.createdAt, keyPreview: k.key.slice(0, 10) + "…" })));
}));

app.post("/api/sync-keys", requireRole("admin"), ah(async (req, res) => {
  const siteId = (req.body.siteId || "").trim();
  const siteLabel = (req.body.siteLabel || siteId).trim();
  if (!siteId) return res.status(400).json({ error: "siteId is required (e.g. 'durban-plant') — used to prefix that site's record IDs so multiple sites never collide" });
  if (!/^[a-z0-9-]+$/i.test(siteId)) return res.status(400).json({ error: "siteId should be simple: letters, numbers, hyphens only" });
  const entry = {
    id: `sk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    key: auth.randomApiKey("site"),
    siteId,
    siteLabel,
    createdAt: new Date().toISOString(),
  };
  await store.addSyncKey(entry);
  audit(req, "sync_key_create", { siteId, siteLabel });
  res.status(201).json(entry); // full key returned once, here only
}));

app.delete("/api/sync-keys/:id", requireRole("admin"), ah(async (req, res) => {
  const keys = await store.listSyncKeys();
  const existing = keys.find((k) => k.id === req.params.id);
  await store.removeSyncKey(req.params.id);
  audit(req, "sync_key_revoke", { siteId: existing ? existing.siteId : req.params.id });
  res.status(204).end();
}));

// The actual sync push, called by a "local" instance's sync agent (see
// runSyncAgent below), never by a browser. Idempotent — every record carries
// its own stable ID, so resending the same batch (e.g. after a retry) is
// always safe, same philosophy as the gateway's reading buffer.
app.post("/api/sync/push", ah(async (req, res) => {
  const key = req.headers["x-sync-key"];
  if (!key) return res.status(401).json({ error: "missing X-Sync-Key header" });
  const syncKey = await store.findSyncKey(key);
  if (!syncKey) return res.status(401).json({ error: "invalid or revoked sync key" });

  const { records } = req.body;
  if (!Array.isArray(records)) return res.status(400).json({ error: "records must be an array" });

  // Per-record results, in the same order as the input — this is what lets
  // the sync agent mark only the records that actually succeeded as synced.
  // A batch-level "applied: N" count alone isn't enough: if the agent marked
  // the whole batch synced regardless of individual failures, a record that
  // errored would never be retried and would silently vanish from the cloud
  // forever. (This was a real bug in the first version of this endpoint —
  // caught by testing a device delete that crashed on the cloud side but
  // still got marked synced on the site side.)
  const results = [];
  let applied = 0;
  for (const r of records) {
    try {
      await store.upsertSyncedEntity(r.entityType, r.operation, r.entityId, r.payload, syncKey.siteId, syncKey.siteLabel);
      results.push({ success: true });
      applied += 1;
    } catch (err) {
      results.push({ success: false, entityType: r.entityType, entityId: r.entityId, error: err.message });
    }
  }
  res.json({ applied, total: records.length, results, errors: results.filter((r) => !r.success) });
}));

// Local-instance-only: lets the dashboard show sync health (backlog size) —
// meaningless and returns zeros on a cloud/standalone instance, which is fine.
app.get("/api/sync/status", requireUserMw, ah(async (req, res) => {
  const pendingCount = await store.countUnsyncedOutbox();
  res.json({
    role: process.env.SYNC_ROLE || "none",
    cloudUrl: process.env.SYNC_ROLE === "local" ? process.env.CLOUD_SYNC_URL : null,
    pendingCount,
  });
}));

// ---------- Alerts (view: any role, configure: manager+) ----------

app.get("/api/alert-config", requireUserMw, ah(async (req, res) => {
  res.json(await store.getAlertConfig());
}));

app.put("/api/alert-config", requireRole("manager"), ah(async (req, res) => {
  const { toleranceThresholdPercent, consecutiveBagsThreshold, offlineTimeoutSeconds, webhookUrl, calibrationReminderDays, maintenanceReminderDays } = req.body;
  const updated = await store.setAlertConfig({
    ...(toleranceThresholdPercent !== undefined && { toleranceThresholdPercent: Number(toleranceThresholdPercent) }),
    ...(consecutiveBagsThreshold !== undefined && { consecutiveBagsThreshold: Number(consecutiveBagsThreshold) }),
    ...(offlineTimeoutSeconds !== undefined && { offlineTimeoutSeconds: Number(offlineTimeoutSeconds) }),
    ...(webhookUrl !== undefined && { webhookUrl }),
    ...(calibrationReminderDays !== undefined && { calibrationReminderDays: Number(calibrationReminderDays) }),
    ...(maintenanceReminderDays !== undefined && { maintenanceReminderDays: Number(maintenanceReminderDays) }),
  });
  audit(req, "alert_config_update", updated);
  res.json(updated);
}));

// --- Notification config (email + WhatsApp) ---
app.get("/api/notification-config", requireRole("manager"), ah(async (req, res) => {
  const cfg = await store.getNotificationConfig();
  // Decrypt sensitive fields for internal use, mask for frontend
  const decrypted = { ...cfg };
  if (cfg.smtpPass && isEncrypted(cfg.smtpPass)) decrypted.smtpPass = decrypt(cfg.smtpPass);
  if (cfg.ultrammsgToken && isEncrypted(cfg.ultrammsgToken)) decrypted.ultrammsgToken = decrypt(cfg.ultrammsgToken);
  if (cfg.slackWebhookUrl && isEncrypted(cfg.slackWebhookUrl)) decrypted.slackWebhookUrl = decrypt(cfg.slackWebhookUrl);
  if (cfg.teamsWebhookUrl && isEncrypted(cfg.teamsWebhookUrl)) decrypted.teamsWebhookUrl = decrypt(cfg.teamsWebhookUrl);
  // Never expose passwords/tokens to the frontend
  const safe = { ...decrypted, smtpPass: decrypted.smtpPass ? "••••••" : "", ultrammsgToken: decrypted.ultrammsgToken ? "••••••" : "", slackWebhookUrl: decrypted.slackWebhookUrl ? "••••••" : "", teamsWebhookUrl: decrypted.teamsWebhookUrl ? "••••••" : "" };
  // Also store decrypted for notify module use
  notify.initEmailTransporter(decrypted);
  res.json(safe);
}));

app.put("/api/notification-config", requireRole("manager"), ah(async (req, res) => {
  const { emailEnabled, emailRecipients, smtpUser, smtpPass, whatsappEnabled, whatsappRecipients, ultrammsgUrl, ultrammsgToken, ultrammsgInstanceId, slackEnabled, slackWebhookUrl, teamsEnabled, teamsWebhookUrl, downtimeNotifyEnabled } = req.body;
  const cfg = {};
  if (emailEnabled !== undefined) cfg.emailEnabled = !!emailEnabled;
  if (emailRecipients !== undefined) cfg.emailRecipients = emailRecipients;
  if (smtpUser !== undefined) cfg.smtpUser = smtpUser;
  if (smtpPass !== undefined && smtpPass !== "••••••") cfg.smtpPass = smtpPass;
  if (whatsappEnabled !== undefined) cfg.whatsappEnabled = !!whatsappEnabled;
  if (whatsappRecipients !== undefined) cfg.whatsappRecipients = whatsappRecipients;
  if (ultrammsgUrl !== undefined) cfg.ultrammsgUrl = ultrammsgUrl;
  if (ultrammsgToken !== undefined && ultrammsgToken !== "••••••") cfg.ultrammsgToken = ultrammsgToken;
  if (ultrammsgInstanceId !== undefined) cfg.ultrammsgInstanceId = ultrammsgInstanceId;
  if (slackEnabled !== undefined) cfg.slackEnabled = !!slackEnabled;
  if (slackWebhookUrl !== undefined) cfg.slackWebhookUrl = slackWebhookUrl;
  if (teamsEnabled !== undefined) cfg.teamsEnabled = !!teamsEnabled;
  if (teamsWebhookUrl !== undefined) cfg.teamsWebhookUrl = teamsWebhookUrl;
  if (downtimeNotifyEnabled !== undefined) cfg.downtimeNotifyEnabled = !!downtimeNotifyEnabled;
  // Encrypt sensitive fields before storing
  if (cfg.smtpPass) cfg.smtpPass = encrypt(cfg.smtpPass);
  if (cfg.ultrammsgToken) cfg.ultrammsgToken = encrypt(cfg.ultrammsgToken);
  if (cfg.slackWebhookUrl) cfg.slackWebhookUrl = encrypt(cfg.slackWebhookUrl);
  if (cfg.teamsWebhookUrl) cfg.teamsWebhookUrl = encrypt(cfg.teamsWebhookUrl);
  const updated = await store.setNotificationConfig(cfg);
  // Decrypt for notify module
  const decrypted = { ...updated };
  if (updated.smtpPass && isEncrypted(updated.smtpPass)) decrypted.smtpPass = decrypt(updated.smtpPass);
  if (updated.ultrammsgToken && isEncrypted(updated.ultrammsgToken)) decrypted.ultrammsgToken = decrypt(updated.ultrammsgToken);
  if (updated.slackWebhookUrl && isEncrypted(updated.slackWebhookUrl)) decrypted.slackWebhookUrl = decrypt(updated.slackWebhookUrl);
  if (updated.teamsWebhookUrl && isEncrypted(updated.teamsWebhookUrl)) decrypted.teamsWebhookUrl = decrypt(updated.teamsWebhookUrl);
  notify.initEmailTransporter(decrypted);
  audit(req, "notification_config_update", { ...updated, smtpPass: updated.smtpPass ? "••••••" : "", ultrammsgToken: updated.ultrammsgToken ? "••••••" : "" });
  const safe = { ...updated, smtpPass: updated.smtpPass ? "••••••" : "", ultrammsgToken: updated.ultrammsgToken ? "••••••" : "", slackWebhookUrl: updated.slackWebhookUrl ? "••••••" : "", teamsWebhookUrl: updated.teamsWebhookUrl ? "••••••" : "" };
  res.json(safe);
}));

app.post("/api/notification-config/test", requireRole("manager"), ah(async (req, res) => {
  const cfg = await store.getNotificationConfig();
  const { channel } = req.body;
  if (channel === "email") {
    await notify.sendEmail(cfg.emailRecipients, "Scale Ops — Test Notification", '<div style="font-family:sans-serif;padding:20px;"><h2>✓ Test Email</h2><p>If you received this, email notifications are working.</p></div>');
    res.json({ ok: true });
  } else if (channel === "whatsapp") {
    await notify.sendWhatsApp(cfg, cfg.whatsappRecipients, "Scale Ops — Test Notification. If you received this, WhatsApp notifications are working.");
    res.json({ ok: true });
  } else if (channel === "slack") {
    await notify.sendSlack(cfg, "✓ Test Slack notification from Scale Ops. If you received this, Slack notifications are working.");
    res.json({ ok: true });
  } else if (channel === "teams") {
    await notify.sendTeams(cfg, "✓ Test Teams notification from Scale Ops. If you received this, Teams notifications are working.");
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: "channel must be 'email', 'whatsapp', 'slack', or 'teams'" });
  }
}));

app.get("/api/alerts", requireUserMw, ah(async (req, res) => {
  res.json({
    active: store.listActiveAlerts(),
    history: await store.listAlertHistory(Number(req.query.limit) || 50),
  });
}));

// ---------- Audit log (manager+) ----------

app.get("/api/audit-log", requireRole("manager"), ah(async (req, res) => {
  res.json(await store.listAuditLog(Number(req.query.limit) || 100));
}));

app.get("/api/audit-log/export", requireRole("manager"), ah(async (req, res) => {
  const format = req.query.format || "csv";
  const limit = Math.min(parseInt(req.query.limit) || 1000, 10000);
  const logs = await store.listAuditLog(limit);

  if (format === "csv") {
    const headers = ["Timestamp", "User", "IP", "Action", "Details"];
    const rows = logs.map(l => [
      new Date(l.timestamp).toISOString(),
      l.username,
      l.ip,
      l.action,
      JSON.stringify(l.details || {})
    ]);
    const csv = [headers.join(","), ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } else {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(logs);
  }
}));

// ---------- Branding (view: public, edit: manager+) ----------

app.get("/api/branding", ah(async (req, res) => {
  res.json(await store.getBranding());
}));

app.put("/api/branding", requireRole("manager"), ah(async (req, res) => {
  const { companyName, tagline, logoUrl, accentColor } = req.body;
  const updated = await store.setBranding({
    ...(companyName !== undefined && { companyName }),
    ...(tagline !== undefined && { tagline }),
    ...(logoUrl !== undefined && { logoUrl }),
    ...(accentColor !== undefined && { accentColor }),
  });
  audit(req, "branding_update", updated);
  res.json(updated);
}));

// ---------- Devices (view: any role, manage: manager+) ----------

app.get("/api/devices", requireUserOrGatewayKey, ah(async (req, res) => {
  res.json(await store.listDevices());
}));

app.post("/api/devices", requireRole("manager"), ah(async (req, res) => {
  const { name, ip, protocol, target, unit, costPerUnit, productId, connectionConfig } = req.body;
  if (!name || !ip || !protocol) {
    return res.status(400).json({ error: "name, ip and protocol are required" });
  }
  const device = {
    id: `d_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    ip,
    protocol,
    target: Number(target) || 25,
    unit: unit || "kg",
    costPerUnit: Number(costPerUnit) || 0,
    productId: productId || null,
    connectionConfig: connectionConfig || null,
    createdAt: new Date().toISOString(),
  };
  await store.addDevice(device);
  audit(req, "device_add", { name, ip, protocol });
  res.status(201).json(device);
}));

app.put("/api/devices/:id", requireRole("manager"), ah(async (req, res) => {
  const existing = await store.getDevice(req.params.id);
  if (!existing) return res.status(404).json({ error: "device not found" });
  const { name, ip, protocol, target, unit, costPerUnit, productId, connectionConfig } = req.body;
  const updated = await store.updateDevice(req.params.id, {
    ...(name !== undefined && { name }),
    ...(ip !== undefined && { ip }),
    ...(protocol !== undefined && { protocol }),
    ...(target !== undefined && { target: Number(target) }),
    ...(unit !== undefined && { unit }),
    ...(costPerUnit !== undefined && { costPerUnit: Number(costPerUnit) }),
    ...(productId !== undefined && { productId: productId || null }),
    ...(connectionConfig !== undefined && { connectionConfig }),
  });
  audit(req, "device_update", { name: updated.name, changes: Object.keys(req.body) });
  res.json(updated);
}));

app.delete("/api/devices/:id", requireRole("manager"), ah(async (req, res) => {
  const existing = await store.getDevice(req.params.id);
  await store.removeDevice(req.params.id);
  audit(req, "device_remove", { name: existing ? existing.name : req.params.id });
  res.status(204).end();
}));

app.post("/api/devices/:id/reset-stats", requireRole("manager"), ah(async (req, res) => {
  const device = await store.getDevice(req.params.id);
  if (!device) return res.status(404).json({ error: "device not found" });
  const stats = await store.resetDeviceStats(req.params.id);
  audit(req, "stats_reset", { name: device.name });
  res.json(stats);
}));

// ---------- Widgets (view: any role, manage: manager+) ----------

app.get("/api/widgets", requireUserMw, ah(async (req, res) => {
  res.json(await store.listWidgets());
}));

app.post("/api/widgets", requireRole("manager"), ah(async (req, res) => {
  const { deviceId, metric } = req.body;
  if (!deviceId || !metric) {
    return res.status(400).json({ error: "deviceId and metric are required" });
  }
  const widget = { id: `w_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, deviceId, metric };
  await store.addWidget(widget);
  audit(req, "widget_add", { deviceId, metric });
  res.status(201).json(widget);
}));

app.delete("/api/widgets/:id", requireRole("manager"), ah(async (req, res) => {
  await store.removeWidget(req.params.id);
  audit(req, "widget_remove", { widgetId: req.params.id });
  res.status(204).end();
}));

// ---------- Products (Product Management) ----------

app.get("/api/products", requireUserMw, ah(async (req, res) => {
  res.json(await store.listProducts());
}));

app.post("/api/products", requireRole("manager"), ah(async (req, res) => {
  const { code, name, targetWeight, toleranceType, toleranceValue } = req.body;
  if (!code || !name || targetWeight === undefined || toleranceValue === undefined) {
    return res.status(400).json({ error: "code, name, targetWeight, and toleranceValue are required" });
  }
  const product = await store.addProduct(req.body);
  audit(req, "product_add", { code, name });
  res.status(201).json(product);
}));

app.put("/api/products/:id", requireRole("manager"), ah(async (req, res) => {
  const updated = await store.updateProduct(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: "product not found" });
  audit(req, "product_update", { code: updated.code, name: updated.name });
  res.json(updated);
}));

app.delete("/api/products/:id", requireRole("manager"), ah(async (req, res) => {
  const existing = await store.getProduct(req.params.id);
  await store.removeProduct(req.params.id);
  audit(req, "product_remove", { code: existing ? existing.code : req.params.id });
  res.status(204).end();
}));

// ---------- Maintenance management ----------

app.get("/api/maintenance", requireUserMw, ah(async (req, res) => {
  res.json(await store.listMaintenanceRecords(req.query.deviceId));
}));

app.get("/api/maintenance/due", requireUserMw, ah(async (req, res) => {
  res.json(await store.listMaintenanceDue(Number(req.query.withinDays) || 7));
}));

app.post("/api/maintenance", requireRole("manager"), ah(async (req, res) => {
  const { deviceId, status } = req.body;
  if (!deviceId) return res.status(400).json({ error: "deviceId is required" });
  const validStatuses = ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${validStatuses.join("/")}` });
  }
  const record = await store.addMaintenanceRecord(req.body);
  audit(req, "maintenance_add", { deviceId, workOrderNumber: record.workOrderNumber });
  res.status(201).json(record);
}));

app.put("/api/maintenance/:id", requireRole("manager"), ah(async (req, res) => {
  if (req.body.status) {
    const validStatuses = ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"];
    if (!validStatuses.includes(req.body.status)) {
      return res.status(400).json({ error: `status must be one of ${validStatuses.join("/")}` });
    }
  }
  const result = await store.updateMaintenanceRecord(req.params.id, req.body);
  if (!result) return res.status(404).json({ error: "maintenance record not found" });
  audit(req, "maintenance_update", {
    workOrderNumber: result.record.workOrderNumber,
    status: result.record.status,
    autoScheduledNext: !!result.nextRecord,
  });
  res.json(result);
}));

app.delete("/api/maintenance/:id", requireRole("manager"), ah(async (req, res) => {
  await store.removeMaintenanceRecord(req.params.id);
  audit(req, "maintenance_remove", { id: req.params.id });
  res.status(204).end();
}));

// --- Maintenance Schedules (preventive) ---
app.get("/api/maintenance-schedules", requireUserMw, ah(async (req, res) => {
  res.json(await store.listMaintenanceSchedules({ deviceId: req.query.deviceId, orgId: req.user.orgId }));
}));

app.post("/api/maintenance-schedules", requireRole("manager"), ah(async (req, res) => {
  const schedule = await store.createMaintenanceSchedule({ ...req.body, orgId: req.user.orgId });
  audit(req, "maintenance_schedule_create", { scheduleId: schedule.id });
  res.status(201).json(schedule);
}));

app.put("/api/maintenance-schedules/:id", requireRole("manager"), ah(async (req, res) => {
  await store.updateMaintenanceSchedule(req.params.id, req.body);
  audit(req, "maintenance_schedule_update", { scheduleId: req.params.id });
  res.json({ ok: true });
}));

app.delete("/api/maintenance-schedules/:id", requireRole("manager"), ah(async (req, res) => {
  await store.deleteMaintenanceSchedule(req.params.id);
  audit(req, "maintenance_schedule_delete", { scheduleId: req.params.id });
  res.json({ ok: true });
}));

app.post("/api/maintenance-schedules/generate", requireRole("manager"), ah(async (req, res) => {
  const generated = await store.generateMaintenanceFromSchedules();
  audit(req, "maintenance_schedules_generate", { count: generated.length });
  res.json({ generated: generated.length, records: generated });
}));

// --- Maintenance Failures ---
app.get("/api/maintenance-failures", requireUserMw, ah(async (req, res) => {
  res.json(await store.listMaintenanceFailures({ deviceId: req.query.deviceId }));
}));

app.post("/api/maintenance-failures", requireRole("manager"), ah(async (req, res) => {
  const failure = await store.addMaintenanceFailure(req.body);
  audit(req, "maintenance_failure_add", { failureId: failure.id, deviceId: failure.deviceId });
  res.status(201).json(failure);
}));

app.put("/api/maintenance-failures/:id/resolve", requireRole("manager"), ah(async (req, res) => {
  await store.resolveMaintenanceFailure(req.params.id, req.body.resolution);
  audit(req, "maintenance_failure_resolve", { failureId: req.params.id });
  res.json({ ok: true });
}));

// --- MTBF & Prediction ---
app.get("/api/devices/:id/mtbf", requireUserMw, ah(async (req, res) => {
  res.json(await store.calculateMTBF(req.params.id));
}));

app.get("/api/devices/:id/failure-prediction", requireUserMw, ah(async (req, res) => {
  res.json(await store.predictNextFailure(req.params.id));
}));

// --- Maintenance Cost Analytics ---
app.get("/api/maintenance-costs", requireUserMw, ah(async (req, res) => {
  res.json(await store.getMaintenanceCosts(req.query.deviceId, req.query.from, req.query.to));
}));

// ============================================================
// PHASE 6: Predictive Maintenance — Health Trends, RUL, Optimization
// ============================================================

// --- Health History ---
app.get("/api/devices/:id/health-history", requireUserMw, ah(async (req, res) => {
  res.json(await store.getHealthHistory(req.params.id, Number(req.query.days) || 30));
}));

app.post("/api/devices/:id/health-history", requireRole("manager"), ah(async (req, res) => {
  const id = await store.recordHealthScore(req.params.id, req.body);
  res.status(201).json({ id });
}));

app.post("/api/health-history/record-all", requireRole("manager"), ah(async (req, res) => {
  const recorded = await store.recordAllDeviceHealthScores();
  audit(req, "health_history_record_all", { count: recorded.length });
  res.json({ recorded: recorded.length, devices: recorded });
}));

// --- Health Trend Analysis ---
app.get("/api/devices/:id/health-trend", requireUserMw, ah(async (req, res) => {
  res.json(await store.analyzeHealthTrend(req.params.id, Number(req.query.days) || 30));
}));

// --- RUL Estimation ---
app.get("/api/devices/:id/rul", requireUserMw, ah(async (req, res) => {
  res.json(await store.estimateRUL(req.params.id, { failureThreshold: Number(req.query.threshold) || 50 }));
}));

// --- Maintenance Recommendations ---
app.get("/api/devices/:id/maintenance-recommendations", requireUserMw, ah(async (req, res) => {
  const recs = await store.generateMaintenanceRecommendations(req.params.id);
  res.json(recs);
}));

// --- Failure Mode Analysis ---
app.get("/api/devices/:id/failure-analysis", requireUserMw, ah(async (req, res) => {
  res.json(await store.analyzeFailureModes(req.params.id));
}));

// --- Cost Optimization Analysis ---
app.get("/api/devices/:id/cost-analysis", requireUserMw, ah(async (req, res) => {
  res.json(await store.analyzeMaintenanceCosts(req.params.id));
}));

// ============================================================
// PHASE 8: System Health & Monitoring
// ============================================================

app.get("/api/health", requireUserMw, ah(async (req, res) => {
  const memUsage = process.memoryUsage();
  const uptime = process.uptime();
  let dbStatus = "disconnected", poolTotal = 0, poolIdle = 0;
  try {
    const { rows } = await db.query("SELECT 1");
    dbStatus = "connected";
    const pool = db.pool;
    if (pool) { poolTotal = pool.totalCount; poolIdle = pool.idleCount; }
  } catch (e) { dbStatus = "error: " + e.message; }

  const deviceCount = (await store.listDevices()).length;
  const userCount = (await db.query("SELECT COUNT(*) as c FROM users")).rows[0]?.c || 0;
  const readingsToday = (await db.query("SELECT COUNT(*) as c FROM readings WHERE ts > now() - interval '1 day'")).rows[0]?.c || 0;
  const activeAlertsCount = store.listActiveAlerts().length;

  res.json({
    status: "ok",
    database: dbStatus,
    poolTotal,
    poolIdle,
    uptime,
    memoryUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
    memoryTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
    nodeVersion: process.version,
    deviceCount,
    userCount,
    readingsToday,
    activeAlerts: activeAlertsCount,
    timestamp: new Date().toISOString(),
  });
}));

app.get("/api/health/ping", (req, res) => {
  res.json({ pong: true, timestamp: Date.now() });
});

// ---------- Calibration management ----------

app.get("/api/calibrations", requireUserMw, ah(async (req, res) => {
  res.json(await store.listCalibrationRecords(req.query.deviceId));
}));

app.post("/api/calibrations", requireRole("manager"), ah(async (req, res) => {
  const { deviceId, referenceWeight, actualWeight } = req.body;
  if (!deviceId || referenceWeight === undefined || actualWeight === undefined) {
    return res.status(400).json({ error: "deviceId, referenceWeight, and actualWeight are required" });
  }
  const record = await store.addCalibrationRecord(req.body);
  audit(req, "calibration_add", { deviceId, passFail: record.passFail, certificateNumber: record.certificateNumber });
  res.status(201).json(record);
}));

app.delete("/api/calibrations/:id", requireRole("manager"), ah(async (req, res) => {
  await store.removeCalibrationRecord(req.params.id);
  audit(req, "calibration_remove", { id: req.params.id });
  res.status(204).end();
}));

// ---------- Configuration templates ----------

app.get("/api/templates", requireUserMw, ah(async (req, res) => {
  res.json(await store.listTemplates());
}));

app.post("/api/templates", requireRole("manager"), ah(async (req, res) => {
  const { name, protocol } = req.body;
  if (!name || !protocol) return res.status(400).json({ error: "name and protocol are required" });
  const template = await store.addTemplate(req.body);
  audit(req, "template_add", { name, protocol });
  res.status(201).json(template);
}));

app.delete("/api/templates/:id", requireRole("manager"), ah(async (req, res) => {
  const removed = await store.removeTemplate(req.params.id);
  if (!removed) return res.status(400).json({ error: "built-in templates can't be removed" });
  audit(req, "template_remove", { id: req.params.id });
  res.status(204).end();
}));

// ---------- Engineering / Maintenance mode ----------
// Restricted diagnostic + low-level configuration access. Read-only diagnostics
// (raw data, connection tests, comm logs, viewing config) require manager+.
// Anything that WRITES protocol/register configuration requires admin AND an
// explicit confirm:true in the request body — never available by a single click,
// and never on by default. There is currently no path from here to writing to
// the physical scale itself (drivers only implement read()); if that's added
// later, it must go through this same confirm-gated pattern, not around it.

app.get("/api/engineering/devices/:id/raw", requireRole("manager"), ah(async (req, res) => {
  const device = await store.getDevice(req.params.id);
  if (!device) return res.status(404).json({ error: "device not found" });
  const latest = store.getLatest(device.id);
  store.logComm(device.id, { success: !!latest, note: "raw data view" });
  res.json({
    deviceId: device.id,
    protocol: device.protocol,
    connectionConfig: device.connectionConfig,
    rawReading: latest,
    note: latest
      ? "This reflects the simulated driver's output. Once a real protocol driver is wired in, this will show the actual register/tag payload."
      : "No data received yet.",
  });
}));

app.post("/api/engineering/devices/:id/test-connection", requireRole("manager"), ah(async (req, res) => {
  const device = await store.getDevice(req.params.id);
  if (!device) return res.status(404).json({ error: "device not found" });
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 150 + Math.random() * 250));
  const latencyMs = Date.now() - start;
  const success = true;
  store.logComm(device.id, { success, latencyMs, note: "test connection" });
  audit(req, "engineering_test_connection", { deviceId: device.id, success });
  res.json({ success, latencyMs, protocol: device.protocol, ip: device.ip, message: success ? "Connection established" : "Connection failed" });
}));

app.post("/api/engineering/devices/:id/test-datapoint", requireRole("manager"), ah(async (req, res) => {
  const device = await store.getDevice(req.params.id);
  if (!device) return res.status(404).json({ error: "device not found" });
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 100 + Math.random() * 150));
  const latencyMs = Date.now() - start;
  const latest = store.getLatest(device.id);
  const rawValue = latest ? latest.weight : null;
  const success = rawValue !== null;
  const dataPoint = device.connectionConfig?.registerMap?.weight || null;
  store.logComm(device.id, { success, latencyMs, note: "test data point" });
  audit(req, "engineering_test_datapoint", { deviceId: device.id, success });
  res.json({
    success,
    latencyMs,
    dataPoint,
    rawValue,
    parsedValue: rawValue,
    unit: device.unit,
    message: success ? "Data point read successfully" : "No data available yet — is the gateway running?",
  });
}));

app.get("/api/engineering/devices/:id/comm-log", requireRole("manager"), ah(async (req, res) => {
  res.json(store.getCommLog(req.params.id, Number(req.query.limit) || 50));
}));

app.get("/api/engineering/devices/:id/protocol-config", requireRole("manager"), ah(async (req, res) => {
  const device = await store.getDevice(req.params.id);
  if (!device) return res.status(404).json({ error: "device not found" });
  res.json({ protocol: device.protocol, ip: device.ip, connectionConfig: device.connectionConfig });
}));

app.put("/api/engineering/devices/:id/protocol-config", requireRole("admin"), ah(async (req, res) => {
  const { confirm, protocol, ip, connectionConfig } = req.body;
  if (confirm !== true) {
    return res.status(400).json({ error: "this changes live protocol/register configuration — resend with confirm: true" });
  }
  const device = await store.getDevice(req.params.id);
  if (!device) return res.status(404).json({ error: "device not found" });
  const updated = await store.updateDevice(req.params.id, {
    ...(protocol !== undefined && { protocol }),
    ...(ip !== undefined && { ip }),
    ...(connectionConfig !== undefined && { connectionConfig }),
  });
  audit(req, "engineering_config_write", { deviceId: device.id, name: device.name, changes: Object.keys(req.body) });
  res.json(updated);
}));

// Stateless variants for the device-onboarding wizard: at wizard steps 3 and
// 5, the device doesn't exist yet (it's only created at "Activate", step 7),
// so there's nothing to look up by ID. Same simulated behavior, just keyed
// off whatever the wizard has gathered so far instead of a saved device.
app.post("/api/engineering/test-connection", requireRole("manager"), ah(async (req, res) => {
  const { ip, protocol, port } = req.body;
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 150 + Math.random() * 250));
  const latencyMs = Date.now() - start;
  const success = !!ip && !!protocol;
  res.json({ success, latencyMs, protocol, ip, port, message: success ? "Connection established" : "Missing IP or protocol" });
}));

app.post("/api/engineering/test-datapoint", requireRole("manager"), ah(async (req, res) => {
  const { registerMap, unit } = req.body;
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 100 + Math.random() * 150));
  const latencyMs = Date.now() - start;
  const simulatedValue = Math.round((Math.random() * 20 + 10) * 100) / 100;
  const success = !!(registerMap && registerMap.weight);
  res.json({
    success,
    latencyMs,
    dataPoint: registerMap ? registerMap.weight : null,
    rawValue: success ? simulatedValue : null,
    parsedValue: success ? simulatedValue : null,
    unit: unit || "kg",
    message: success ? "Data point read successfully (simulated)" : "No weight data point configured",
  });
}));

// ---------- Reports / exports (view: any role) ----------

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

app.get("/api/reports/give-away.csv", requireUserMw, ah(async (req, res) => {
  const { from, to } = req.query;
  const isRange = from && to;
  const rows = [["Device", "Protocol", "Target (kg)", "Bags", "Overfill (kg)", "Underfill (kg)", "Est. Cost", isRange ? "Period" : "Since"]];
  for (const device of await store.listDevices()) {
    const stats = isRange
      ? await store.getBagStatsInRange(device.id, from, to)
      : await store.getBagStats(device.id);
    rows.push([
      device.name, device.protocol, device.target, stats.totalBags,
      stats.totalOverKg.toFixed(3), stats.totalUnderKg.toFixed(3), stats.totalCost.toFixed(2), stats.since,
    ]);
  }
  audit(req, "report_export", { report: "give-away", from: from || null, to: to || null });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="give-away-report-${Date.now()}.csv"`);
  res.send(toCsv(rows));
}));

app.get("/api/reports/alerts.csv", requireUserMw, ah(async (req, res) => {
  const { from, to } = req.query;
  const isRange = from && to;
  const rows = [["Device", "Type", "Severity", "Message", "Since", "Resolved At", "Status"]];
  const history = isRange
    ? await store.listAlertHistoryInRange(from, to)
    : await store.listAlertHistory(500);
  for (const a of history) {
    rows.push([a.deviceName, a.type, a.severity, a.message, a.since, a.resolvedAt || "", a.active ? "active" : "resolved"]);
  }
  audit(req, "report_export", { report: "alerts", from: from || null, to: to || null });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="alert-history-${Date.now()}.csv"`);
  res.send(toCsv(rows));
}));

// --- PDF reports ---

function drawPdfTable(doc, { columns, rows, totalsRow, pageMargin = 40 }, accentColor) {
  const tableWidth = columns.reduce((sum, c) => sum + c.width, 0);
  const startX = doc.page.margins.left;
  let y = doc.y;
  const rowHeight = 20;

  function drawHeaderRow() {
    doc.rect(startX, y, tableWidth, rowHeight).fill(accentColor || "#F2B705");
    doc.fillColor("#14181D").font("Helvetica-Bold").fontSize(9);
    let x = startX;
    columns.forEach((c) => {
      doc.text(c.label, x + 5, y + 6, { width: c.width - 8, ellipsis: true });
      x += c.width;
    });
    doc.font("Helvetica").fillColor("#222222");
    y += rowHeight;
  }

  drawHeaderRow();

  rows.forEach((row, idx) => {
    if (y + rowHeight > doc.page.height - pageMargin) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeaderRow();
    }
    if (idx % 2 === 1) {
      doc.rect(startX, y, tableWidth, rowHeight).fill("#F4F4F4");
      doc.fillColor("#222222");
    }
    let x = startX;
    doc.fontSize(8.5);
    row.forEach((val, i) => {
      doc.text(String(val), x + 5, y + 6, { width: columns[i].width - 8, ellipsis: true });
      x += columns[i].width;
    });
    y += rowHeight;
  });

  if (totalsRow) {
    doc.moveTo(startX, y).lineTo(startX + tableWidth, y).strokeColor("#999999").stroke();
    y += 4;
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#111111");
    let x = startX;
    totalsRow.forEach((val, i) => {
      doc.text(String(val), x + 5, y + 4, { width: columns[i].width - 8 });
      x += columns[i].width;
    });
    doc.font("Helvetica");
  }
}

function streamPdfReport(res, branding, filename, title, generatedBy) {
  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  doc.pipe(res);

  doc.fillColor(branding.accentColor || "#F2B705").font("Helvetica-Bold").fontSize(9)
    .text((branding.companyName || "Scale Ops").toUpperCase(), { characterSpacing: 1 });
  doc.fillColor("#111111").font("Helvetica-Bold").fontSize(18).text(title, { paragraphGap: 2 });
  doc.fillColor("#666666").font("Helvetica").fontSize(9).text(generatedBy);
  doc.moveDown(1.2);

  return doc;
}

app.get("/api/reports/give-away.pdf", requireUserMw, ah(async (req, res) => {
  const { from, to } = req.query;
  const isRange = from && to;
  const columns = [
    { label: "Device", width: 110 }, { label: "Protocol", width: 80 }, { label: "Target", width: 45 },
    { label: "Bags", width: 40 }, { label: "Over (kg)", width: 60 }, { label: "Under (kg)", width: 65 }, { label: "Est. Cost", width: 65 },
  ];
  let totalBags = 0, totalOver = 0, totalUnder = 0, totalCost = 0;
  const devices = await store.listDevices();
  const rows = [];
  for (const device of devices) {
    const s = isRange
      ? await store.getBagStatsInRange(device.id, from, to)
      : await store.getBagStats(device.id);
    totalBags += s.totalBags; totalOver += s.totalOverKg; totalUnder += s.totalUnderKg; totalCost += s.totalCost;
    rows.push([device.name, device.protocol, device.target, s.totalBags, s.totalOverKg.toFixed(2), s.totalUnderKg.toFixed(2), s.totalCost.toFixed(2)]);
  }
  const branding = await store.getBranding();
  const periodText = isRange
    ? `${new Date(from).toLocaleDateString()} – ${new Date(to).toLocaleDateString()}`
    : "cumulative since each device's last reset";
  const doc = streamPdfReport(
    res, branding, `give-away-report-${Date.now()}.pdf`, "Give-Away / Loss Report",
    `Generated ${new Date().toLocaleString()} by ${req.user.username} · ${periodText}`
  );
  drawPdfTable(doc, { columns, rows, totalsRow: ["TOTAL", "", "", totalBags, totalOver.toFixed(2), totalUnder.toFixed(2), totalCost.toFixed(2)] }, branding.accentColor);
  audit(req, "report_export", { report: "give-away-pdf", from: from || null, to: to || null });
  doc.end();
}));

app.get("/api/reports/alerts.pdf", requireUserMw, ah(async (req, res) => {
  const { from, to } = req.query;
  const isRange = from && to;
  const columns = [
    { label: "Device", width: 85 }, { label: "Type", width: 75 }, { label: "Severity", width: 50 },
    { label: "Message", width: 155 }, { label: "Since", width: 88 }, { label: "Status", width: 52 },
  ];
  const history = isRange
    ? await store.listAlertHistoryInRange(from, to)
    : await store.listAlertHistory(500);
  const rows = history.map((a) => [a.deviceName, a.type, a.severity, a.message, new Date(a.since).toLocaleString(), a.active ? "active" : "resolved"]);
  const branding = await store.getBranding();
  const periodText = isRange
    ? `${new Date(from).toLocaleDateString()} – ${new Date(to).toLocaleDateString()}`
    : "all time";
  const doc = streamPdfReport(res, branding, `alert-history-${Date.now()}.pdf`, "Alert History",
    `Generated ${new Date().toLocaleString()} by ${req.user.username} · ${periodText}`);
  drawPdfTable(doc, { columns, rows }, branding.accentColor);
  audit(req, "report_export", { report: "alerts-pdf", from: from || null, to: to || null });
  doc.end();
}));

app.get("/api/devices/:id/bag-stats", requireUserMw, ah(async (req, res) => {
  res.json(await store.getBagStats(req.params.id));
}));

// OEE endpoint
app.get("/api/devices/:id/oee", requireUserMw, ah(async (req, res) => {
  const { from, to } = req.query;
  const deviceId = req.params.id;
  const device = (await store.listDevices()).find(d => d.id === deviceId);
  if (!device) return res.status(404).json({ error: "device not found" });

  // Time range
  const fromDate = from ? new Date(from) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const toDate = to ? new Date(to) : new Date();
  const plannedSeconds = (toDate.getTime() - fromDate.getTime()) / 1000;

  // Downtime from logs + production events
  const downtimeLogs = await store.listDowntimeLogs({ deviceId, from: fromDate.toISOString(), to: toDate.toISOString() });
  const downtimeSeconds = downtimeLogs.reduce((sum, log) => {
    const end = log.endedAt ? new Date(log.endedAt).getTime() : Date.now();
    return sum + (end - new Date(log.startedAt).getTime()) / 1000;
  }, 0);

  // Also include production events downtime
  const prodEvents = await store.listProductionEvents({ deviceId });
  const eventDowntime = prodEvents.filter(e => ["downtime", "changeover", "breakdown", "maintenance"].includes(e.eventType) && e.startTime && e.endTime).reduce((sum, e) => {
    return sum + (new Date(e.endTime).getTime() - new Date(e.startTime).getTime()) / 1000;
  }, 0);
  const totalDowntime = downtimeSeconds + eventDowntime;

  // Operating time
  const operatingSeconds = Math.max(plannedSeconds - totalDowntime, 0);

  // Use production order data if available, else fall back to readings/bag stats
  const activeOrders = (await store.listProductionOrders({ deviceId })).filter(o => ["in_progress", "completed"].includes(o.status));
  const hasOrders = activeOrders.length > 0;

  let totalUnits, goodUnits, rejectUnits;
  if (hasOrders) {
    totalUnits = activeOrders.reduce((s, o) => s + (o.actualQuantity || 0), 0);
    goodUnits = activeOrders.reduce((s, o) => s + (o.goodQuantity || 0), 0);
    rejectUnits = activeOrders.reduce((s, o) => s + (o.rejectQuantity || 0), 0);
  } else {
    // Fallback to readings-based stats
    const stats = await store.getBagStats(deviceId);
    totalUnits = stats.totalBags || 0;
    goodUnits = stats.countPass || 0;
    rejectUnits = (stats.countOver || 0) + (stats.countUnder || 0);
  }

  // OEE calculation
  const availability = plannedSeconds > 0 ? ((plannedSeconds - totalDowntime) / plannedSeconds) * 100 : 0;
  const idealCycleMs = device.pollingMs || 500;
  const theoreticalUnits = operatingSeconds * 1000 / idealCycleMs;
  const performance = theoreticalUnits > 0 ? Math.min((totalUnits / theoreticalUnits) * 100, 100) : 0;
  const quality = totalUnits > 0 ? (goodUnits / totalUnits) * 100 : 0;
  const oee = (availability * performance * quality) / 10000;

  res.json({
    deviceId, deviceName: device.name, hasOrders,
    from: fromDate.toISOString(), to: toDate.toISOString(),
    plannedSeconds, operatingSeconds, downtimeSeconds: totalDowntime,
    totalUnits, goodUnits, rejectUnits,
    totalBags: totalUnits, goodBags: goodUnits, overBags: rejectUnits, underBags: 0,
    availability: Math.round(availability * 10) / 10,
    performance: Math.round(performance * 10) / 10,
    quality: Math.round(quality * 10) / 10,
    oee: Math.round(oee * 10) / 10,
  });
}));

app.get("/api/devices/:id/readings", requireUserMw, ah(async (req, res) => {
  const limit = Number(req.query.limit) || 50;
  res.json(store.getReadings(req.params.id, limit));
}));

// Durable historical query — this is the report the JSON-file version could
// never really offer ("since last reset" was the workaround). Now backed by
// the `readings` table, so any date range works, not just "recent".
app.get("/api/devices/:id/readings-range", requireUserMw, ah(async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: "from and to query params (ISO dates) are required" });
  res.json(await store.getReadingsInRange(req.params.id, from, to));
}));

// ---------- Readings ----------

async function dispatchWebhook(event, alert) {
  const { webhookUrl } = await store.getAlertConfig();
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, alert }),
    });
  } catch (err) {
    console.error(`[alerts] webhook delivery failed: ${err.message}`);
  }
}

async function fireAlert(action, deviceId, deviceName, type, message, severity) {
  const alert =
    action === "trigger"
      ? await store.triggerAlert(deviceId, deviceName, type, message, severity)
      : await store.resolveAlert(deviceId, type);
  if (!alert) return;
  broadcast({ type: "alert", action, alert });
  dispatchWebhook(action === "trigger" ? "alert.triggered" : "alert.resolved", alert);

  // Downtime logging + notifications
  if (type === "no_data") {
    if (action === "trigger") {
      await store.logDowntimeStart(deviceId, deviceName);
    } else {
      await store.logDowntimeEnd(deviceId);
    }
    const nCfg = await store.getNotificationConfig();
    if (nCfg.downtimeNotifyEnabled) {
      if (action === "trigger") {
        await notify.sendDowntimeAlert(nCfg, deviceName, Math.round((Date.now() - (alert.since ? new Date(alert.since).getTime() : Date.now())) / 1000));
      } else {
        await notify.sendDowntimeResolved(nCfg, deviceName);
      }
    }
  }
}

// ---------- Downtime logs ----------

app.get("/api/downtime-logs", requireRole("manager"), ah(async (req, res) => {
  const { deviceId, from, to, limit } = req.query;
  res.json(await store.listDowntimeLogs({ deviceId, from, to, limit: limit ? Number(limit) : 200 }));
}));

app.get("/api/downtime-logs/stats", requireRole("manager"), ah(async (req, res) => {
  const { deviceId } = req.query;
  res.json(await store.getDowntimeStats(deviceId));
}));

app.put("/api/downtime-logs/:id/reason", requireUserMw, ah(async (req, res) => {
  const { reasonCode, reasonNote } = req.body;
  const updated = await store.updateDowntimeReason(req.params.id, reasonCode, reasonNote, req.user.username);
  if (!updated) return res.status(404).json({ error: "downtime log not found" });
  audit(req, "downtime_reason_update", { id: req.params.id, reasonCode, reasonNote });
  res.json(updated);
}));

// ---------- Scheduled Reports ----------
app.get("/api/scheduled-reports", requireRole("manager"), ah(async (req, res) => {
  res.json(await store.listScheduledReports());
}));

app.post("/api/scheduled-reports", requireRole("manager"), ah(async (req, res) => {
  const { name, reportType, format, recipients, scheduleCron } = req.body;
  if (!name || !reportType || !recipients || !scheduleCron) return res.status(400).json({ error: "name, reportType, recipients, scheduleCron required" });
  const report = await store.addScheduledReport({ name, reportType, format: format || "pdf", recipients, scheduleCron });
  audit(req, "scheduled_report_create", { id: report.id });
  res.status(201).json(report);
}));

app.delete("/api/scheduled-reports/:id", requireRole("manager"), ah(async (req, res) => {
  await store.removeScheduledReport(req.params.id);
  audit(req, "scheduled_report_delete", { id: req.params.id });
  res.status(204).end();
}));

app.post("/api/scheduled-reports/:id/run", requireRole("manager"), ah(async (req, res) => {
  const reports = await store.listScheduledReports();
  const report = reports.find(r => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: "not found" });
  await runScheduledReport(report);
  res.json({ ok: true });
}));

async function runScheduledReport(report) {
  try {
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const devicesList = await store.listDevices();
    const nCfg = await store.getNotificationConfig();
    if (!nCfg.emailEnabled || !nCfg.smtpUser) return;

    let subject, html;
    if (report.reportType === "give-away") {
      subject = `Daily Give-Away Report — ${new Date().toLocaleDateString()}`;
      let rows = "";
      let totalOver = 0, totalUnder = 0, totalCost = 0;
      for (const d of devicesList) {
        const stats = await store.getBagStatsInRange(d.id, from, to);
        if (stats.totalBags > 0) {
          totalOver += Number(stats.totalOverKg);
          totalUnder += Number(stats.totalUnderKg);
          totalCost += Number(stats.totalCost);
          rows += `<tr><td>${d.name}</td><td>${stats.totalBags}</td><td>${Number(stats.totalOverKg).toFixed(2)} kg</td><td>${Number(stats.totalUnderKg).toFixed(2)} kg</td><td>R ${Number(stats.totalCost).toFixed(2)}</td></tr>`;
        }
      }
      html = `<div style="font-family:sans-serif;padding:20px;"><h2>Daily Give-Away Report</h2><p>Period: ${new Date(from).toLocaleDateString()} — ${new Date(to).toLocaleDateString()}</p><table border="1" cellpadding="8" style="border-collapse:collapse;width:100%;"><thead><tr><th>Device</th><th>Bags</th><th>Overfill</th><th>Underfill</th><th>Cost</th></tr></thead><tbody>${rows || "<tr><td colspan='5'>No data</td></tr>"}</tbody></table><p style="margin-top:16px;"><strong>Total Overfill:</strong> ${totalOver.toFixed(2)} kg · <strong>Total Cost:</strong> R ${totalCost.toFixed(2)}</p></div>`;
    } else if (report.reportType === "alerts") {
      subject = `Daily Alert Report — ${new Date().toLocaleDateString()}`;
      const alertData = await store.listAlertHistoryInRange(from, to);
      let rows = "";
      for (const a of alertData) {
        rows += `<tr><td>${a.deviceName || a.deviceId}</td><td>${a.type}</td><td>${a.severity}</td><td>${a.active ? "Active" : "Resolved"}</td></tr>`;
      }
      html = `<div style="font-family:sans-serif;padding:20px;"><h2>Daily Alert Report</h2><p>Period: ${new Date(from).toLocaleDateString()} — ${new Date(to).toLocaleDateString()}</p><table border="1" cellpadding="8" style="border-collapse:collapse;width:100%;"><thead><tr><th>Device</th><th>Type</th><th>Severity</th><th>Status</th></tr></thead><tbody>${rows || "<tr><td colspan='4'>No alerts</td></tr>"}</tbody></table></div>`;
    } else {
      return;
    }

    await notify.sendEmail(report.recipients, subject, html);
    await store.markReportSent(report.id);
    console.log(`[reports] Scheduled report "${report.name}" sent to ${report.recipients}`);
  } catch (e) {
    console.error(`[reports] Failed to send "${report.name}":`, e.message);
  }
}

// ---------- Device Groups ----------
app.get("/api/device-groups", requireUserMw, ah(async (req, res) => {
  res.json(await store.listDeviceGroups());
}));

app.post("/api/device-groups", requireRole("manager"), ah(async (req, res) => {
  const { name, parentId, color } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const group = await store.addDeviceGroup(name, parentId, color);
  audit(req, "device_group_create", { id: group.id });
  res.status(201).json(group);
}));

app.delete("/api/device-groups/:id", requireRole("manager"), ah(async (req, res) => {
  await store.removeDeviceGroup(req.params.id);
  audit(req, "device_group_delete", { id: req.params.id });
  res.status(204).end();
}));

app.put("/api/devices/:id/group", requireRole("manager"), ah(async (req, res) => {
  const { groupId } = req.body;
  await store.assignDeviceToGroup(req.params.id, groupId || null);
  audit(req, "device_group_assign", { deviceId: req.params.id, groupId });
  res.json({ ok: true });
}));

// ---------- Alert Workflows ----------
app.post("/api/alerts/:id/snooze", requireUserMw, ah(async (req, res) => {
  const { minutes } = req.body;
  if (!minutes || minutes < 1) return res.status(400).json({ error: "minutes required" });
  const snoozeUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  await store.snoozeAlert(req.params.id, snoozeUntil);
  audit(req, "alert_snooze", { id: req.params.id, minutes, until: snoozeUntil });
  res.json({ ok: true, snoozeUntil });
}));

app.post("/api/alerts/:id/acknowledge", requireUserMw, ah(async (req, res) => {
  await store.acknowledgeAlert(req.params.id, req.user.username);
  audit(req, "alert_acknowledge", { id: req.params.id });
  res.json({ ok: true });
}));

// ---------- Production Schedules ----------
app.get("/api/production-schedules", requireUserMw, ah(async (req, res) => {
  const { deviceId, from, to } = req.query;
  res.json(await store.listProductionSchedules({ deviceId, from, to }));
}));

app.post("/api/production-schedules", requireRole("manager"), ah(async (req, res) => {
  const { deviceId, productId, shiftName, shiftDate, plannedBags, plannedStart, plannedEnd, notes } = req.body;
  if (!deviceId || !shiftName || !shiftDate) return res.status(400).json({ error: "deviceId, shiftName, shiftDate required" });
  const sched = await store.addProductionSchedule({ deviceId, productId, shiftName, shiftDate, plannedBags, plannedStart, plannedEnd, notes });
  audit(req, "production_schedule_create", { id: sched.id });
  res.status(201).json(sched);
}));

app.put("/api/production-schedules/:id", requireRole("manager"), ah(async (req, res) => {
  const updates = {};
  for (const k of ["plannedBags", "actualBags", "status", "notes", "actualStart", "actualEnd"]) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  const sched = await store.updateProductionSchedule(req.params.id, updates);
  if (!sched) return res.status(404).json({ error: "not found" });
  audit(req, "production_schedule_update", { id: req.params.id, ...updates });
  res.json(sched);
}));

app.delete("/api/production-schedules/:id", requireRole("manager"), ah(async (req, res) => {
  await store.removeProductionSchedule(req.params.id);
  audit(req, "production_schedule_delete", { id: req.params.id });
  res.status(204).end();
}));

// ---------- Firmware OTA ----------
app.post("/api/devices/:id/firmware-update", requireRole("admin"), ah(async (req, res) => {
  const { version, url } = req.body;
  if (!version) return res.status(400).json({ error: "version required" });
  const devicesList = await store.listDevices();
  const device = devicesList.find(d => d.id === req.params.id);
  if (!device) return res.status(404).json({ error: "device not found" });
  const log = await store.logFirmwareUpdate(req.params.id, device.firmwareVersion || "1.0.0", version);
  await store.updateDeviceFirmware(req.params.id, null, url);
  audit(req, "firmware_update_start", { deviceId: req.params.id, from: device.firmwareVersion, to: version });
  // In production, this would trigger the gateway to push firmware to the device
  res.json({ ok: true, logId: log.id, message: `Firmware update queued: ${device.firmwareVersion || "1.0.0"} → ${version}` });
}));

app.get("/api/devices/:id/firmware-history", requireUserMw, ah(async (req, res) => {
  res.json(await store.listFirmwareUpdates(req.params.id));
}));

app.get("/api/firmware-history", requireRole("manager"), ah(async (req, res) => {
  res.json(await store.listFirmwareUpdates());
}));

// ---------- GDPR ----------
app.get("/api/gdpr/my-data", requireUserMw, ah(async (req, res) => {
  const data = await store.exportUserData(req.user.id);
  audit(req, "gdpr_data_export", { userId: req.user.id });
  res.json(data);
}));

app.post("/api/gdpr/consent", requireUserMw, ah(async (req, res) => {
  const { action, detail } = req.body;
  await store.logConsent(req.user.id, action, detail, req.ip);
  res.json({ ok: true });
}));

app.get("/api/gdpr/consent-log", requireUserMw, ah(async (req, res) => {
  res.json(await store.getConsentLog(req.user.id));
}));

app.post("/api/gdpr/anonymize/:id", requireRole("admin"), ah(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "Cannot anonymize yourself" });
  await store.anonymizeUser(req.params.id);
  audit(req, "gdpr_anonymize", { userId: req.params.id });
  res.json({ ok: true });
}));

app.delete("/api/gdpr/delete-user/:id", requireRole("admin"), ah(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "Cannot delete yourself" });
  const adminCount = await store.countAdmins();
  const user = await store.findUserById(req.params.id);
  if (user?.role === "admin" && adminCount <= 1) return res.status(400).json({ error: "Cannot delete last admin" });
  await store.deleteUser(req.params.id);
  audit(req, "gdpr_user_delete", { userId: req.params.id });
  res.status(204).end();
}));

// ---------- SSO / SAML ----------
app.get("/api/sso/providers", requireRole("admin"), ah(async (req, res) => {
  res.json(await store.listSSOProviders());
}));

app.post("/api/sso/providers", requireRole("admin"), ah(async (req, res) => {
  const { name, type, issuerUrl, clientId, clientSecret, redirectUrl, enabled, defaultRole } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const provider = await store.createSSOProvider({ name, type, issuerUrl, clientId, clientSecret, redirectUrl, enabled, defaultRole });
  audit(req, "sso_provider_create", { name });
  res.json(provider);
}));

app.put("/api/sso/providers/:id", requireRole("admin"), ah(async (req, res) => {
  await store.updateSSOProvider(req.params.id, req.body);
  audit(req, "sso_provider_update", { id: req.params.id });
  res.json({ ok: true });
}));

app.delete("/api/sso/providers/:id", requireRole("admin"), ah(async (req, res) => {
  await store.deleteSSOProvider(req.params.id);
  audit(req, "sso_provider_delete", { id: req.params.id });
  res.status(204).end();
}));

app.post("/api/sso/login", ah(async (req, res) => {
  const { provider: providerName, token, email, name: ssoName, role: ssoRole } = req.body;
  if (!providerName) return res.status(400).json({ error: "provider required" });
  const provider = await store.findSSOProviderByName(providerName);
  if (!provider) return res.status(401).json({ error: "SSO provider not found or disabled" });

  // In production: validate token against provider's OIDC/SAML endpoint
  // For now: accept the token as-is and map email to a user
  const ssoEmail = email || `sso_${providerName}@sso.local`;
  let user = await store.findUserByUsername(ssoEmail);
  if (!user) {
    user = await store.createUser(ssoEmail, Math.random().toString(36).slice(2, 14), ssoRole || provider.defaultRole || "viewer");
  }

  const sessionToken = auth.createSessionToken(user);
  await store.logConsent(user.id, "sso_login", `SSO login via ${providerName}`, req.ip);
  audit(req, "sso_login", { userId: user.id, provider: providerName });
  res.json({ token: sessionToken, user: { id: user.id, username: user.username, role: user.role } });
}));

// ---------- Device Permissions ----------
app.get("/api/device-permissions", requireRole("admin"), ah(async (req, res) => {
  const { userId } = req.query;
  if (userId) {
    res.json(await store.listDevicePermissions(userId));
  } else {
    res.json(await store.listAllDevicePermissions());
  }
}));

app.post("/api/device-permissions", requireRole("admin"), ah(async (req, res) => {
  const { userId, deviceId, permission } = req.body;
  if (!userId || !deviceId) return res.status(400).json({ error: "userId and deviceId required" });
  const result = await store.grantDevicePermission(userId, deviceId, permission, req.user.id);
  audit(req, "device_permission_grant", { userId, deviceId, permission });
  res.json(result);
}));

app.delete("/api/device-permissions/:id", requireRole("admin"), ah(async (req, res) => {
  await store.revokeDevicePermission(req.params.id);
  audit(req, "device_permission_revoke", { id: req.params.id });
  res.status(204).end();
}));

app.delete("/api/device-permissions/user/:userId", requireRole("admin"), ah(async (req, res) => {
  await store.revokeDevicePermissionsByUser(req.params.userId);
  audit(req, "device_permission_revoke_all", { userId: req.params.userId });
  res.status(204).end();
}));

// ---------- Device Health Scores ----------
app.get("/api/device-health", requireRole("operator"), ah(async (req, res) => {
  res.json(await store.getDeviceHealthScores());
}));

// ---------- Supported Protocols ----------
app.get("/api/protocols", requireUserMw, ah(async (req, res) => {
  let protocols;
  try { protocols = require("../gateway/drivers").getSupportedProtocols(); } catch (e) { protocols = ["Simulator"]; }
  const details = {
    "Simulator": { label: "Simulator", category: "Test", description: "Virtual scale for testing" },
    "Modbus TCP": { label: "Modbus TCP", category: "Industrial", description: "Mettler Toledo, A&D, Fairbanks, Rice Lake" },
    "Modbus RTU": { label: "Modbus RTU (Serial)", category: "Industrial", description: "RS485/RS232 Modbus scales" },
    "OPC-UA": { label: "OPC-UA", category: "Industrial", description: "Siemens, Rockwell, ABB, Schneider" },
    MQTT: { label: "MQTT", category: "IoT", description: "AWS IoT, Azure, Mosquitto, HiveMQ" },
    "EtherNet/IP": { label: "EtherNet/IP", category: "Industrial", description: "Allen-Bradley / Rockwell PLCs" },
    PROFINET: { label: "PROFINET / S7", category: "Industrial", description: "Siemens S7-300/400/1200/1500" },
    SNMP: { label: "SNMP", category: "Network", description: "Network scales, printers, managed devices" },
    "REST API": { label: "REST / HTTP API", category: "Cloud", description: "Cloud scales, smart sensors, vendor APIs" },
    "TCP Socket": { label: "TCP Socket", category: "Legacy", description: "Raw TCP data from scales and scanners" },
    Serial: { label: "Serial / RS232 / RS485", category: "Legacy", description: "Legacy weigh terminals, barcode scanners" },
  };
  res.json(protocols.map(p => ({ id: p, ...(details[p] || { label: p, category: "Other", description: "" }) })));
}));

// ---------- Batch / Lot Tracking ----------
app.get("/api/batches", requireRole("operator"), ah(async (req, res) => {
  res.json(await store.listBatches(req.query.status));
}));

app.post("/api/batches", requireRole("manager"), ah(async (req, res) => {
  const { name, customer, productId, deviceId, targetBags, notes } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const batch = await store.createBatch({ name, customer, productId, deviceId, targetBags, notes });
  audit(req, "batch_create", { batchId: batch.id, name });
  res.json(batch);
}));

app.put("/api/batches/:id", requireRole("operator"), ah(async (req, res) => {
  await store.updateBatch(req.params.id, req.body);
  audit(req, "batch_update", { batchId: req.params.id, ...req.body });
  res.json({ ok: true });
}));

app.delete("/api/batches/:id", requireRole("manager"), ah(async (req, res) => {
  await store.deleteBatch(req.params.id);
  audit(req, "batch_delete", { batchId: req.params.id });
  res.status(204).end();
}));

app.get("/api/batches/:id/readings", requireRole("operator"), ah(async (req, res) => {
  res.json(await store.getBatchReadings(req.params.id));
}));

// ---------- AI Insights ----------
app.get("/api/ai-insights", requireRole("operator"), ah(async (req, res) => {
  res.json(await store.listAIInsights(req.query.deviceId, req.query.type));
}));

app.post("/api/ai-insights/analyze", requireRole("manager"), ah(async (req, res) => {
  const insights = await store.runAIAnalysis();
  audit(req, "ai_analysis_run", { newInsights: insights.length });
  res.json({ ok: true, newInsights: insights.length, insights });
}));

app.put("/api/ai-insights/:id/acknowledge", requireRole("operator"), ah(async (req, res) => {
  await store.acknowledgeInsight(req.params.id);
  audit(req, "ai_insight_acknowledge", { id: req.params.id });
  res.json({ ok: true });
}));

// ============================================================
// PHASE 5: Machine Learning Pipeline — Models, Anomaly, Drift, Forecast
// ============================================================

// --- ML Model Management ---
app.get("/api/ml-models", requireUserMw, ah(async (req, res) => {
  res.json(await store.listMLModels({ deviceId: req.query.deviceId, modelType: req.query.modelType, orgId: req.user.orgId }));
}));

app.get("/api/ml-models/:id", requireUserMw, ah(async (req, res) => {
  const model = await store.getMLModel(req.params.id);
  if (!model) return res.status(404).json({ error: "model not found" });
  res.json(model);
}));

app.post("/api/ml-models", requireRole("manager"), ah(async (req, res) => {
  const model = await store.createMLModel({ ...req.body, orgId: req.user.orgId });
  audit(req, "ml_model_create", { modelId: model.id });
  res.status(201).json(model);
}));

app.delete("/api/ml-models/:id", requireRole("manager"), ah(async (req, res) => {
  await store.deleteMLModel(req.params.id);
  audit(req, "ml_model_delete", { modelId: req.params.id });
  res.json({ ok: true });
}));

app.post("/api/ml-models/:id/train", requireRole("manager"), ah(async (req, res) => {
  const result = await store.trainMLModel(req.params.id);
  if (result?.error) return res.status(400).json(result);
  audit(req, "ml_model_train", { modelId: req.params.id });
  res.json(result);
}));

app.post("/api/ml-models/:id/predict", requireRole("manager"), ah(async (req, res) => {
  const { horizonHours } = req.body;
  const prediction = await store.generateMLPrediction(req.params.id, horizonHours);
  if (prediction?.error) return res.status(400).json(prediction);
  audit(req, "ml_model_predict", { modelId: req.params.id });
  res.json(prediction);
}));

// --- ML Predictions ---
app.get("/api/ml-predictions", requireUserMw, ah(async (req, res) => {
  res.json(await store.listMLPredictions({ modelId: req.query.modelId, deviceId: req.query.deviceId }));
}));

// --- Anomaly Detection ---
app.get("/api/devices/:id/anomalies", requireUserMw, ah(async (req, res) => {
  const { metric, threshold, minSamples } = req.query;
  if (!metric) return res.status(400).json({ error: "metric query param required" });
  res.json(await store.detectAnomalies(req.params.id, metric, { threshold: Number(threshold) || 3, minSamples: Number(minSamples) || 20 }));
}));

// --- Drift Detection ---
app.get("/api/devices/:id/drift", requireUserMw, ah(async (req, res) => {
  const { metric, cusumThreshold, ewmaAlpha, windowSize } = req.query;
  if (!metric) return res.status(400).json({ error: "metric query param required" });
  res.json(await store.detectDrift(req.params.id, metric, { cusumThreshold: Number(cusumThreshold) || 5, ewmaAlpha: Number(ewmaAlpha) || 0.2, windowSize: Number(windowSize) || 50 }));
}));

// --- Time-Series Forecasting ---
app.get("/api/devices/:id/forecast", requireUserMw, ah(async (req, res) => {
  const { metric, horizonHours, windowSize } = req.query;
  if (!metric) return res.status(400).json({ error: "metric query param required" });
  res.json(await store.forecastMetric(req.params.id, metric, { horizonHours: Number(horizonHours) || 24, windowSize: Number(windowSize) || 100 }));
}));

// ---------- Organizations (Multi-Tenancy) ----------
app.get("/api/organizations", requireRole("admin"), ah(async (req, res) => {
  res.json(await store.listOrganizations());
}));

app.post("/api/organizations", requireRole("admin"), ah(async (req, res) => {
  const { name, plan, maxDevices, maxUsers, settings } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const org = await store.createOrganization({ name, plan, maxDevices, maxUsers, settings });
  audit(req, "org_create", { orgId: org.id, name });
  res.json(org);
}));

app.put("/api/organizations/:id", requireRole("admin"), ah(async (req, res) => {
  await store.updateOrganization(req.params.id, req.body);
  audit(req, "org_update", { orgId: req.params.id, ...req.body });
  res.json({ ok: true });
}));

app.delete("/api/organizations/:id", requireRole("admin"), ah(async (req, res) => {
  await store.deleteOrganization(req.params.id);
  audit(req, "org_delete", { orgId: req.params.id });
  res.status(204).end();
}));

app.get("/api/organizations/:id/users", requireRole("admin"), ah(async (req, res) => {
  res.json(await store.getOrgUsers(req.params.id));
}));

app.get("/api/organizations/:id/devices", requireRole("admin"), ah(async (req, res) => {
  res.json(await store.getOrgDevices(req.params.id));
}));

app.post("/api/organizations/:orgId/assign-user", requireRole("admin"), ah(async (req, res) => {
  await store.assignUserToOrg(req.body.userId, req.params.orgId);
  audit(req, "org_assign_user", { orgId: req.params.orgId, userId: req.body.userId });
  res.json({ ok: true });
}));

app.post("/api/organizations/:orgId/assign-device", requireRole("admin"), ah(async (req, res) => {
  await store.assignDeviceToOrg(req.body.deviceId, req.params.orgId);
  audit(req, "org_assign_device", { orgId: req.params.orgId, deviceId: req.body.deviceId });
  res.json({ ok: true });
}));

// ---------- Report Templates ----------
app.get("/api/report-templates", requireRole("operator"), ah(async (req, res) => {
  res.json(await store.listReportTemplates());
}));

app.post("/api/report-templates", requireRole("manager"), ah(async (req, res) => {
  const { name, type, config } = req.body;
  if (!name || !type) return res.status(400).json({ error: "name and type required" });
  const template = await store.createReportTemplate({ name, type, config, createdBy: req.user.id });
  audit(req, "report_template_create", { id: template.id, name });
  res.json(template);
}));

app.put("/api/report-templates/:id", requireRole("manager"), ah(async (req, res) => {
  await store.updateReportTemplate(req.params.id, req.body);
  audit(req, "report_template_update", { id: req.params.id });
  res.json({ ok: true });
}));

app.delete("/api/report-templates/:id", requireRole("manager"), ah(async (req, res) => {
  await store.deleteReportTemplate(req.params.id);
  audit(req, "report_template_delete", { id: req.params.id });
  res.status(204).end();
}));

app.post("/api/report-templates/:id/generate", requireRole("operator"), ah(async (req, res) => {
  const report = await store.generateReport(req.params.id, req.body);
  const format = req.query.format || "json";
  if (format === "csv") {
    const headers = report.columns;
    const rows = report.data.map(r => headers.map(h => r[h] ?? ""));
    const csv = [headers.join(","), ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${report.template.replace(/[^a-z0-9]/gi, "_")}.csv"`);
    res.send(csv);
  } else {
    res.json(report);
  }
}));

// ---------- Integration Hub ----------
app.get("/api/integrations", requireRole("manager"), ah(async (req, res) => {
  res.json(await store.listIntegrations());
}));

app.post("/api/integrations", requireRole("admin"), ah(async (req, res) => {
  const { name, type, config, enabled } = req.body;
  if (!name || !type) return res.status(400).json({ error: "name and type required" });
  const integration = await store.createIntegration({ name, type, config: config || {}, enabled });
  audit(req, "integration_create", { id: integration.id, name, type });
  res.json(integration);
}));

app.put("/api/integrations/:id", requireRole("admin"), ah(async (req, res) => {
  await store.updateIntegration(req.params.id, req.body);
  audit(req, "integration_update", { id: req.params.id });
  res.json({ ok: true });
}));

app.delete("/api/integrations/:id", requireRole("admin"), ah(async (req, res) => {
  await store.deleteIntegration(req.params.id);
  audit(req, "integration_delete", { id: req.params.id });
  res.status(204).end();
}));

app.post("/api/integrations/:id/test", requireRole("admin"), ah(async (req, res) => {
  const integrations = await store.listIntegrations();
  const integration = integrations.find(i => i.id === req.params.id);
  if (!integration) return res.status(404).json({ error: "Integration not found" });
  const result = await store.sendWebhook(integration.config.url || "https://httpbin.org/post", { test: true, timestamp: new Date().toISOString(), integration: integration.name });
  await store.logIntegration(req.params.id, "outgoing", result.status, { url: integration.config.url }, result);
  audit(req, "integration_test", { id: req.params.id, result: result.status });
  res.json(result);
}));

app.get("/api/integration-logs", requireRole("manager"), ah(async (req, res) => {
  res.json(await store.listIntegrationLogs(req.query.integrationId, parseInt(req.query.limit) || 50));
}));

// ============================================================
// PHASE 7: Integrations + Enterprise — ERP/MES, Export, Webhooks
// ============================================================

// --- Integration Mappings ---
app.get("/api/integration-mappings", requireRole("manager"), ah(async (req, res) => {
  res.json(await store.listIntegrationMappings(req.query.integrationId));
}));

app.post("/api/integration-mappings", requireRole("admin"), ah(async (req, res) => {
  const mapping = await store.createIntegrationMapping(req.body);
  audit(req, "integration_mapping_create", { id: mapping.id });
  res.status(201).json(mapping);
}));

app.put("/api/integration-mappings/:id", requireRole("admin"), ah(async (req, res) => {
  await store.updateIntegrationMapping(req.params.id, req.body);
  audit(req, "integration_mapping_update", { id: req.params.id });
  res.json({ ok: true });
}));

app.delete("/api/integration-mappings/:id", requireRole("admin"), ah(async (req, res) => {
  await store.deleteIntegrationMapping(req.params.id);
  audit(req, "integration_mapping_delete", { id: req.params.id });
  res.json({ ok: true });
}));

// --- Webhook Configurations ---
app.get("/api/webhook-configs", requireRole("manager"), ah(async (req, res) => {
  res.json(await store.listWebhookConfigs(req.query.integrationId));
}));

app.post("/api/webhook-configs", requireRole("admin"), ah(async (req, res) => {
  const config = await store.createWebhookConfig(req.body);
  audit(req, "webhook_config_create", { id: config.id });
  res.status(201).json(config);
}));

app.put("/api/webhook-configs/:id", requireRole("admin"), ah(async (req, res) => {
  await store.updateWebhookConfig(req.params.id, req.body);
  audit(req, "webhook_config_update", { id: req.params.id });
  res.json({ ok: true });
}));

app.delete("/api/webhook-configs/:id", requireRole("admin"), ah(async (req, res) => {
  await store.deleteWebhookConfig(req.params.id);
  audit(req, "webhook_config_delete", { id: req.params.id });
  res.json({ ok: true });
}));

app.post("/api/webhook-configs/:id/test", requireRole("admin"), ah(async (req, res) => {
  const result = await store.fireWebhookWithRetry(req.params.id, "test", { test: true, timestamp: new Date().toISOString() });
  audit(req, "webhook_test", { id: req.params.id, result: result.success });
  res.json(result);
}));

// --- Data Export ---
app.get("/api/export/jobs/:id", requireUserMw, ah(async (req, res) => {
  const job = await store.getExportJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Export job not found" });
  res.json(job);
}));

app.post("/api/export", requireUserMw, ah(async (req, res) => {
  const { exportType, format, filters } = req.body;
  if (!exportType) return res.status(400).json({ error: "exportType required" });
  const validTypes = ["readings", "telemetry", "alerts", "maintenance", "production", "devices"];
  if (!validTypes.includes(exportType)) return res.status(400).json({ error: `exportType must be one of: ${validTypes.join(", ")}` });

  const job = await store.createExportJob({ userId: req.user.id, exportType, format: format || "csv", filters: filters || {} });

  // Generate export data
  const { data, columns, count } = await store.generateExportData(exportType, filters || {});

  if (format === "json") {
    await store.updateExportJob(job.id, { status: "completed", recordCount: count, completedAt: new Date().toISOString() });
    audit(req, "data_export", { type: exportType, format: "json", count });
    res.json({ jobId: job.id, data, count });
  } else {
    const csv = await store.convertToCSV(data, columns);
    const fileName = `export_${exportType}_${Date.now()}.csv`;
    await store.updateExportJob(job.id, { status: "completed", recordCount: count, fileUrl: `/tmp/${fileName}`, fileSize: csv.length, completedAt: new Date().toISOString() });
    audit(req, "data_export", { type: exportType, format: "csv", count });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(csv);
  }
}));

// --- Data Import ---
app.get("/api/import/jobs/:id", requireUserMw, ah(async (req, res) => {
  const job = await store.getImportJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Import job not found" });
  res.json(job);
}));

app.post("/api/import/validate", requireRole("manager"), ah(async (req, res) => {
  const { importType, data } = req.body;
  if (!importType || !data) return res.status(400).json({ error: "importType and data required" });
  const validTypes = ["devices", "products", "telemetry"];
  if (!validTypes.includes(importType)) return res.status(400).json({ error: `importType must be one of: ${validTypes.join(", ")}` });

  const job = await store.createImportJob({ userId: req.user.id, importType, fileName: "api_upload" });
  const validation = await store.validateImportData(importType, data);
  await store.updateImportJob(job.id, { totalRows: validation.total, validRows: validation.valid, errorRows: validation.errors, errors: validation.validationErrors, status: "validated" });

  audit(req, "data_import_validate", { type: importType, total: validation.total, valid: validation.valid, errors: validation.errors });
  res.json({ jobId: job.id, ...validation });
}));

app.post("/api/import/execute", requireRole("manager"), ah(async (req, res) => {
  const { jobId, data } = req.body;
  if (!jobId || !data) return res.status(400).json({ error: "jobId and data required" });
  const job = await store.getImportJob(jobId);
  if (!job) return res.status(404).json({ error: "Import job not found" });

  await store.updateImportJob(jobId, { status: "processing" });

  let processed = 0, errors = 0;
  const errorList = [];

  for (let i = 0; i < data.length; i++) {
    try {
      if (job.importType === "devices") {
        await store.addDevice({ name: data[i].name, protocol: data[i].protocol || "tcp", ip: data[i].ip, port: data[i].port });
      } else if (job.importType === "products") {
        await store.createProduct({ name: data[i].name, targetWeight: Number(data[i].targetWeight) || 25, toleranceType: data[i].toleranceType || "fixed", toleranceValue: Number(data[i].toleranceValue) || 5 });
      } else if (job.importType === "telemetry") {
        const deviceId = data[i].device_id || data[i].deviceId;
        await store.pushTelemetry(deviceId, data[i].metric, Number(data[i].value), data[i].unit);
      }
      processed++;
    } catch (e) {
      errors++;
      errorList.push({ row: i + 1, error: e.message });
      if (errorList.length > 50) break;
    }
  }

  await store.updateImportJob(jobId, { status: "completed", processedRows: processed, errorRows: errors, errors: errorList, result: { processed, errors }, completedAt: new Date().toISOString() });
  audit(req, "data_import_execute", { type: job.importType, processed, errors });
  res.json({ jobId, processed, errors, errors: errorList.slice(0, 20) });
}));

// --- API Discovery ---
app.get("/api/discovery", requireUserMw, ah(async (req, res) => {
  res.json(await store.getAPIDiscovery());
}));

// ---------- Push Notifications ----------
app.post("/api/push/subscribe", requireUserMw, ah(async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys) return res.status(400).json({ error: "endpoint and keys required" });
  await store.savePushSubscription(req.user.id, { endpoint, keys });
  res.json({ ok: true });
}));

app.delete("/api/push/subscribe", requireUserMw, ah(async (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) await store.removePushSubscription(endpoint);
  res.status(204).end();
}));

app.get("/api/push/subscriptions", requireUserMw, ah(async (req, res) => {
  const subs = await store.getPushSubscriptions(req.user.id);
  res.json({ count: subs.length });
}));

// ---------- API Usage ----------
app.get("/api/usage/stats", requireRole("manager"), ah(async (req, res) => {
  const { userId, days } = req.query;
  const d = parseInt(days) || 7;
  let query = `
    SELECT 
      user_id, endpoint, method, status_code,
      COUNT(*) as count,
      DATE(created_at) as date
    FROM api_usage 
    WHERE created_at > now() - interval '${d} days'
  `;
  const params = [];
  let idx = 1;
  if (userId) { query += ` AND user_id = $${idx}`; params.push(userId); idx++; }
  query += ` GROUP BY user_id, endpoint, method, status_code, DATE(created_at) ORDER BY date DESC, count DESC LIMIT 500`;
  const { rows } = await db.query(query, params);

  // Get top users
  const topUsers = await db.query(`
    SELECT user_id, COUNT(*) as total, 
      SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors
    FROM api_usage 
    WHERE created_at > now() - interval '${d} days'
    GROUP BY user_id ORDER BY total DESC LIMIT 10
  `);

  // Get top endpoints
  const topEndpoints = await db.query(`
    SELECT endpoint, method, COUNT(*) as total,
      SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors
    FROM api_usage 
    WHERE created_at > now() - interval '${d} days'
    GROUP BY endpoint, method ORDER BY total DESC LIMIT 20
  `);

  // Daily totals
  const dailyTotals = await db.query(`
    SELECT DATE(created_at) as date, COUNT(*) as total,
      SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors
    FROM api_usage 
    WHERE created_at > now() - interval '${d} days'
    GROUP BY DATE(created_at) ORDER BY date
  `);

  res.json({
    topUsers: topUsers.rows.map(r => ({ userId: r.user_id, total: parseInt(r.total), errors: parseInt(r.errors) })),
    topEndpoints: topEndpoints.rows.map(r => ({ endpoint: r.endpoint, method: r.method, total: parseInt(r.total), errors: parseInt(r.errors) })),
    dailyTotals: dailyTotals.rows.map(r => ({ date: r.date, total: parseInt(r.total), errors: parseInt(r.errors) })),
    totalRequests: rows.reduce((s, r) => s + parseInt(r.count), 0)
  });
}));

app.get("/api/usage/my", requireUserMw, ah(async (req, res) => {
  const { days } = req.query;
  const d = parseInt(days) || 7;
  const { rows } = await db.query(`
    SELECT endpoint, method, COUNT(*) as count, DATE(created_at) as date
    FROM api_usage 
    WHERE user_id = $1 AND created_at > now() - interval '${d} days'
    GROUP BY endpoint, method, DATE(created_at)
    ORDER BY date DESC, count DESC LIMIT 100
  `, [req.user.id]);
  res.json(rows.map(r => ({ endpoint: r.endpoint, method: r.method, count: parseInt(r.count), date: r.date })));
}));

// ---------- Dashboard Views ----------
app.get("/api/dashboard-views", requireUserMw, ah(async (req, res) => {
  res.json(await store.listDashboardViews());
}));

app.post("/api/dashboard-views", requireRole("manager"), ah(async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const view = await store.addDashboardView(name, req.user.username);
  res.status(201).json(view);
}));

app.delete("/api/dashboard-views/:id", requireRole("manager"), ah(async (req, res) => {
  await store.removeDashboardView(req.params.id);
  res.status(204).end();
}));

app.get("/api/dashboard-views/:id/widgets", requireUserMw, ah(async (req, res) => {
  res.json(await store.getDashboardWidgets(req.params.id));
}));

app.post("/api/dashboard-views/:id/widgets", requireRole("manager"), ah(async (req, res) => {
  const { deviceId, metric } = req.body;
  if (!deviceId || !metric) return res.status(400).json({ error: "deviceId and metric required" });
  const widget = await store.addDashboardWidget(req.params.id, deviceId, metric);
  res.status(201).json(widget);
}));

app.delete("/api/dashboard-widgets/:id", requireRole("manager"), ah(async (req, res) => {
  await store.removeDashboardWidget(req.params.id);
  res.status(204).end();
}));

app.put("/api/dashboard-views/:id/reorder", requireRole("manager"), ah(async (req, res) => {
  const { widgetIds } = req.body;
  if (!Array.isArray(widgetIds)) return res.status(400).json({ error: "widgetIds array required" });
  await store.reorderDashboardWidgets(req.params.id, widgetIds);
  res.json({ ok: true });
}));

// Check for due scheduled reports every hour
safeInterval(async () => {
  try {
    const due = await store.getDueReports();
    for (const report of due) await runScheduledReport(report);
  } catch (e) { console.error("[reports] cron check failed:", e.message); }
}, 3600000);

app.post("/api/readings", requireGatewayKey, ah(async (req, res) => {
  const { deviceId, weight, phase, bagCount, connected } = req.body;
  if (!deviceId || weight === undefined) {
    return res.status(400).json({ error: "deviceId and weight are required" });
  }
  const reading = {
    weight,
    phase: phase || "filling",
    bagCount: bagCount || 0,
    connected: connected !== false,
    ts: Date.now(),
  };

  const device = await store.getDevice(deviceId);
  const deviceName = device ? device.name : deviceId;
  store.logComm(deviceId, { success: true, note: `reading (${reading.phase})` });

  if (!reading.connected) {
    await fireAlert("trigger", deviceId, deviceName, "device_disconnected", `${deviceName} is reporting a lost connection`, "critical");
  } else {
    await fireAlert("resolve", deviceId, deviceName, "device_disconnected");
  }

  const prev = store.getLatest(deviceId);
  await store.pushReading(deviceId, reading);

  if (prev && prev.phase !== "settling" && reading.phase === "settling" && device) {
    const product = device.productId ? await store.getProduct(device.productId) : null;
    const target = product ? product.targetWeight : device.target;
    const classification = product ? store.classifyWeight(reading.weight, product) : null;

    const stats = await store.recordBag(deviceId, reading.weight, target, device.costPerUnit, classification);
    broadcast({ type: "bag", deviceId, stats, classification });

    const alertCfg = await store.getAlertConfig();
    let withinTolerance;
    if (product) {
      withinTolerance = classification === "PASS";
    } else {
      const deviationPercent = Math.abs(((reading.weight - target) / target) * 100);
      withinTolerance = deviationPercent <= alertCfg.toleranceThresholdPercent;
    }
    const streak = store.recordToleranceOutcome(deviceId, withinTolerance);

    if (streak >= alertCfg.consecutiveBagsThreshold) {
      const detail = product
        ? `${streak} bags in a row classified ${classification} against ${product.name}`
        : `${streak} bags in a row more than ${alertCfg.toleranceThresholdPercent}% off target`;
      await fireAlert("trigger", deviceId, deviceName, "bag_tolerance", `${deviceName}: ${detail}`, "warning");
    } else if (withinTolerance) {
      await fireAlert("resolve", deviceId, deviceName, "bag_tolerance");
    }
  }

  broadcast({ type: "reading", deviceId, reading });
  res.status(202).json({ ok: true });
}));

// ============================================================
// PHASE 1: Platform Foundation — Hierarchy, Asset Types, Telemetry, Sensors
// ============================================================

// --- Sites ---
app.get("/api/sites", requireUserMw, ah(async (req, res) => {
  res.json(await store.listSites(req.query.orgId));
}));

app.post("/api/sites", requireRole("manager"), ah(async (req, res) => {
  const { name, orgId, code, address, timezone, lat, lng } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const site = await store.createSite({ name, orgId, code, address, timezone, lat, lng });
  audit(req, "site_create", { siteId: site.id, name });
  res.status(201).json(site);
}));

app.put("/api/sites/:id", requireRole("manager"), ah(async (req, res) => {
  const site = await store.getSite(req.params.id);
  if (!site) return res.status(404).json({ error: "site not found" });
  const updated = await store.updateSite(req.params.id, req.body);
  audit(req, "site_update", { siteId: req.params.id, changes: Object.keys(req.body) });
  res.json(updated);
}));

app.delete("/api/sites/:id", requireRole("admin"), ah(async (req, res) => {
  await store.deleteSite(req.params.id);
  audit(req, "site_delete", { siteId: req.params.id });
  res.status(204).end();
}));

// --- Areas ---
app.get("/api/areas", requireUserMw, ah(async (req, res) => {
  res.json(await store.listAreas(req.query.siteId));
}));

app.post("/api/areas", requireRole("manager"), ah(async (req, res) => {
  const { siteId, name, code, description, color } = req.body;
  if (!siteId || !name) return res.status(400).json({ error: "siteId and name are required" });
  const area = await store.createArea({ siteId, name, code, description, color });
  audit(req, "area_create", { areaId: area.id, name });
  res.status(201).json(area);
}));

app.put("/api/areas/:id", requireRole("manager"), ah(async (req, res) => {
  const area = await store.getArea(req.params.id);
  if (!area) return res.status(404).json({ error: "area not found" });
  const updated = await store.updateArea(req.params.id, req.body);
  audit(req, "area_update", { areaId: req.params.id, changes: Object.keys(req.body) });
  res.json(updated);
}));

app.delete("/api/areas/:id", requireRole("manager"), ah(async (req, res) => {
  await store.deleteArea(req.params.id);
  audit(req, "area_delete", { areaId: req.params.id });
  res.status(204).end();
}));

// --- Lines ---
app.get("/api/lines", requireUserMw, ah(async (req, res) => {
  res.json(await store.listLines(req.query.areaId));
}));

app.post("/api/lines", requireRole("manager"), ah(async (req, res) => {
  const { areaId, name, code, description, color } = req.body;
  if (!areaId || !name) return res.status(400).json({ error: "areaId and name are required" });
  const line = await store.createLine({ areaId, name, code, description, color });
  audit(req, "line_create", { lineId: line.id, name });
  res.status(201).json(line);
}));

app.put("/api/lines/:id", requireRole("manager"), ah(async (req, res) => {
  const line = await store.getLine(req.params.id);
  if (!line) return res.status(404).json({ error: "line not found" });
  const updated = await store.updateLine(req.params.id, req.body);
  audit(req, "line_update", { lineId: req.params.id, changes: Object.keys(req.body) });
  res.json(updated);
}));

app.delete("/api/lines/:id", requireRole("manager"), ah(async (req, res) => {
  await store.deleteLine(req.params.id);
  audit(req, "line_delete", { lineId: req.params.id });
  res.status(204).end();
}));

// --- Stations ---
app.get("/api/stations", requireUserMw, ah(async (req, res) => {
  res.json(await store.listStations(req.query.lineId));
}));

app.post("/api/stations", requireRole("manager"), ah(async (req, res) => {
  const { lineId, name, code, description } = req.body;
  if (!lineId || !name) return res.status(400).json({ error: "lineId and name are required" });
  const station = await store.createStation({ lineId, name, code, description });
  audit(req, "station_create", { stationId: station.id, name });
  res.status(201).json(station);
}));

app.put("/api/stations/:id", requireRole("manager"), ah(async (req, res) => {
  const station = await store.getStation(req.params.id);
  if (!station) return res.status(404).json({ error: "station not found" });
  const updated = await store.updateStation(req.params.id, req.body);
  audit(req, "station_update", { stationId: req.params.id, changes: Object.keys(req.body) });
  res.json(updated);
}));

app.delete("/api/stations/:id", requireRole("manager"), ah(async (req, res) => {
  await store.deleteStation(req.params.id);
  audit(req, "station_delete", { stationId: req.params.id });
  res.status(204).end();
}));

// --- Hierarchy Tree ---
app.get("/api/hierarchy", requireUserMw, ah(async (req, res) => {
  res.json(await store.getHierarchyTree(req.query.orgId));
}));

// --- Asset Types ---
app.get("/api/asset-types", requireUserMw, ah(async (req, res) => {
  const types = await store.listAssetTypes(req.query.orgId);
  const result = [];
  for (const t of types) {
    const metrics = await store.listAssetTypeMetrics(t.id);
    result.push({ ...t, metrics });
  }
  res.json(result);
}));

app.get("/api/asset-types/:id", requireUserMw, ah(async (req, res) => {
  const type = await store.getAssetType(req.params.id);
  if (!type) return res.status(404).json({ error: "asset type not found" });
  const metrics = await store.listAssetTypeMetrics(type.id);
  res.json({ ...type, metrics });
}));

app.post("/api/asset-types", requireRole("manager"), ah(async (req, res) => {
  const { name, code, description, icon, color, category, orgId, metrics } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const assetType = await store.createAssetType({ name, code, description, icon, color, category, orgId });
  if (Array.isArray(metrics)) {
    for (const m of metrics) {
      await store.createAssetTypeMetric({ assetTypeId: assetType.id, ...m });
    }
  }
  audit(req, "asset_type_create", { assetTypeId: assetType.id, name });
  res.status(201).json(assetType);
}));

app.put("/api/asset-types/:id", requireRole("manager"), ah(async (req, res) => {
  const type = await store.getAssetType(req.params.id);
  if (!type) return res.status(404).json({ error: "asset type not found" });
  const updated = await store.updateAssetType(req.params.id, req.body);
  audit(req, "asset_type_update", { assetTypeId: req.params.id, changes: Object.keys(req.body) });
  res.json(updated);
}));

app.delete("/api/asset-types/:id", requireRole("admin"), ah(async (req, res) => {
  const type = await store.getAssetType(req.params.id);
  if (type?.isSystem) return res.status(400).json({ error: "cannot delete system asset types" });
  await store.deleteAssetType(req.params.id);
  audit(req, "asset_type_delete", { assetTypeId: req.params.id });
  res.status(204).end();
}));

// --- Asset Type Metrics ---
app.post("/api/asset-types/:id/metrics", requireRole("manager"), ah(async (req, res) => {
  const type = await store.getAssetType(req.params.id);
  if (!type) return res.status(404).json({ error: "asset type not found" });
  const { name, displayName, unit, dataType, minValue, maxValue, precision, category } = req.body;
  if (!name || !displayName) return res.status(400).json({ error: "name and displayName are required" });
  const metric = await store.createAssetTypeMetric({ assetTypeId: req.params.id, name, displayName, unit, dataType, minValue, maxValue, precision, category });
  audit(req, "asset_type_metric_create", { assetTypeId: req.params.id, name });
  res.status(201).json(metric);
}));

app.delete("/api/asset-types/metrics/:id", requireRole("manager"), ah(async (req, res) => {
  await store.deleteAssetTypeMetric(req.params.id);
  audit(req, "asset_type_metric_delete", { metricId: req.params.id });
  res.status(204).end();
}));

// --- Sensors ---
app.get("/api/sensors", requireUserMw, ah(async (req, res) => {
  res.json(await store.listSensors(req.query.deviceId));
}));

app.get("/api/sensors/:id", requireUserMw, ah(async (req, res) => {
  const sensor = await store.getSensor(req.params.id);
  if (!sensor) return res.status(404).json({ error: "sensor not found" });
  res.json(sensor);
}));

app.post("/api/sensors", requireRole("manager"), ah(async (req, res) => {
  const { deviceId, name, type, unit, config, minValue, maxValue, warningMin, warningMax, alarmMin, alarmMax } = req.body;
  if (!deviceId || !name || !type) return res.status(400).json({ error: "deviceId, name, and type are required" });
  const sensor = await store.createSensor({ deviceId, name, type, unit, config, minValue, maxValue, warningMin, warningMax, alarmMin, alarmMax });
  audit(req, "sensor_create", { sensorId: sensor.id, deviceId, name });
  res.status(201).json(sensor);
}));

app.put("/api/sensors/:id", requireRole("manager"), ah(async (req, res) => {
  const sensor = await store.getSensor(req.params.id);
  if (!sensor) return res.status(404).json({ error: "sensor not found" });
  const updated = await store.updateSensor(req.params.id, req.body);
  audit(req, "sensor_update", { sensorId: req.params.id, changes: Object.keys(req.body) });
  res.json(updated);
}));

app.delete("/api/sensors/:id", requireRole("manager"), ah(async (req, res) => {
  await store.deleteSensor(req.params.id);
  audit(req, "sensor_delete", { sensorId: req.params.id });
  res.status(204).end();
}));

// --- Generic Telemetry ---
app.post("/api/telemetry", requireGatewayKey, ah(async (req, res) => {
  const { deviceId, metrics, connected, quality } = req.body;
  if (!deviceId || !metrics || typeof metrics !== "object") {
    return res.status(400).json({ error: "deviceId and metrics (object) are required" });
  }
  await store.pushTelemetry(deviceId, metrics, connected, quality);
  broadcast({ type: "telemetry", deviceId, metrics, connected, ts: Date.now() });

  // Update asset status
  const status = connected !== false ? "running" : "offline";
  await store.updateAssetStatus(deviceId, status, connected !== false ? "Receiving data" : "No connection", metrics);
  broadcast({ type: "asset_status", deviceId, status });

  // Evaluate alert rules for each metric
  for (const [metricName, metricValue] of Object.entries(metrics)) {
    if (typeof metricValue === "number") {
      try {
        await store.evaluateRulesForDevice(deviceId, metricName, metricValue);
      } catch (e) {
        console.error(`[rules] evaluation error for ${deviceId}/${metricName}:`, e.message);
      }
    }
  }

  res.status(202).json({ ok: true });
}));

app.get("/api/telemetry/:deviceId", requireUserMw, ah(async (req, res) => {
  const limit = Number(req.query.limit) || 100;
  const metricName = req.query.metric || null;
  res.json(await store.getTelemetry(req.params.deviceId, metricName, limit));
}));

app.get("/api/telemetry/:deviceId/range", requireUserMw, ah(async (req, res) => {
  const { from, to, metric } = req.query;
  if (!from || !to) return res.status(400).json({ error: "from and to query params are required" });
  res.json(await store.getTelemetryInRange(req.params.deviceId, from, to, metric));
}));

app.get("/api/telemetry/:deviceId/latest", requireUserMw, ah(async (req, res) => {
  const latest = await store.getLatestTelemetry(req.params.deviceId);
  res.json(latest || { metrics: {}, connected: false, ts: null });
}));

// ============================================================
// PHASE 2: Real-Time Operations — Alert Rules + Asset Status
// ============================================================

// --- Asset Status ---
app.get("/api/asset-status", requireUserMw, ah(async (req, res) => {
  if (req.query.deviceId) {
    res.json(await store.getAssetStatus(req.query.deviceId));
  } else {
    res.json(await store.getAllAssetStatuses());
  }
}));

// --- Alert Rules ---
app.get("/api/alert-rules", requireUserMw, ah(async (req, res) => {
  res.json(await store.listAlertRules(req.query.orgId));
}));

app.get("/api/alert-rules/:id", requireUserMw, ah(async (req, res) => {
  const rule = await store.getAlertRule(req.params.id);
  if (!rule) return res.status(404).json({ error: "rule not found" });
  res.json(rule);
}));

app.post("/api/alert-rules", requireRole("manager"), ah(async (req, res) => {
  const { name, description, enabled, deviceId, deviceIds, metric, operator, threshold, severity, messageTemplate, cooldownSeconds, consecutiveCount, tags, orgId } = req.body;
  if (!name || !metric || threshold === undefined) return res.status(400).json({ error: "name, metric, and threshold are required" });
  const validOps = [">", ">=", "<", "<=", "==", "!="];
  if (operator && !validOps.includes(operator)) return res.status(400).json({ error: `operator must be one of ${validOps.join(", ")}` });
  const rule = await store.createAlertRule({ name, description, enabled, deviceId, deviceIds, metric, operator, threshold, severity, messageTemplate, cooldownSeconds, consecutiveCount, tags, orgId });
  audit(req, "alert_rule_create", { ruleId: rule.id, name, metric });
  res.status(201).json(rule);
}));

app.put("/api/alert-rules/:id", requireRole("manager"), ah(async (req, res) => {
  const rule = await store.getAlertRule(req.params.id);
  if (!rule) return res.status(404).json({ error: "rule not found" });
  const updated = await store.updateAlertRule(req.params.id, req.body);
  audit(req, "alert_rule_update", { ruleId: req.params.id, changes: Object.keys(req.body) });
  res.json(updated);
}));

app.delete("/api/alert-rules/:id", requireRole("manager"), ah(async (req, res) => {
  await store.deleteAlertRule(req.params.id);
  audit(req, "alert_rule_delete", { ruleId: req.params.id });
  res.status(204).end();
}));

app.post("/api/alert-rules/:id/test", requireRole("manager"), ah(async (req, res) => {
  const rule = await store.getAlertRule(req.params.id);
  if (!rule) return res.status(404).json({ error: "rule not found" });
  const { deviceId, metricValue } = req.body;
  if (!deviceId) return res.status(400).json({ error: "deviceId is required" });
  const value = metricValue !== undefined ? metricValue : rule.threshold + 1;
  const triggered = await store.evaluateRulesForDevice(deviceId, rule.metric, value);
  audit(req, "alert_rule_test", { ruleId: req.params.id, deviceId });
  res.json({ triggered: triggered.length > 0, triggeredRules: triggered });
}));

// ============================================================
// PHASE 3: Manufacturing — Production Orders, Events, Quality, Shifts
// ============================================================

// --- Production Orders ---
app.get("/api/production-orders", requireUserMw, ah(async (req, res) => {
  res.json(await store.listProductionOrders({ status: req.query.status, productId: req.query.productId, deviceId: req.query.deviceId, lineId: req.query.lineId, from: req.query.from, to: req.query.to }));
}));

app.get("/api/production-orders/:id", requireUserMw, ah(async (req, res) => {
  const order = await store.getProductionOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "order not found" });
  res.json(order);
}));

app.post("/api/production-orders", requireRole("manager"), ah(async (req, res) => {
  const order = await store.createProductionOrder(req.body);
  audit(req, "production_order_create", { orderId: order.id });
  res.status(201).json(order);
}));

app.put("/api/production-orders/:id", requireRole("manager"), ah(async (req, res) => {
  const existing = await store.getProductionOrder(req.params.id);
  if (!existing) return res.status(404).json({ error: "order not found" });
  const updated = await store.updateProductionOrder(req.params.id, req.body);
  audit(req, "production_order_update", { orderId: req.params.id });
  res.json(updated);
}));

app.delete("/api/production-orders/:id", requireRole("manager"), ah(async (req, res) => {
  await store.deleteProductionOrder(req.params.id);
  audit(req, "production_order_delete", { orderId: req.params.id });
  res.json({ ok: true });
}));

// --- Production Events ---
app.get("/api/production-events", requireUserMw, ah(async (req, res) => {
  res.json(await store.listProductionEvents({ orderId: req.query.orderId, deviceId: req.query.deviceId, eventType: req.query.eventType }));
}));

app.post("/api/production-events", requireRole("manager"), ah(async (req, res) => {
  const event = await store.createProductionEvent(req.body);
  audit(req, "production_event_create", { eventId: event.id, eventType: event.eventType });
  res.status(201).json(event);
}));

app.put("/api/production-events/:id/end", requireRole("manager"), ah(async (req, res) => {
  const ended = await store.endProductionEvent(req.params.id);
  if (!ended) return res.status(404).json({ error: "event not found or already ended" });
  res.json(ended);
}));

// --- Quality Metrics ---
app.get("/api/quality-metrics", requireUserMw, ah(async (req, res) => {
  res.json(await store.listQualityMetrics({ orderId: req.query.orderId, deviceId: req.query.deviceId, metricName: req.query.metricName }));
}));

app.post("/api/quality-metrics", requireRole("manager"), ah(async (req, res) => {
  const metric = await store.addQualityMetric(req.body);
  audit(req, "quality_metric_add", { metricId: metric.id, metricName: metric.metricName, pass: metric.pass });
  res.status(201).json(metric);
}));

// --- Shift Templates ---
app.get("/api/shift-templates", requireUserMw, ah(async (req, res) => {
  res.json(await store.listShiftTemplates(req.user.orgId));
}));

app.post("/api/shift-templates", requireRole("manager"), ah(async (req, res) => {
  const template = await store.createShiftTemplate({ ...req.body, orgId: req.user.orgId });
  audit(req, "shift_template_create", { templateId: template.id });
  res.status(201).json(template);
}));

app.put("/api/shift-templates/:id", requireRole("manager"), ah(async (req, res) => {
  await store.updateShiftTemplate(req.params.id, req.body);
  audit(req, "shift_template_update", { templateId: req.params.id });
  res.json({ ok: true });
}));

app.delete("/api/shift-templates/:id", requireRole("manager"), ah(async (req, res) => {
  await store.deleteShiftTemplate(req.params.id);
  audit(req, "shift_template_delete", { templateId: req.params.id });
  res.json({ ok: true });
}));

// --- WebSocket section ---
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(data);
  });
}

wss.on("connection", (ws, req) => {
  (async () => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    const secret = await store.getJwtSecret();
    const payload = token && secret && auth.verifyToken(token, secret);
    const user = payload && (await store.findUserById(payload.uid));
    if (!user) {
      ws.close(4001, "unauthorized");
      return;
    }

    const devices = await store.listDevices();
    const snapshot = await Promise.all(
      devices.map(async (d) => ({
        deviceId: d.id,
        reading: store.getLatest(d.id),
        stats: await store.getBagStats(d.id),
        telemetry: await store.getLatestTelemetry(d.id),
        assetStatus: await store.getAssetStatus(d.id),
      }))
    );
    ws.send(JSON.stringify({ type: "snapshot", devices: snapshot, alerts: store.listActiveAlerts() }));
  })().catch((err) => {
    console.error("[ws] connection setup failed:", err.message);
    ws.close(1011, "internal error");
  });
});

// setInterval doesn't catch rejected promises — wrap every watchdog so a
// transient DB error logs and retries next tick instead of crashing the process.
function safeInterval(fn, ms) {
  setInterval(() => {
    Promise.resolve(fn()).catch((err) => console.error(`[watchdog] ${fn.name} failed:`, err.message));
  }, ms);
}

async function checkForSilentDevices() {
  const { offlineTimeoutSeconds } = await store.getAlertConfig();
  const cutoffMs = offlineTimeoutSeconds * 1000;
  const now = Date.now();

  for (const device of await store.listDevices()) {
    const latest = store.getLatest(device.id);
    const silentFor = latest ? now - latest.ts : now - new Date(device.createdAt).getTime();
    if (silentFor > cutoffMs) {
      await fireAlert("trigger", device.id, device.name, "no_data", `No data received from ${device.name} in over ${offlineTimeoutSeconds}s`, "critical");
    } else {
      await fireAlert("resolve", device.id, device.name, "no_data");
    }
  }
}

// Anomaly detection: flag readings that are statistical outliers (>3 sigma from mean)
async function checkForAnomalies() {
  for (const device of await store.listDevices()) {
    const readings = store.getReadings(device.id, 50);
    const weights = readings.map(r => r.weight).filter(w => w !== null && w !== undefined);
    if (weights.length < 10) continue;
    const mean = weights.reduce((a, b) => a + b, 0) / weights.length;
    const stdDev = Math.sqrt(weights.reduce((a, b) => a + (b - mean) ** 2, 0) / weights.length);
    if (stdDev === 0) continue;
    const latest = weights[weights.length - 1];
    const zScore = Math.abs((latest - mean) / stdDev);
    if (zScore > 3) {
      await fireAlert("trigger", device.id, device.name, "anomaly",
        `Anomalous reading on ${device.name}: ${latest.toFixed(2)} (z-score: ${zScore.toFixed(1)}, mean: ${mean.toFixed(2)}, σ: ${stdDev.toFixed(3)})`,
        "warning");
    } else {
      await fireAlert("resolve", device.id, device.name, "anomaly");
    }
  }
}

async function checkCalibrationDue() {
  const { calibrationReminderDays } = await store.getAlertConfig();
  const reminderMs = calibrationReminderDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const device of await store.listDevices()) {
    const latest = await store.getLatestCalibration(device.id);
    if (!latest || !latest.nextCalibrationDate) {
      await fireAlert("resolve", device.id, device.name, "calibration_due");
      continue;
    }
    const dueAt = new Date(latest.nextCalibrationDate).getTime();
    const msUntilDue = dueAt - now;
    if (msUntilDue <= 0) {
      await fireAlert("trigger", device.id, device.name, "calibration_due", `${device.name}: calibration overdue (was due ${new Date(dueAt).toLocaleDateString()})`, "critical");
    } else if (msUntilDue <= reminderMs) {
      await fireAlert("trigger", device.id, device.name, "calibration_due", `${device.name}: calibration due ${new Date(dueAt).toLocaleDateString()}`, "warning");
    } else {
      await fireAlert("resolve", device.id, device.name, "calibration_due");
    }
  }
}

async function checkMaintenanceDue() {
  const { maintenanceReminderDays } = await store.getAlertConfig();
  const reminderMs = maintenanceReminderDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const device of await store.listDevices()) {
    const records = await store.listMaintenanceRecords(device.id);
    const scheduled = records.filter((m) => m.status === "SCHEDULED" && m.dueDate).sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    const next = scheduled[0];
    if (!next) {
      await fireAlert("resolve", device.id, device.name, "maintenance_due");
      continue;
    }
    const dueAt = new Date(next.dueDate).getTime();
    const msUntilDue = dueAt - now;
    if (msUntilDue <= 0) {
      await fireAlert("trigger", device.id, device.name, "maintenance_due", `${device.name}: maintenance overdue (${next.workOrderNumber}, was due ${new Date(dueAt).toLocaleDateString()})`, "critical");
    } else if (msUntilDue <= reminderMs) {
      await fireAlert("trigger", device.id, device.name, "maintenance_due", `${device.name}: maintenance due ${new Date(dueAt).toLocaleDateString()} (${next.workOrderNumber})`, "warning");
    } else {
      await fireAlert("resolve", device.id, device.name, "maintenance_due");
    }
  }
}

safeInterval(checkForSilentDevices, 5000);
safeInterval(checkCalibrationDue, 60000);
safeInterval(checkMaintenanceDue, 60000);
safeInterval(checkForAnomalies, 30000);

// ---------- Data retention cleanup ----------
const RETENTION_DAYS = Number(process.env.READING_RETENTION_DAYS) || 0;

async function purgeOldReadings() {
  if (RETENTION_DAYS <= 0) return;
  const purged = await store.purgeOldReadings(RETENTION_DAYS);
  if (purged > 0) console.log(`[retention] purged ${purged} readings older than ${RETENTION_DAYS} days`);
}

if (RETENTION_DAYS > 0) {
  console.log(`[retention] data retention enabled: readings older than ${RETENTION_DAYS} days will be purged daily`);
  safeInterval(purgeOldReadings, 24 * 60 * 60 * 1000); // daily
}

// ---------- Multi-site sync agent (local instance only) ----------
// Only runs when this instance is configured as SYNC_ROLE=local — a
// "cloud"-role instance (or a standalone single-instance deployment, the
// default) never runs this; it just exposes POST /api/sync/push to receive
// pushes from local instances, defined above.
//
// Deliberately simple: no separate durable queue file like the gateway
// uses — the local Postgres database (specifically the sync_outbox table)
// IS the buffer. A failed push just means those outbox rows stay unsynced
// and get retried next interval; nothing is lost as long as local Postgres
// itself is intact, which it always is, since this instance depends on it
// for everything else too.
const SYNC_ROLE = process.env.SYNC_ROLE || "none"; // "none" | "local"
const CLOUD_SYNC_URL = process.env.CLOUD_SYNC_URL;
const CLOUD_SYNC_KEY = process.env.CLOUD_SYNC_KEY;
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS) || 15000;
const SYNC_BATCH_SIZE = Number(process.env.SYNC_BATCH_SIZE) || 500;

async function runSyncAgent() {
  const pending = await store.listUnsyncedOutbox(SYNC_BATCH_SIZE);
  if (pending.length === 0) return;

  const records = pending.map((p) => ({ entityType: p.entityType, entityId: p.entityId, operation: p.operation, payload: p.payload }));

  let res;
  try {
    res = await fetch(`${CLOUD_SYNC_URL}/api/sync/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sync-Key": CLOUD_SYNC_KEY },
      body: JSON.stringify({ records }),
    });
  } catch (err) {
    console.warn(`[sync] cloud unreachable, ${pending.length} record(s) remain buffered: ${err.message}`);
    return; // stays unsynced, retried next interval — no data lost
  }

  if (res.status === 401) {
    console.error("[sync] cloud rejected the sync key (invalid or revoked) — check CLOUD_SYNC_KEY");
    return;
  }
  if (!res.ok) {
    console.warn(`[sync] cloud returned ${res.status}, ${pending.length} record(s) remain buffered`);
    return;
  }

  const result = await res.json();
  // Only mark the records that actually succeeded — a record that errored
  // on the cloud side must stay unsynced so it gets retried next interval,
  // not silently dropped. See the comment on /api/sync/push for why this
  // matters (a real bug here previously caused failed deletes to vanish).
  const succeededIds = pending.filter((_, i) => result.results?.[i]?.success).map((p) => p.id);
  await store.markOutboxSynced(succeededIds);

  if (result.errors && result.errors.length > 0) {
    console.warn(`[sync] pushed ${result.applied}/${result.total}, ${result.errors.length} record(s) had errors (will retry):`, result.errors.slice(0, 3));
  } else {
    console.log(`[sync] pushed ${result.applied} record(s) to cloud`);
  }
}

if (SYNC_ROLE === "local") {
  if (!CLOUD_SYNC_URL || !CLOUD_SYNC_KEY) {
    console.error("[sync] SYNC_ROLE=local but CLOUD_SYNC_URL/CLOUD_SYNC_KEY are not set — sync agent will not run");
  } else {
    console.log(`[sync] local sync agent enabled, pushing to ${CLOUD_SYNC_URL} every ${SYNC_INTERVAL_MS}ms`);
    safeInterval(runSyncAgent, SYNC_INTERVAL_MS);
  }
}

// ---------- Startup: run migrations, then bootstrap auth on first run ----------

async function bootstrapAuth() {
  if (!(await store.getJwtSecret())) {
    await store.setJwtSecret(auth.randomSecret());
  }

  if ((await store.listUsers()).length === 0) {
    const password = auth.randomReadablePassword();
    const passwordHash = await auth.hashPassword(password);
    await store.addUser({
      id: `u_${Date.now()}`,
      username: "admin",
      passwordHash,
      role: "admin",
      createdAt: new Date().toISOString(),
    });
    console.log("=".repeat(64));
    console.log("First run — created the dashboard login:");
    console.log(`  username: admin`);
    console.log(`  password: ${password}`);
    console.log("This will not be shown again. Store it somewhere safe.");
    console.log("Add more users (with operator/manager/admin roles) from the");
    console.log("dashboard's Users panel once logged in.");
    console.log("=".repeat(64));
  }

  if ((await store.listGatewayKeys()).length === 0) {
    const key = auth.randomApiKey();
    await store.addGatewayKey({
      id: `k_${Date.now()}`,
      key,
      label: "default",
      createdAt: new Date().toISOString(),
    });
    console.log("=".repeat(64));
    console.log("Created a default gateway API key:");
    console.log(`  ${key}`);
    console.log("Put this in gateway/.env as GATEWAY_API_KEY=<key>");
    console.log("(You can create more / revoke this one from the dashboard later.)");
    console.log("=".repeat(64));
  }
}

async function start() {
  console.log("[db] running migrations…");
  await store.migrate();
  console.log("[db] migrations complete");
  await bootstrapAuth();
  // Initialize notification email transporter from saved config
  const nCfg = await store.getNotificationConfig();
  notify.initEmailTransporter(nCfg);
  server.listen(PORT, () => {
    console.log(`Backend + dashboard listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
