const API = "";
const PROTOCOLS = ["Simulator", "Modbus TCP", "Modbus RTU", "OPC-UA", "MQTT", "EtherNet/IP", "PROFINET", "S7", "SNMP", "REST API", "TCP Socket", "Serial", "RS232", "RS485"];
const METRICS = [
  { id: "live_weight", label: "Live weight" },
  { id: "trend", label: "Weight trend" },
  { id: "bag_count", label: "Bag counter" },
  { id: "deviation", label: "Target deviation" },
  { id: "giveaway", label: "Give-away / loss" },
  { id: "classification", label: "Bag classification" },
];
const ROLES = ["operator", "manager", "admin"];
const ROLE_RANK = { operator: 0, manager: 1, admin: 2 };

let devices = [];
let widgets = [];
let branding = { companyName: "Scale Ops", tagline: "Fill Line Monitoring", logoUrl: "", accentColor: "#F2B705" };
let gatewayKeys = [];
let newlyCreatedKey = null;
let alertConfig = { toleranceThresholdPercent: 3, consecutiveBagsThreshold: 3, offlineTimeoutSeconds: 10, webhookUrl: "", calibrationReminderDays: 14, maintenanceReminderDays: 7 };
let notificationConfig = { emailEnabled: false, emailRecipients: "", smtpUser: "", smtpPass: "", whatsappEnabled: false, whatsappRecipients: "", ultrammsgUrl: "https://api.ultramsg.com", ultrammsgToken: "", ultrammsgInstanceId: "", downtimeNotifyEnabled: true };
let activeAlerts = [];
let alertHistory = [];
let currentUser = null;
let users = [];
let auditLog = [];
let products = [];
let maintenanceRecords = [];
let calibrationRecords = [];
let templates = [];
const readingsByDevice = new Map();
const latestByDevice = new Map();
const statsByDevice = new Map();
const classificationByDevice = new Map();

let currentView = "dashboard";
let toasts = [];
let toastId = 0;
let engineeringDeviceId = null;
let engineeringData = { raw: null, testConn: null, testDp: null, commLog: [], protocolConfig: null };
let loginError = "";
let ws = null;
let reportFrom = "";
let reportTo = "";
let showPasswordChange = false;
let syncKeys = [];
let syncStatus = null;
let newlyCreatedSyncKey = null;
let downtimeLogs = [];
let downtimeStats = [];
let downtimeDeviceFilter = "";
let spcDeviceId = "";
let spcReadings = [];
let scheduledReports = [];
let dashboardViews = [];
let currentDashboardViewId = "";
let wizardOpen = false;
let wizardStep = 1;
let wizardData = {
  name: "", ip: "", protocol: "Modbus TCP", templateId: "", productId: "",
  target: 25, unit: "kg", costPerUnit: 0,
  port: 502, registerMap: {}, pollingMs: 500,
  connResult: null, dpResult: null,
  createdDevice: null,
};

// ---------- Role helpers ----------

function hasRole(minRole) {
  return currentUser && ROLE_RANK[currentUser.role] >= ROLE_RANK[minRole];
}

// ---------- Toast notifications ----------

function toast(message, type = "info") {
  const id = ++toastId;
  toasts.push({ id, message, type });
  renderToasts();
  setTimeout(() => { toasts = toasts.filter(t => t.id !== id); renderToasts(); }, 4000);
}

function renderToasts() {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.style.cssText = "position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;";
    document.body.appendChild(container);
  }
  container.innerHTML = toasts.map(t => {
    const bg = t.type === "error" ? "#2A1518" : t.type === "success" ? "#132A22" : "#1B2129";
    const border = t.type === "error" ? "#E5484D" : t.type === "success" ? "#4FD1B5" : "#2A333D";
    const color = t.type === "error" ? "#E5484D" : t.type === "success" ? "#4FD1B5" : "#E8EAED";
    return `<div style="background:${bg};border:1px solid ${border};color:${color};padding:10px 16px;border-radius:8px;font-size:13px;pointer-events:auto;box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:360px;animation:slideIn 0.2s ease;">${esc(t.message)}</div>`;
  }).join("");
}

// ---------- Auth ----------

function getToken() { return localStorage.getItem("token"); }
function setToken(token) { if (token) localStorage.setItem("token", token); else localStorage.removeItem("token"); }

async function authFetch(url, opts = {}) {
  const token = getToken();
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    setToken(null);
    if (ws) ws.close();
    renderLogin("Session expired — please log in again.");
    throw new Error("unauthorized");
  }
  return res;
}

async function login(username, password, twoFactorCode) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, twoFactorCode }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Login failed");
  }
  const data = await res.json();
  if (data.requires2FA) {
    return { requires2FA: true, username: data.username };
  }
  setToken(data.token);
  currentUser = { username: data.username, role: data.role, twoFactorEnabled: data.twoFactorEnabled };
  return { ok: true };
}

function logout() {
  setToken(null);
  if (ws) ws.close();
  devices = []; widgets = []; currentUser = null;
  // Clear the cached layout so the next login does a full render
  const main = document.getElementById("main-content");
  if (main) main.removeAttribute("id");
  renderLogin();
}

// ---------- Data loading ----------

async function loadInitial() {
  const brandingPromise = fetch(`${API}/api/branding`);
  const meRes = await authFetch(`${API}/api/auth/me`);
  currentUser = await meRes.json();

  const calls = [
    authFetch(`${API}/api/devices`),
    authFetch(`${API}/api/widgets`),
    authFetch(`${API}/api/alerts`),
    authFetch(`${API}/api/alert-config`),
    authFetch(`${API}/api/products`),
    authFetch(`${API}/api/templates`),
    authFetch(`${API}/api/maintenance`),
    authFetch(`${API}/api/calibrations`),
    authFetch(`${API}/api/device-health`),
    brandingPromise,
  ];
  if (hasRole("manager")) {
    calls.push(authFetch(`${API}/api/gateway-keys`));
    calls.push(authFetch(`${API}/api/audit-log?limit=100`));
    calls.push(authFetch(`${API}/api/notification-config`));
    calls.push(authFetch(`${API}/api/downtime-logs`));
    calls.push(authFetch(`${API}/api/downtime-logs/stats`));
    calls.push(authFetch(`${API}/api/scheduled-reports`));
    calls.push(authFetch(`${API}/api/dashboard-views`));
    calls.push(authFetch(`${API}/api/device-groups`));
    calls.push(authFetch(`${API}/api/batches`));
    calls.push(authFetch(`${API}/api/ai-insights`));
    calls.push(authFetch(`${API}/api/organizations`));
    calls.push(authFetch(`${API}/api/report-templates`));
    calls.push(authFetch(`${API}/api/integrations`));
  }
  if (hasRole("admin")) {
    calls.push(authFetch(`${API}/api/users`));
    calls.push(authFetch(`${API}/api/sso/providers`));
    calls.push(authFetch(`${API}/api/device-permissions`));
  }

  const results = await Promise.all(calls);
  let i = 0;
  devices = await results[i++].json();
  widgets = await results[i++].json();
  const alertData = await results[i++].json();
  activeAlerts = alertData.active;
  alertHistory = alertData.history;
  alertConfig = await results[i++].json();
  products = await results[i++].json();
  templates = await results[i++].json();
  maintenanceRecords = await results[i++].json();
  calibrationRecords = await results[i++].json();
  deviceHealthScores = await results[i++].json();
  branding = await results[i++].json();
  if (hasRole("manager")) {
    gatewayKeys = await results[i++].json();
    auditLog = await results[i++].json();
    notificationConfig = await results[i++].json();
    downtimeLogs = await results[i++].json();
    downtimeStats = await results[i++].json();
    scheduledReports = await results[i++].json();
    dashboardViews = await results[i++].json();
    if (dashboardViews.length && !currentDashboardViewId) {
      const def = dashboardViews.find(v => v.isDefault) || dashboardViews[0];
      currentDashboardViewId = def.id;
    }
    deviceGroups = await results[i++].json();
    batches = await results[i++].json();
    aiInsights = await results[i++].json();
    organizations = await results[i++].json();
    reportTemplates = await results[i++].json();
    integrations = await results[i++].json();
  }
  if (hasRole("admin")) {
    users = await results[i++].json();
    ssoProviders = await results[i++].json();
    devicePermissions = await results[i++].json();
  }
  applyBranding();
  initPushNotifications();
  render();
}

function applyBranding() {
  document.documentElement.style.setProperty("--accent", branding.accentColor || "#F2B705");
  document.title = `${branding.companyName || "Scale Ops"} Dashboard`;
}

async function saveBranding(payload) {
  try {
    const res = await authFetch(`${API}/api/branding`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast(body.error || "Failed to save branding", "error");
      return;
    }
    branding = await res.json();
    applyBranding();
    render();
    toast("Branding saved", "success");
  } catch (e) {
    toast("Failed to save branding: " + e.message, "error");
  }
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const token = getToken();
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);

  // Only re-render the dashboard on live WS data. All other views
  // (devices, alerts, products, etc.) have interactive forms/dropdowns
  // that get destroyed by a full re-render. Those views refresh on
  // navigation or explicit user action instead.
  const LIVE_VIEWS = new Set(["dashboard"]);
function liveRender() {
  if (LIVE_VIEWS.has(currentView)) {
    render();
    if (currentView === "dashboard") setTimeout(initDragDrop, 50);
  }
}

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "snapshot") {
      msg.devices.forEach(({ deviceId, reading, stats }) => {
        if (reading) { latestByDevice.set(deviceId, reading); readingsByDevice.set(deviceId, [reading]); }
        if (stats) statsByDevice.set(deviceId, stats);
      });
      if (msg.alerts) activeAlerts = msg.alerts;
      liveRender();
    } else if (msg.type === "reading") {
      latestByDevice.set(msg.deviceId, msg.reading);
      const hist = readingsByDevice.get(msg.deviceId) || [];
      hist.push(msg.reading);
      if (hist.length > 30) hist.shift();
      readingsByDevice.set(msg.deviceId, hist);
      liveRender();
    } else if (msg.type === "bag") {
      statsByDevice.set(msg.deviceId, msg.stats);
      if (msg.classification) classificationByDevice.set(msg.deviceId, msg.classification);
      liveRender();
    } else if (msg.type === "alert") {
      if (msg.action === "trigger") {
        activeAlerts = [msg.alert, ...activeAlerts.filter((a) => a.id !== msg.alert.id)];
      } else {
        activeAlerts = activeAlerts.filter((a) => !(a.deviceId === msg.alert.deviceId && a.type === msg.alert.type));
      }
      alertHistory = [msg.alert, ...alertHistory.filter((a) => a.id !== msg.alert.id)].slice(0, 50);
      // Patch alert badge + banner in-place without a full re-render
      const badge = document.getElementById("alert-badge");
      if (badge) {
        badge.textContent = activeAlerts.length || "";
        badge.style.display = activeAlerts.length ? "" : "none";
      }
      const banner = document.getElementById("alert-banner");
      if (banner) banner.innerHTML = renderAlertBannerInner();
    }
  };
  ws.onclose = (event) => {
    if (event.code === 4001) return;
    setTimeout(() => { if (getToken()) connectWs(); }, 2000);
  };
}

// ---------- API helpers ----------

async function addDevice(payload) {
  await authFetch(`${API}/api/devices`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  await loadInitial();
}

async function removeDevice(id) {
  try {
    await authFetch(`${API}/api/devices/${id}`, { method: "DELETE" });
    await loadInitial();
    toast("Device removed", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function resetDeviceStats(id) {
  if (!confirm("Reset give-away/loss stats for this device?")) return;
  try {
    await authFetch(`${API}/api/devices/${id}/reset-stats`, { method: "POST" });
    await loadInitial();
    toast("Stats reset", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function addWidget(payload) {
  try {
    const res = await authFetch(`${API}/api/widgets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast(body.error || "Failed to add widget", "error");
      return;
    }
    await loadInitial();
    toast("Widget added", "success");
  } catch (e) {
    toast("Failed to add widget: " + e.message, "error");
  }
}

async function removeWidget(id) {
  try {
    await authFetch(`${API}/api/widgets/${id}`, { method: "DELETE" });
    await loadInitial();
    toast("Widget removed", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function createGatewayKey() {
  const label = prompt("Label for this gateway key:", "gateway");
  if (label === null) return;
  try {
    const res = await authFetch(`${API}/api/gateway-keys`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: label || "gateway" }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    newlyCreatedKey = await res.json();
    await loadInitial();
    toast("Gateway key created — copy it now!", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function revokeGatewayKey(id) {
  if (!confirm("Revoke this gateway key?")) return;
  try {
    await authFetch(`${API}/api/gateway-keys/${id}`, { method: "DELETE" });
    await loadInitial();
    toast("Key revoked", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function saveAlertConfig(payload) {
  const res = await authFetch(`${API}/api/alert-config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  alertConfig = await res.json();
  render();
}

async function createUser() {
  const username = document.getElementById("u-username").value.trim();
  const password = document.getElementById("u-password").value;
  const role = document.getElementById("u-role").value;
  if (!username || !password) return;
  try {
    const res = await authFetch(`${API}/api/users`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password, role }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    await loadInitial();
    toast("User created", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function changeUserRole(id, role) {
  try {
    await authFetch(`${API}/api/users/${id}/role`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) });
    await loadInitial();
    toast("Role updated", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function deleteUser(id) {
  if (!confirm("Remove this user?")) return;
  try {
    await authFetch(`${API}/api/users/${id}`, { method: "DELETE" });
    await loadInitial();
    toast("User removed", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function downloadReport(path, filename) {
  try {
    const res = await authFetch(`${API}${path}`);
    if (!res.ok) { toast("Report generation failed", "error"); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    toast("Report downloaded", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function addScheduledReport() {
  const name = document.getElementById("sr-name").value.trim();
  const reportType = document.getElementById("sr-type").value;
  const schedule = document.getElementById("sr-schedule").value;
  const recipients = document.getElementById("sr-recipients").value.trim();
  if (!name || !recipients) { toast("Name and recipients required", "error"); return; }
  const cron = schedule === "weekly" ? "0 8 * * 1" : "0 8 * * *";
  try {
    const res = await authFetch(`${API}/api/scheduled-reports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, reportType, recipients, scheduleCron: cron }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    scheduledReports = await (await authFetch(`${API}/api/scheduled-reports`)).json();
    toast("Scheduled report created", "success");
    render();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function deleteScheduledReport(id) {
  if (!confirm("Delete this scheduled report?")) return;
  try {
    await authFetch(`${API}/api/scheduled-reports/${id}`, { method: "DELETE" });
    scheduledReports = scheduledReports.filter(r => r.id !== id);
    toast("Deleted", "success");
    render();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function runScheduledReport(id) {
  try {
    await authFetch(`${API}/api/scheduled-reports/${id}/run`, { method: "POST" });
    toast("Report sent", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function removeProduct(id) {
  if (!confirm("Delete this product?")) return;
  try {
    await authFetch(`${API}/api/products/${id}`, { method: "DELETE" });
    await loadInitial();
    toast("Product removed", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function toggleProductStatus(id, currentStatus) {
  try {
    await authFetch(`${API}/api/products/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: currentStatus === "active" ? "inactive" : "active" }) });
    await loadInitial();
    toast("Product status updated", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function removeMaintenanceRecord(id) {
  if (!confirm("Delete this maintenance record?")) return;
  try {
    await authFetch(`${API}/api/maintenance/${id}`, { method: "DELETE" });
    await loadInitial();
    toast("Record removed", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function updateMaintenanceStatus(id, status) {
  let extra = {};
  if (status === "COMPLETED") {
    const h = prompt("Labour hours:", "0");
    const d = prompt("Downtime minutes:", "0");
    extra = { labourHours: h || 0, downtimeMinutes: d || 0 };
  }
  try {
    await authFetch(`${API}/api/maintenance/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, ...extra }) });
    await loadInitial();
    toast("Status updated", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function removeCalibrationRecord(id) {
  if (!confirm("Delete this calibration record?")) return;
  try {
    await authFetch(`${API}/api/calibrations/${id}`, { method: "DELETE" });
    await loadInitial();
    toast("Record removed", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function removeTemplate(id) {
  if (!confirm("Delete this template?")) return;
  try {
    const res = await authFetch(`${API}/api/templates/${id}`, { method: "DELETE" });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    await loadInitial();
    toast("Template removed", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

// ---------- Sync ----------

async function loadSyncPanel() {
  const statusRes = await authFetch(`${API}/api/sync/status`);
  syncStatus = await statusRes.json();
  if (hasRole("admin")) {
    const keysRes = await authFetch(`${API}/api/sync-keys`);
    syncKeys = await keysRes.json();
  }
  render();
}

async function createSyncKey() {
  const siteId = prompt("Site ID (letters/numbers/hyphens):");
  if (!siteId) return;
  const siteLabel = prompt("Display label:", siteId) || siteId;
  try {
    const res = await authFetch(`${API}/api/sync-keys`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ siteId, siteLabel }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    newlyCreatedSyncKey = await res.json();
    await loadSyncPanel();
    toast("Sync key created — copy it now!", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function revokeSyncKey(id) {
  if (!confirm("Revoke this sync key?")) return;
  try {
    await authFetch(`${API}/api/sync-keys/${id}`, { method: "DELETE" });
    await loadSyncPanel();
    toast("Sync key revoked", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

// ---------- Engineering ----------

async function selectEngineeringDevice(deviceId) {
  engineeringDeviceId = deviceId;
  engineeringData = { raw: null, testConn: null, testDp: null, commLog: [], protocolConfig: null };
  if (!deviceId) { render(); return; }
  const [rawRes, logRes, cfgRes] = await Promise.all([
    authFetch(`${API}/api/engineering/devices/${deviceId}/raw`),
    authFetch(`${API}/api/engineering/devices/${deviceId}/comm-log?limit=20`),
    authFetch(`${API}/api/engineering/devices/${deviceId}/protocol-config`),
  ]);
  engineeringData.raw = await rawRes.json();
  engineeringData.commLog = await logRes.json();
  engineeringData.protocolConfig = await cfgRes.json();
  render();
}

async function runEngineeringTestConnection() {
  if (!engineeringDeviceId) return;
  engineeringData.testConn = { loading: true }; render();
  const res = await authFetch(`${API}/api/engineering/devices/${engineeringDeviceId}/test-connection`, { method: "POST" });
  engineeringData.testConn = await res.json();
  const logRes = await authFetch(`${API}/api/engineering/devices/${engineeringDeviceId}/comm-log?limit=20`);
  engineeringData.commLog = await logRes.json();
  render();
}

async function runEngineeringTestDatapoint() {
  if (!engineeringDeviceId) return;
  engineeringData.testDp = { loading: true }; render();
  const res = await authFetch(`${API}/api/engineering/devices/${engineeringDeviceId}/test-datapoint`, { method: "POST" });
  engineeringData.testDp = await res.json();
  const logRes = await authFetch(`${API}/api/engineering/devices/${engineeringDeviceId}/comm-log?limit=20`);
  engineeringData.commLog = await logRes.json();
  render();
}

async function saveEngineeringConfig() {
  if (!engineeringDeviceId || !hasRole("admin")) return;
  let parsed;
  try { parsed = JSON.parse(document.getElementById("eng-config-json").value); } catch { toast("Invalid JSON.", "error"); return; }
  if (!confirm("Change live protocol/register configuration?")) return;
  try {
    const res = await authFetch(`${API}/api/engineering/devices/${engineeringDeviceId}/protocol-config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true, connectionConfig: parsed }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    await selectEngineeringDevice(engineeringDeviceId);
    await loadInitial();
    toast("Configuration saved", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

// ---------- Password ----------

async function submitPasswordChange() {
  const cp = document.getElementById("pw-current")?.value;
  const np = document.getElementById("pw-new")?.value;
  if (!cp || !np) { toast("Both fields required.", "error"); return; }
  if (np.length < 6) { toast("Min 6 characters.", "error"); return; }
  try {
    const res = await authFetch(`${API}/api/auth/change-password`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: cp, newPassword: np }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    showPasswordChange = false;
    toast("Password changed", "success");
    render();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

// ---------- Wizard ----------

function openWizard() {
  wizardData = { name: "", ip: "", protocol: "Modbus TCP", templateId: "", productId: "", target: 25, unit: "kg", costPerUnit: 0, port: 502, registerMap: {}, pollingMs: 500, connResult: null, dpResult: null, createdDevice: null };
  wizardStep = 1; wizardOpen = true; render();
}
function closeWizard() { wizardOpen = false; render(); }
function wizardNext() {
  if (wizardStep === 1 && (!wizardData.name || !wizardData.ip)) { alert("Name and IP required."); return; }
  if (wizardStep === 4) wizardCaptureRegisterMap();
  wizardStep++; render();
}
function wizardBack() { wizardStep--; render(); }
function wizardSelectProduct(id) {
  wizardData.productId = id;
  const p = products.find((pp) => pp.id === id);
  if (p) { wizardData.target = p.targetWeight; wizardData.unit = p.unit; }
  render();
}
function wizardApplyTemplate(templateId) {
  wizardData.templateId = templateId;
  const t = templates.find((tt) => tt.id === templateId);
  if (t) { wizardData.protocol = t.protocol; wizardData.port = t.port; wizardData.registerMap = JSON.parse(JSON.stringify(t.registerMap || {})); wizardData.pollingMs = t.pollingMs; wizardData.unit = t.unit; }
  render();
}
function wizardSetProtocolManually(protocol) { wizardData.protocol = protocol; wizardData.templateId = ""; render(); }

function wizardCaptureRegisterMap() {
  const a = document.getElementById("wz-dp-a")?.value.trim() || "";
  const b = document.getElementById("wz-dp-b")?.value.trim() || "";
  const p = wizardData.protocol;
  if (p === "Modbus TCP") wizardData.registerMap = { weight: { register: a, dataType: b || "Float32" } };
  else if (p === "OPC-UA") wizardData.registerMap = { weight: { nodeId: a, dataType: b || "Float32" } };
  else if (p === "REST API") wizardData.registerMap = { weight: { path: a, jsonField: b } };
  else wizardData.registerMap = { weight: { topic: a, dataType: b || "Float32" } };
}

async function wizardTestConnection() {
  wizardData.connResult = { loading: true }; render();
  const res = await authFetch(`${API}/api/engineering/test-connection`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ip: wizardData.ip, protocol: wizardData.protocol, port: wizardData.port }) });
  wizardData.connResult = await res.json(); render();
}

async function wizardTestDatapoint() {
  wizardCaptureRegisterMap();
  wizardData.dpResult = { loading: true }; render();
  const res = await authFetch(`${API}/api/engineering/test-datapoint`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registerMap: wizardData.registerMap, unit: wizardData.unit }) });
  wizardData.dpResult = await res.json(); render();
}

async function wizardActivate() {
  const productId = document.getElementById("wz-product")?.value || wizardData.productId;
  const costPerUnit = parseFloat(document.getElementById("wz-cost")?.value) || 0;
  try {
    const res = await authFetch(`${API}/api/devices`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: wizardData.name, ip: wizardData.ip, protocol: wizardData.protocol, target: Number(wizardData.target) || 25, unit: wizardData.unit, costPerUnit, productId: productId || null, connectionConfig: { port: wizardData.port, registerMap: wizardData.registerMap, pollingMs: wizardData.pollingMs } }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed to activate", "error"); return; }
    wizardData.createdDevice = await res.json();
    wizardStep = 8; render(); await loadInitial();
    toast("Device activated", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

// ---------- Forms ----------

async function submitProductForm() {
  const code = document.getElementById("pf-code").value.trim();
  const name = document.getElementById("pf-name").value.trim();
  const desc = document.getElementById("pf-desc")?.value.trim() || "";
  const targetWeight = parseFloat(document.getElementById("pf-target").value);
  const toleranceType = document.getElementById("pf-tol-type").value;
  const toleranceValue = parseFloat(document.getElementById("pf-tol-value").value);
  const unit = document.getElementById("pf-unit").value.trim() || "kg";
  const status = document.getElementById("pf-status").value;
  if (!code || !name || isNaN(targetWeight) || isNaN(toleranceValue)) { toast("Code, name, target, and tolerance required.", "error"); return; }
  try {
    const res = await authFetch(`${API}/api/products`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name, description: desc, targetWeight, toleranceType, toleranceValue, unit, status }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    await loadInitial();
    toast("Product added", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function submitMaintenanceForm() {
  const deviceId = document.getElementById("mf-device").value;
  const dueDate = document.getElementById("mf-due").value;
  const intervalDays = document.getElementById("mf-interval").value;
  const technician = document.getElementById("mf-tech").value.trim();
  const notes = document.getElementById("mf-notes").value.trim();
  if (!deviceId) return;
  try {
    const res = await authFetch(`${API}/api/maintenance`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId, status: "SCHEDULED", dueDate: dueDate ? new Date(dueDate).toISOString() : null, intervalDays: intervalDays || null, technician, notes }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    await loadInitial();
    toast("Maintenance scheduled", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function submitCalibrationForm() {
  const deviceId = document.getElementById("cf-device").value;
  const calibrationDate = document.getElementById("cf-date").value;
  const nextCalibrationDate = document.getElementById("cf-next").value;
  const certificateNumber = document.getElementById("cf-cert").value.trim();
  const calibrationCompany = document.getElementById("cf-company").value.trim();
  const technician = document.getElementById("cf-tech").value.trim();
  const referenceWeight = parseFloat(document.getElementById("cf-ref").value);
  const actualWeight = parseFloat(document.getElementById("cf-actual").value);
  if (!deviceId || isNaN(referenceWeight) || isNaN(actualWeight)) { toast("Device, reference, and actual weight required.", "error"); return; }
  try {
    const res = await authFetch(`${API}/api/calibrations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId, calibrationDate: calibrationDate ? new Date(calibrationDate).toISOString() : new Date().toISOString(), nextCalibrationDate: nextCalibrationDate ? new Date(nextCalibrationDate).toISOString() : null, certificateNumber, calibrationCompany, technician, referenceWeight, actualWeight }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    await loadInitial();
    toast("Calibration logged", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

// ---------- Helpers ----------

function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function timeAgo(iso) {
  if (!iso) return "—";
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function sparklineSvg(history, target) {
  const w = 240, h = 64;
  const values = history.map((r) => r.weight);
  const max = Math.max(target * 1.1, ...values, 1);
  const pts = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * w},${h - (v / max) * h}`).join(" ");
  const targetY = h - (target / max) * h;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
    <line x1="0" y1="${targetY}" x2="${w}" y2="${targetY}" stroke="#3A4552" stroke-dasharray="3,3" stroke-width="1" />
    <polyline points="${pts}" fill="none" stroke="#4FD1B5" stroke-width="2" />
  </svg>`;
}

// ---------- Navigation ----------

function navigate(view) {
  currentView = view;
  // Remove existing main so the next render() does a full rebuild
  // (updates sidebar active state, alert badge, etc.)
  const main = document.getElementById("main-content");
  if (main) main.removeAttribute("id");
  if (view === "sync") loadSyncPanel();
  else if (view === "spc") { loadSPCData(); }
  else if (view === "oee") { loadOEE(); }
  else if (view === "dashboard") { render(); setTimeout(initDragDrop, 50); }
  else render();
}

// ============================================================
// RENDERING
// ============================================================

function renderLogin(message = "") {
  loginError = message;
  document.getElementById("app").innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0F1218;">
      <div class="form-card" style="width:360px;">
        <div style="text-align:center;margin-bottom:20px;">
          ${branding.logoUrl ? `<img src="${esc(branding.logoUrl)}" style="height:36px;margin-bottom:8px;" />` : ""}
          <div class="mono" style="font-size:10px;color:var(--accent,#F2B705);text-transform:uppercase;letter-spacing:0.12em;">${esc(branding.tagline)}</div>
          <h1 style="font-size:18px;margin-top:4px;">${esc(branding.companyName)} Dashboard</h1>
        </div>
        <div style="margin-bottom:12px;">
          <label>Username</label>
          <input id="login-username" autocomplete="username" />
        </div>
        <div style="margin-bottom:16px;">
          <label>Password</label>
          <input id="login-password" type="password" autocomplete="current-password" onkeydown="if(event.key==='Enter')submitLogin()" />
        </div>
        ${loginError ? `<div style="color:#E5484D;font-size:12px;margin-bottom:10px;">${esc(loginError)}</div>` : ""}
        <button class="btn btn-primary" style="width:100%;justify-content:center;" onclick="submitLogin()">Log in</button>
      </div>
    </div>`;
}

async function submitLogin() {
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;
  const twoFactorCode = document.getElementById("login-2fa")?.value.trim();
  try {
    const result = await login(username, password, twoFactorCode);
    if (result.requires2FA) {
      renderLogin2FA(result.username);
      return;
    }
    await loadInitial(); connectWs();
  } catch (err) { renderLogin(err.message); }
}

function renderLogin2FA(username) {
  document.getElementById("app").innerHTML = `
    <div class="login-page">
      <div class="login-card">
        <div class="login-header">
          <div class="eyebrow">${esc(branding.tagline)}</div>
          <h1>${esc(branding.companyName)}</h1>
          <p style="color:var(--muted);margin-top:6px;">Two-factor authentication</p>
        </div>
        <div class="login-form">
          <div id="login-error" style="color:#E5484D;margin-bottom:10px;"></div>
          <div><label>6-digit code from your authenticator app</label><input id="login-2fa" type="text" inputmode="numeric" maxlength="6" style="width:100%;text-align:center;font-size:24px;letter-spacing:8px;" /></div>
          <button class="btn btn-primary" style="width:100%;margin-top:12px;" onclick="submitLogin2FA('${esc(username)}')">Verify</button>
          <button class="btn" style="width:100%;margin-top:8px;" onclick="renderLogin()">Back to login</button>
        </div>
      </div>
    </div>`;
  document.getElementById("login-2fa").focus();
}

async function submitLogin2FA(username) {
  const password = sessionStorage.getItem("pendingLoginPassword") || "";
  const code = document.getElementById("login-2fa").value.trim();
  try {
    const result = await login(username, password, code);
    if (result.requires2FA) {
      document.getElementById("login-error").textContent = "Still requires 2FA";
      return;
    }
    await loadInitial(); connectWs();
  } catch (err) {
    const el = document.getElementById("login-error");
    if (el) el.textContent = err.message;
  }
}

function render() {
  const app = document.getElementById("app");
  const alertCount = activeAlerts.length;

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: "▦" },
    { id: "devices", label: "Devices", icon: "⚙" },
    { id: "products", label: "Products", icon: "⬡" },
    { id: "maintenance", label: "Maintenance", icon: " wrench" },
    { id: "calibration", label: "Calibration", icon: "⚖" },
    { id: "reports", label: "Reports", icon: "◫" },
    { id: "spc", label: "SPC", icon: ".defer" },
    { id: "oee", label: "OEE", icon: "◎" },
    { id: "schedule", label: "Schedule", icon: "▤" },
    { id: "alerts", label: "Alerts", icon: "⚠", badge: alertCount || null },
  ];

  const adminItems = [];
  if (hasRole("manager")) {
    adminItems.push(
      { id: "gateway-keys", label: "Gateway Keys", icon: "⚷" },
      { id: "templates", label: "Templates", icon: "☰" },
      { id: "branding", label: "Branding", icon: "◉" },
      { id: "notifications", label: "Notifications", icon: "✉" },
      { id: "downtime", label: "Downtime", icon: "⏱" },
      { id: "device-groups", label: "Groups", icon: "⊞" },
      { id: "engineering", label: "Engineering", icon: "⚡", danger: true },
      { id: "sync", label: "Sync", icon: "↻" },
      { id: "audit", label: "Audit Log", icon: "≡" },
    );
  }
  if (hasRole("admin")) {
    adminItems.push({ id: "users", label: "Users", icon: "☺" });
    adminItems.push({ id: "sso", label: "SSO / SAML", icon: "🔑" });
    adminItems.push({ id: "organizations", label: "Organizations", icon: "🏢" });
  }
  if (hasRole("manager")) {
    adminItems.push({ id: "batches", label: "Batches", icon: "📦" });
    adminItems.push({ id: "ai-insights", label: "AI Insights", icon: "🤖" });
    adminItems.push({ id: "report-builder", label: "Report Builder", icon: "📋" });
    adminItems.push({ id: "integrations", label: "Integrations", icon: "🔗" });
    adminItems.push({ id: "api-usage", label: "API Usage", icon: "📊" });
  }

  // If sidebar already exists, just update the main content + alert badge.
  // This prevents the sidebar (and any open picker/dialog) from being
  // destroyed on every WS tick.
  const existingMain = document.getElementById("main-content");
  if (existingMain) {
    const banner = document.getElementById("alert-banner");
    if (banner) banner.innerHTML = renderAlertBannerInner();
    existingMain.innerHTML = (wizardOpen ? renderWizard() : "") + (showPasswordChange ? renderPasswordChange() : "") + renderView();
    // Update alert badge in sidebar
    const badge = document.getElementById("alert-badge");
    if (badge) {
      badge.textContent = alertCount || "";
      badge.style.display = alertCount ? "" : "none";
    }
    return;
  }

  // Full render (first time, after login, after logout, or navigation
  // that needs the sidebar rebuilt — e.g. role change)
  app.innerHTML = `
    <div class="mobile-header">
      <button class="hamburger" onclick="toggleMobileSidebar()">☰</button>
      <h1>${esc(branding.companyName)}</h1>
    </div>
    <div class="sidebar-overlay" id="sidebar-overlay" onclick="toggleMobileSidebar()"></div>
    <div class="layout">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-brand">
          ${branding.logoUrl ? `<img src="${esc(branding.logoUrl)}" alt="logo" />` : ""}
          <div class="eyebrow">${esc(branding.tagline)}</div>
          <h1>${esc(branding.companyName)}</h1>
        </div>
        <nav class="sidebar-nav">
          <div class="nav-section">
            ${navItems.map(n => `
              <button class="nav-item ${currentView === n.id ? 'active' : ''} ${n.danger ? 'danger' : ''}" onclick="navigate('${n.id}')">
                <span class="nav-icon">${n.icon}</span>
                ${n.label}
                ${n.badge ? `<span class="nav-badge" id="alert-badge">${n.badge}</span>` : (n.id === "alerts" ? `<span class="nav-badge" id="alert-badge" style="display:none;"></span>` : "")}
              </button>
            `).join("")}
          </div>
          ${adminItems.length ? `
          <div class="nav-section">
            <div class="nav-section-label">Admin</div>
            ${adminItems.map(n => `
              <button class="nav-item ${currentView === n.id ? 'active' : ''} ${n.danger ? 'danger' : ''}" onclick="navigate('${n.id}')">
                <span class="nav-icon">${n.icon}</span>
                ${n.label}
              </button>
            `).join("")}
          </div>` : ""}
        </nav>
        <div class="sidebar-footer">
          <div style="margin-bottom:8px;">
            <select onchange="setLanguage(this.value)" style="width:100%;padding:4px 8px;border-radius:4px;background:#1B2129;color:#E8EAED;border:1px solid #2A333D;font-size:12px;">
              ${getLanguages().map(l => `<option value="${l}" ${l === currentLang ? "selected" : ""}>${l.toUpperCase()}</option>`).join("")}
            </select>
          </div>
          <div class="user-info">
            <span>${esc(currentUser?.username)}</span>
            <span class="user-role">${currentUser?.role}</span>
          </div>
          <button class="logout-btn" onclick="logout()">Log out</button>
        </div>
      </aside>
      <main class="main" id="main-content">
        <div id="alert-banner">${renderAlertBanner()}</div>
        ${wizardOpen ? renderWizard() : ""}
        ${showPasswordChange ? renderPasswordChange() : ""}
        ${renderView()}
      </main>
    </div>`;
}

function toggleMobileSidebar() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  if (sidebar) sidebar.classList.toggle("open");
  if (overlay) overlay.classList.toggle("open");
}

function renderAlertBanner() {
  if (activeAlerts.length === 0) return "";
  return `<div class="alert-banner">${renderAlertBannerInner()}</div>`;
}

function renderAlertBannerInner() {
  return activeAlerts.map(a => `
    <div class="alert-item ${a.severity}">
      <span class="alert-dot"></span>
      <span class="alert-msg">${esc(a.message)}</span>
      <span class="alert-time">${timeAgo(a.since)}</span>
    </div>`).join("");
}

function renderPasswordChange() {
  const faEnabled = currentUser?.twoFactorEnabled;
  return `<div class="form-card">
    <div class="section-label mono" style="margin-bottom:12px;">Change password</div>
    <div class="form-grid" style="grid-template-columns:1fr 1fr auto;">
      <div><label>Current password</label><input id="pw-current" type="password" /></div>
      <div><label>New password (min 6)</label><input id="pw-new" type="password" /></div>
      <div style="display:flex;gap:8px;align-items:end;">
        <button class="btn btn-primary" onclick="submitPasswordChange()">Change</button>
        <button class="btn" onclick="showPasswordChange=false;render()">Cancel</button>
      </div>
    </div>
  </div>
  <div class="form-card" style="margin-top:16px;">
    <div class="section-label mono" style="margin-bottom:12px;">Two-factor authentication (2FA)</div>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
      <span class="status-badge ${faEnabled ? 'active' : 'inactive'}">${faEnabled ? 'Enabled' : 'Disabled'}</span>
    </div>
    ${faEnabled
      ? `<button class="btn btn-danger" onclick="disable2FA()">Disable 2FA</button>`
      : `<button class="btn btn-primary" onclick="setup2FA()">Set up 2FA</button>`}
    <div id="2fa-setup-area"></div>
  </div>`;
}

async function setup2FA() {
  try {
    const res = await authFetch(`${API}/api/auth/2fa/setup`, { method: "POST" });
    const data = await res.json();
    document.getElementById("2fa-setup-area").innerHTML = `
      <div style="margin-top:16px;">
        <p style="font-size:13px;color:var(--muted);margin-bottom:12px;">Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.)</p>
        <div style="background:#fff;padding:16px;border-radius:8px;display:inline-block;"><img src="${data.qr}" width="200" height="200" /></div>
        <div style="margin-top:12px;"><label>Enter the 6-digit code to verify</label><input id="2fa-verify-code" type="text" inputmode="numeric" maxlength="6" style="width:200px;text-align:center;font-size:20px;letter-spacing:6px;" /></div>
        <button class="btn btn-primary" style="margin-top:8px;" onclick="verify2FA()">Verify & enable</button>
      </div>`;
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function verify2FA() {
  const code = document.getElementById("2fa-verify-code").value.trim();
  try {
    const res = await authFetch(`${API}/api/auth/2fa/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Invalid code", "error"); return; }
    currentUser.twoFactorEnabled = true;
    toast("2FA enabled", "success");
    showPasswordChange = false;
    render();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function disable2FA() {
  const password = prompt("Enter your password to disable 2FA:");
  if (!password) return;
  try {
    const res = await authFetch(`${API}/api/auth/2fa/disable`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    currentUser.twoFactorEnabled = false;
    toast("2FA disabled", "success");
    showPasswordChange = false;
    render();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

// ---------- View router ----------

function renderView() {
  switch (currentView) {
    case "dashboard": return viewDashboard();
    case "devices": return viewDevices();
    case "products": return viewProducts();
    case "maintenance": return viewMaintenance();
    case "calibration": return viewCalibration();
    case "reports": return viewReports();
    case "alerts": return viewAlerts();
    case "gateway-keys": return viewGatewayKeys();
    case "templates": return viewTemplates();
    case "branding": return viewBranding();
    case "notifications": return viewNotifications();
    case "downtime": return viewDowntime();
    case "device-groups": return viewDeviceGroups();
    case "spc": return viewSPC();
    case "oee": return viewOEE();
    case "schedule": return viewSchedule();
    case "engineering": return viewEngineering();
    case "sync": return viewSync();
    case "audit": return viewAudit();
    case "users": return viewUsers();
    case "sso": return viewSSO();
    case "device-perms": return viewDevicePermissions(permUserId);
    case "batches": return viewBatches();
    case "ai-insights": return viewAIInsights();
    case "organizations": return viewOrganizations();
    case "report-builder": return viewReportBuilder();
    case "integrations": return viewIntegrations();
    case "api-usage": return viewAPIUsage();
    default: return viewDashboard();
  }
}

// ---------- Dashboard ----------

function viewDashboard() {
  const currentViewData = dashboardViews.find(v => v.id === currentDashboardViewId);
  return `
    <div class="top-bar">
      <div>
        <h2>Dashboard</h2>
        <div class="subtitle">${devices.length} device${devices.length !== 1 ? "s" : ""} connected</div>
      </div>
      <div class="top-bar-actions">
        ${hasRole("manager") ? `<button class="btn" onclick="openWizard()">+ Add device</button>` : ""}
        ${hasRole("manager") ? `<button class="btn btn-primary" onclick="currentView='devices';render()">+ Add widget</button>` : ""}
        <button class="btn" onclick="showPasswordChange=true;render()">Change password</button>
      </div>
    </div>
    ${dashboardViews.length > 0 ? `
    <div style="display:flex;gap:8px;margin-bottom:16px;align-items:center;flex-wrap:wrap;">
      ${dashboardViews.map(v => `
        <button class="btn ${v.id === currentDashboardViewId ? 'btn-primary' : ''}" onclick="switchDashboardView('${v.id}')" style="font-size:13px;">
          ${esc(v.name)}${v.isDefault ? ' (default)' : ''}
        </button>`).join("")}
      ${hasRole("manager") ? `
        <button class="btn btn-sm" onclick="createDashboardView()">+ New view</button>
        ${currentViewData && !currentViewData.isDefault ? `<button class="btn btn-sm btn-danger" onclick="deleteDashboardView('${currentDashboardViewId}')">Delete view</button>` : ""}
      ` : ""}
    </div>` : ""}
    <div class="section-label mono">Widgets</div>
    <div class="widget-grid" id="widget-grid">
      ${widgets.map(w => renderWidget(w)).join("") || `<div class="empty" style="grid-column:1/-1;">No widgets yet. Go to Devices to add one.</div>`}
    </div>`;
}

async function switchDashboardView(viewId) {
  currentDashboardViewId = viewId;
  // Load widgets for this view
  try {
    const res = await authFetch(`${API}/api/dashboard-views/${viewId}/widgets`);
    widgets = await res.json();
    render();
  } catch (e) { console.error("Failed to load dashboard view:", e); }
}

async function createDashboardView() {
  const name = prompt("Dashboard view name:");
  if (!name) return;
  try {
    const res = await authFetch(`${API}/api/dashboard-views`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    const view = await res.json();
    dashboardViews.push(view);
    currentDashboardViewId = view.id;
    widgets = [];
    toast("View created", "success");
    render();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function deleteDashboardView(viewId) {
  if (!confirm("Delete this dashboard view?")) return;
  try {
    await authFetch(`${API}/api/dashboard-views/${viewId}`, { method: "DELETE" });
    dashboardViews = dashboardViews.filter(v => v.id !== viewId);
    if (currentDashboardViewId === viewId) {
      const def = dashboardViews.find(v => v.isDefault) || dashboardViews[0];
      currentDashboardViewId = def?.id || "";
      if (currentDashboardViewId) await switchDashboardView(currentDashboardViewId);
      else { widgets = []; render(); }
    }
    toast("View deleted", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

function initDragDrop() {
  const grid = document.getElementById("widget-grid");
  if (!grid) return;
  let draggedEl = null;
  grid.querySelectorAll(".widget").forEach(w => {
    w.draggable = true;
    w.addEventListener("dragstart", (e) => { draggedEl = w; w.style.opacity = "0.4"; e.dataTransfer.effectAllowed = "move"; });
    w.addEventListener("dragend", () => { if (draggedEl) draggedEl.style.opacity = "1"; draggedEl = null; });
    w.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
    w.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!draggedEl || draggedEl === w) return;
      const parent = w.parentNode;
      const children = [...parent.children];
      const fromIdx = children.indexOf(draggedEl);
      const toIdx = children.indexOf(w);
      if (fromIdx < toIdx) parent.insertBefore(draggedEl, w.nextSibling);
      else parent.insertBefore(draggedEl, w);
      // Save new order
      const newOrder = [...parent.children].map(el => el.dataset.widgetId).filter(Boolean);
      if (newOrder.length) authFetch(`${API}/api/dashboard-views/${currentDashboardViewId}/reorder`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ widgetIds: newOrder }) });
    });
  });
}

function renderWidget(widget) {
  const device = devices.find(d => d.id === widget.deviceId);
  if (!device) return "";
  const reading = latestByDevice.get(device.id);
  const connected = reading ? reading.connected : false;
  const metric = METRICS.find(m => m.id === widget.metric);
  let body = "";

  if (widget.metric === "live_weight") {
    body = `<div style="display:flex;align-items:baseline;gap:8px;margin-top:4px;">
      <span class="big-number">${reading ? reading.weight.toFixed(2) : "—"}</span>
      <span style="font-size:13px;color:#5B6673;">${device.unit}</span>
    </div>
    <div class="widget-footer">
      <span>target ${device.target.toFixed(2)}${device.unit}</span>
      <span class="${connected ? "status-live" : "status-off"}">${connected ? "● LIVE" : "● OFFLINE"}</span>
    </div>`;
  } else if (widget.metric === "trend") {
    const hist = readingsByDevice.get(device.id) || [];
    body = `${sparklineSvg(hist, device.target)}
      <div style="font-size:11px;color:#5B6673;" class="mono">last ${hist.length} readings</div>`;
  } else if (widget.metric === "bag_count") {
    body = `<div class="big-number" style="color:#E8EAED;">${reading ? reading.bagCount : "—"}</div>
      <div class="widget-footer"><span>bags filled</span></div>`;
  } else if (widget.metric === "deviation") {
    const dev = reading ? (((reading.weight - device.target) / device.target) * 100) : null;
    const good = dev !== null && Math.abs(dev) < 1.5;
    body = `<div class="big-number" style="color:${dev === null ? "#E8EAED" : good ? "#4FD1B5" : "#E5484D"};font-size:34px;">
      ${dev === null ? "—" : `${dev >= 0 ? "+" : ""}${dev.toFixed(2)}%`}
    </div><div class="widget-footer"><span>vs target</span></div>`;
  } else if (widget.metric === "giveaway") {
    const stats = statsByDevice.get(device.id) || { totalBags: 0, totalOverKg: 0, totalUnderKg: 0, totalCost: 0 };
    body = `<div class="big-number" style="font-size:30px;">${stats.totalOverKg.toFixed(2)}${device.unit}</div>
      <div style="font-size:11px;color:#5B6673;" class="mono">overfill across ${stats.totalBags} bag${stats.totalBags !== 1 ? "s" : ""}</div>
      <div class="widget-footer"><span>under: ${stats.totalUnderKg.toFixed(2)}${device.unit}</span><span>cost: ${stats.totalCost.toFixed(2)}</span></div>`;
  } else if (widget.metric === "classification") {
    const cls = classificationByDevice.get(device.id);
    const product = device.productId ? products.find(p => p.id === device.productId) : null;
    const color = cls === "PASS" ? "#4FD1B5" : cls === "UNDER" ? "#F2B705" : cls === "OVER" ? "#E5484D" : "#5B6673";
    const stats = statsByDevice.get(device.id) || { countUnder: 0, countPass: 0, countOver: 0 };
    body = `<div class="big-number" style="font-size:32px;color:${color};">${cls || "—"}</div>
      <div style="font-size:11px;color:#5B6673;" class="mono">${product ? `vs ${esc(product.name)}` : "no product"}</div>
      <div class="widget-footer"><span>U:${stats.countUnder||0}</span><span>P:${stats.countPass||0}</span><span>O:${stats.countOver||0}</span></div>`;
  }

  return `<div class="widget" data-widget-id="${widget.id}">
    ${hasRole("manager") ? `<button class="widget-remove" onclick="removeWidget('${widget.id}')">✕</button>` : ""}
    <div class="widget-metric">${metric.label}</div>
    <div class="widget-device">${esc(device.name)}</div>
    ${body}
  </div>`;
}

// ---------- Devices ----------

function viewDevices() {
  return `
    <div class="top-bar">
      <div>
        <h2>Devices</h2>
        <div class="subtitle">${devices.length} registered</div>
      </div>
      <div class="top-bar-actions">
        ${hasRole("manager") ? `<button class="btn" onclick="loadDeviceHealthScores();render()">Refresh Health</button>` : ""}
        ${hasRole("manager") ? `<button class="btn btn-primary" onclick="openWizard()">+ Add device</button>` : ""}
        ${hasRole("manager") ? `<button class="btn" onclick="currentView='dashboard';render()">+ Add widget</button>` : ""}
      </div>
    </div>
    <div class="device-row">
      ${devices.map(d => {
        const r = latestByDevice.get(d.id);
        const connected = r ? r.connected : false;
        const product = d.productId ? products.find(p => p.id === d.productId) : null;
        const health = deviceHealthScores.find(h => h.deviceId === d.id);
        const healthColor = health ? (health.status === "healthy" ? "#4FD1B5" : health.status === "warning" ? "#F2B705" : "#E5484D") : "#5B6673";
        return `<div class="device-chip">
          <span class="dot ${connected ? "dot-live" : "dot-off"}"></span>
          <span>${esc(d.name)}</span>
          ${health ? `<span style="display:inline-flex;align-items:center;gap:3px;font-size:11px;font-weight:600;color:${healthColor};"><span style="width:8px;height:8px;border-radius:50%;background:${healthColor};display:inline-block;"></span>${health.healthScore}%</span>` : ""}
          <span class="mono" style="color:#5B6673;">${esc(d.ip)}</span>
          <span style="color:#5B6673;">·</span>
          <span class="mono" style="color:#8B95A1;">${esc(d.protocol)}</span>
          ${product ? `<span style="color:var(--accent);">· ${esc(product.name)}</span>` : ""}
          ${hasRole("manager") ? `<button class="chip-remove" onclick="resetDeviceStats('${d.id}')" title="Reset stats">Reset</button>` : ""}
          ${hasRole("manager") ? `<button class="chip-remove" onclick="removeDevice('${d.id}')">✕</button>` : ""}
        </div>`;
      }).join("") || `<div class="empty">No devices yet.</div>`}
    </div>
    <div class="section-label mono" style="margin-top:20px;">Add widget for a device</div>
    ${hasRole("manager") ? `
    <div class="form-card">
      <div class="form-grid" style="grid-template-columns:1.2fr 1fr auto;">
        <div><label>Device</label><select id="wf-device">${devices.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}</select></div>
        <div><label>Analytic</label><select id="wf-metric">${METRICS.map(m => `<option value="${m.id}">${m.label}</option>`).join("")}</select></div>
        <button class="btn btn-primary" onclick="submitWidgetForm()">Add widget</button>
      </div>
    </div>` : `<div class="empty">Manager role required to add widgets.</div>`}
  `;
}

function submitWidgetForm() {
  const deviceId = document.getElementById("wf-device").value;
  const metric = document.getElementById("wf-metric").value;
  if (!deviceId) return;
  addWidget({ deviceId, metric });
}

// ---------- Products ----------

function viewProducts() {
  return `
    <div class="top-bar">
      <div><h2>Products</h2><div class="subtitle">${products.length} defined</div></div>
    </div>
    ${hasRole("manager") ? `
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">Add product</div>
      <div class="form-grid" style="grid-template-columns:0.8fr 1fr 0.7fr 0.7fr 0.9fr auto;">
        <div><label>Code</label><input id="pf-code" placeholder="BAG25" /></div>
        <div><label>Name</label><input id="pf-name" placeholder="25kg Bag" /></div>
        <div><label>Target</label><input id="pf-target" placeholder="25" /></div>
        <div><label>Tolerance</label><input id="pf-tol-value" placeholder="0.2" /></div>
        <div><label>Type</label><select id="pf-tol-type"><option value="absolute">Absolute ±kg</option><option value="percentage">Percentage ±%</option></select></div>
        <button class="btn btn-primary" onclick="submitProductForm()">+ Add</button>
      </div>
      <div class="form-grid" style="grid-template-columns:0.7fr 0.8fr;margin-top:8px;">
        <div><label>Unit</label><input id="pf-unit" value="kg" /></div>
        <div><label>Status</label><select id="pf-status"><option value="active">active</option><option value="inactive">inactive</option><option value="draft">draft</option></select></div>
      </div>
    </div>` : ""}
    <div class="form-card">
      <div class="list-header"><span>Code</span><span style="flex:2;">Name</span><span>Target</span><span>Range</span><span>Status</span><span></span></div>
      ${products.map(p => `
        <div class="list-row">
          <span class="list-cell mono">${esc(p.code)}</span>
          <span class="list-cell" style="flex:2;">${esc(p.name)}</span>
          <span class="list-cell mono">${p.targetWeight}${p.unit}</span>
          <span class="list-cell mono">${p.minWeight.toFixed(2)}–${p.maxWeight.toFixed(2)}</span>
          <span class="list-cell"><span class="status-badge ${p.status}">${p.status}</span></span>
          <span class="list-cell sm">
            ${hasRole("manager") ? `<button class="btn btn-sm" onclick="toggleProductStatus('${p.id}','${p.status}')">Toggle</button>` : ""}
            ${hasRole("manager") ? `<button class="btn btn-sm btn-danger" onclick="removeProduct('${p.id}')">✕</button>` : ""}
          </span>
        </div>`).join("") || `<div class="empty">No products.</div>`}
    </div>`;
}

// ---------- Maintenance ----------

function viewMaintenance() {
  return `
    <div class="top-bar">
      <div><h2>Maintenance</h2><div class="subtitle">${maintenanceRecords.length} records</div></div>
    </div>
    ${hasRole("manager") ? `
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">Schedule maintenance</div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 0.7fr 1fr 1fr auto;">
        <div><label>Device</label><select id="mf-device">${devices.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}</select></div>
        <div><label>Due date</label><input id="mf-due" type="date" /></div>
        <div><label>Interval (days)</label><input id="mf-interval" placeholder="90" /></div>
        <div><label>Technician</label><input id="mf-tech" placeholder="name" /></div>
        <div><label>Notes</label><input id="mf-notes" placeholder="optional" /></div>
        <button class="btn btn-primary" onclick="submitMaintenanceForm()">+ Schedule</button>
      </div>
    </div>` : ""}
    <div class="form-card">
      <div class="list-header"><span>WO #</span><span style="flex:2;">Device</span><span>Due</span><span>Status</span><span></span></div>
      ${maintenanceRecords.map(m => {
        const device = devices.find(d => d.id === m.deviceId);
        const sc = m.status === "COMPLETED" ? "active" : m.status === "CANCELLED" ? "inactive" : m.status === "IN_PROGRESS" ? "warning" : "";
        return `<div class="list-row">
          <span class="list-cell mono">${esc(m.workOrderNumber)}</span>
          <span class="list-cell" style="flex:2;">${device ? esc(device.name) : m.deviceId}</span>
          <span class="list-cell mono">${m.dueDate ? new Date(m.dueDate).toLocaleDateString() : "—"}</span>
          <span class="list-cell"><span class="status-badge ${sc}">${m.status}</span></span>
          <span class="list-cell sm">
            ${hasRole("manager") && m.status === "SCHEDULED" ? `<button class="btn btn-sm" onclick="updateMaintenanceStatus('${m.id}','IN_PROGRESS')">Start</button>` : ""}
            ${hasRole("manager") && m.status === "IN_PROGRESS" ? `<button class="btn btn-sm" onclick="updateMaintenanceStatus('${m.id}','COMPLETED')">Done</button>` : ""}
            ${hasRole("manager") && (m.status === "SCHEDULED" || m.status === "IN_PROGRESS") ? `<button class="btn btn-sm btn-danger" onclick="updateMaintenanceStatus('${m.id}','CANCELLED')">Cancel</button>` : ""}
          </span>
        </div>`;
      }).join("") || `<div class="empty">No maintenance records.</div>`}
    </div>`;
}

// ---------- Calibration ----------

function viewCalibration() {
  return `
    <div class="top-bar">
      <div><h2>Calibration</h2><div class="subtitle">${calibrationRecords.length} records</div></div>
    </div>
    ${hasRole("manager") ? `
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">Log calibration</div>
      <div class="form-grid" style="grid-template-columns:1fr 0.8fr 0.8fr 0.8fr 0.8fr auto;">
        <div><label>Device</label><select id="cf-device">${devices.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}</select></div>
        <div><label>Date</label><input id="cf-date" type="date" /></div>
        <div><label>Next due</label><input id="cf-next" type="date" /></div>
        <div><label>Reference (kg)</label><input id="cf-ref" placeholder="25.000" /></div>
        <div><label>Actual (kg)</label><input id="cf-actual" placeholder="25.020" /></div>
        <button class="btn btn-primary" onclick="submitCalibrationForm()">+ Log</button>
      </div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;margin-top:8px;">
        <div><label>Certificate #</label><input id="cf-cert" placeholder="CERT-1234" /></div>
        <div><label>Company</label><input id="cf-company" placeholder="optional" /></div>
        <div><label>Technician</label><input id="cf-tech" placeholder="optional" /></div>
      </div>
    </div>` : ""}
    <div class="form-card">
      <div class="list-header"><span style="flex:2;">Device</span><span>Date</span><span>Error</span><span>Result</span><span>Next due</span><span></span></div>
      ${calibrationRecords.map(c => {
        const device = devices.find(d => d.id === c.deviceId);
        return `<div class="list-row">
          <span class="list-cell" style="flex:2;">${device ? esc(device.name) : c.deviceId}</span>
          <span class="list-cell mono">${new Date(c.calibrationDate).toLocaleDateString()}</span>
          <span class="list-cell mono">${c.errorPercent.toFixed(2)}%</span>
          <span class="list-cell"><span class="status-badge ${c.passFail === "PASS" ? "active" : "critical"}">${c.passFail}</span></span>
          <span class="list-cell mono">${c.nextCalibrationDate ? new Date(c.nextCalibrationDate).toLocaleDateString() : "—"}</span>
          <span class="list-cell sm">${hasRole("manager") ? `<button class="btn btn-sm btn-danger" onclick="removeCalibrationRecord('${c.id}')">✕</button>` : ""}</span>
        </div>`;
      }).join("") || `<div class="empty">No calibration records.</div>`}
    </div>`;
}

// ---------- Reports ----------

function viewReports() {
  const hasRange = reportFrom && reportTo;
  const rangeParams = hasRange ? `?from=${reportFrom}&to=${reportTo}` : "";
  return `
    <div class="top-bar"><div><h2>Reports</h2></div></div>
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">Date range</div>
      <div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin-bottom:12px;">
        <div><label>From</label><input id="rp-from" type="date" value="${reportFrom}" style="width:160px;" /></div>
        <div><label>To</label><input id="rp-to" type="date" value="${reportTo}" style="width:160px;" /></div>
        <button class="btn btn-primary" onclick="reportFrom=document.getElementById('rp-from').value;reportTo=document.getElementById('rp-to').value;render()">Apply</button>
        ${hasRange ? `<button class="btn" onclick="reportFrom='';reportTo='';render()">Clear</button>` : ""}
      </div>
      <div style="font-size:12px;color:#5B6673;margin-bottom:14px;">
        ${hasRange ? `Showing ${new Date(reportFrom).toLocaleDateString()} – ${new Date(reportTo).toLocaleDateString()}.` : "Cumulative since last reset. Set dates above for a specific period."}
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn btn-primary" onclick="downloadReport('/api/reports/give-away.pdf${rangeParams}','give-away-report.pdf')">Give-away PDF</button>
        <button class="btn" onclick="downloadReport('/api/reports/give-away.csv${rangeParams}','give-away-report.csv')">Give-away CSV</button>
        <button class="btn btn-primary" onclick="downloadReport('/api/reports/alerts.pdf${rangeParams}','alert-history.pdf')">Alerts PDF</button>
        <button class="btn" onclick="downloadReport('/api/reports/alerts.csv${rangeParams}','alert-history.csv')">Alerts CSV</button>
      </div>
    </div>
    ${hasRole("manager") ? `
    <div class="form-card" style="margin-top:16px;">
      <div class="section-label mono" style="margin-bottom:10px;">Scheduled Reports (auto-email)</div>
      <div id="scheduled-reports-list">${scheduledReports.length ? scheduledReports.map(r => `
        <div class="list-row">
          <span class="list-cell" style="flex:2;">${esc(r.name)}</span>
          <span class="list-cell">${esc(r.reportType)}</span>
          <span class="list-cell">${esc(r.format)}</span>
          <span class="list-cell" style="font-size:11px;">${esc(r.recipients)}</span>
          <span class="list-cell"><span class="status-badge ${r.enabled ? 'active' : 'inactive'}">${r.enabled ? 'on' : 'off'}</span></span>
          <span class="list-cell sm">
            <button class="btn btn-sm" onclick="runScheduledReport('${r.id}')">Run now</button>
            <button class="btn btn-sm btn-danger" onclick="deleteScheduledReport('${r.id}')">Delete</button>
          </span>
        </div>`).join("") : `<div style="padding:12px;color:var(--muted);">No scheduled reports. Create one below.</div>`}</div>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #1B2129;">
        <div class="section-label mono" style="margin-bottom:8px;">Add scheduled report</div>
        <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr auto;">
          <div><label>Name</label><input id="sr-name" placeholder="Daily Give-away" /></div>
          <div><label>Type</label><select id="sr-type"><option value="give-away">Give-away</option><option value="alerts">Alerts</option></select></div>
          <div><label>Schedule</label><select id="sr-schedule"><option value="daily">Daily (8am)</option><option value="weekly">Weekly (Mon 8am)</option></select></div>
          <div style="display:flex;align-items:end;"><button class="btn btn-primary" onclick="addScheduledReport()">Add</button></div>
        </div>
        <div style="margin-top:8px;"><label>Recipients (comma-separated emails)</label><input id="sr-recipients" placeholder="you@gmail.com, ops@company.com" style="width:100%;" /></div>
      </div>
    </div>` : ""}`;
}

// ---------- Alerts ----------

function viewAlerts() {
  return `
    <div class="top-bar"><div><h2>Alerts</h2><div class="subtitle">${activeAlerts.length} active · ${alertHistory.length} in history</div></div>
      ${hasRole("manager") ? `<div class="top-bar-actions"><button class="btn" onclick="currentView='alerts';showAlertSettings=!showAlertSettings;render()">Settings</button></div>` : ""}
    </div>
    ${renderAlertSettings()}
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">Active alerts</div>
      ${activeAlerts.map(a => {
        const isSnoozed = a.snoozedUntil && new Date(a.snoozedUntil) > new Date();
        const isAck = a.acknowledgedBy;
        return `<div class="alert-item ${a.severity}" style="margin-bottom:8px;${isSnoozed ? "opacity:0.5;" : ""}">
          <span class="alert-dot"></span>
          <span class="alert-msg">${esc(a.message)}${isSnoozed ? ` <span style="font-size:11px;color:var(--muted);">(snoozed till ${new Date(a.snoozedUntil).toLocaleTimeString()})</span>` : ""}${isAck ? ` <span style="font-size:11px;color:var(--muted);">(ack by ${esc(a.acknowledgedBy)})</span>` : ""}</span>
          <span class="alert-time">${timeAgo(a.since)}</span>
          <span style="display:flex;gap:4px;margin-left:8px;">
            ${!isSnoozed ? `<button class="btn btn-sm" onclick="snoozeAlert('${a.id}',15)" title="Snooze 15min">15m</button>
            <button class="btn btn-sm" onclick="snoozeAlert('${a.id}',60)" title="Snooze 1hr">1h</button>` : ""}
            ${!isAck ? `<button class="btn btn-sm" onclick="acknowledgeAlert('${a.id}')" title="Acknowledge">Ack</button>` : ""}
          </span>
        </div>`;
      }).join("") || `<div class="empty">No active alerts.</div>`}
    </div>
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">History</div>
      ${alertHistory.map(a => `<div class="list-row">
        <span class="list-cell sm"><span class="status-badge ${a.active ? (a.severity === "critical" ? "critical" : "warning") : "inactive"}">${a.active ? "active" : "resolved"}</span></span>
        <span class="list-cell">${esc(a.message)}</span>
        <span class="list-cell mono" style="flex:0 0 100px;">${timeAgo(a.since)}</span>
      </div>`).join("") || `<div class="empty">No history.</div>`}
    </div>`;
}

async function snoozeAlert(id, minutes) {
  try {
    await authFetch(`${API}/api/alerts/${id}/snooze`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minutes }) });
    toast(`Alert snoozed for ${minutes}min`, "success");
    render();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function acknowledgeAlert(id) {
  try {
    await authFetch(`${API}/api/alerts/${id}/acknowledge`, { method: "POST" });
    toast("Alert acknowledged", "success");
    render();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

let showAlertSettings = false;

function renderAlertSettings() {
  if (!showAlertSettings || !hasRole("manager")) return "";
  return `<div class="form-card">
    <div class="section-label mono" style="margin-bottom:10px;">Alert settings</div>
    <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr 1fr;">
      <div><label>Tolerance (%)</label><input id="ac-tolerance" value="${alertConfig.toleranceThresholdPercent}" /></div>
      <div><label>Consecutive bags</label><input id="ac-consecutive" value="${alertConfig.consecutiveBagsThreshold}" /></div>
      <div><label>Offline timeout (s)</label><input id="ac-timeout" value="${alertConfig.offlineTimeoutSeconds}" /></div>
      <div><label>Webhook URL</label><input id="ac-webhook" value="${esc(alertConfig.webhookUrl)}" placeholder="https://hooks.slack.com/…" /></div>
    </div>
    <div class="form-grid" style="grid-template-columns:1fr 1fr;margin-top:10px;">
      <div><label>Calibration reminder (days)</label><input id="ac-cal-reminder" value="${alertConfig.calibrationReminderDays || 14}" /></div>
      <div><label>Maintenance reminder (days)</label><input id="ac-maint-reminder" value="${alertConfig.maintenanceReminderDays || 7}" /></div>
    </div>
    <div style="display:flex;gap:8px;margin-top:14px;">
      <button class="btn btn-primary" onclick="saveAlertCfg()">Save</button>
      <button class="btn" onclick="showAlertSettings=false;render()">Cancel</button>
    </div>
  </div>`;
}

function saveAlertCfg() {
  saveAlertConfig({
    toleranceThresholdPercent: parseFloat(document.getElementById("ac-tolerance").value) || 3,
    consecutiveBagsThreshold: parseInt(document.getElementById("ac-consecutive").value) || 3,
    offlineTimeoutSeconds: parseInt(document.getElementById("ac-timeout").value) || 10,
    webhookUrl: document.getElementById("ac-webhook").value.trim(),
    calibrationReminderDays: parseInt(document.getElementById("ac-cal-reminder").value) || 14,
    maintenanceReminderDays: parseInt(document.getElementById("ac-maint-reminder").value) || 7,
  });
  showAlertSettings = false;
}

// ---------- Gateway Keys ----------

function viewGatewayKeys() {
  return `
    <div class="top-bar"><div><h2>Gateway Keys</h2></div>
      <div class="top-bar-actions"><button class="btn btn-primary" onclick="createGatewayKey()">+ New key</button></div>
    </div>
    ${newlyCreatedKey ? `<div class="form-card" style="border-color:var(--accent);">
      <div style="font-size:11px;color:#8B95A1;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">New key — copy it now</div>
      <div class="mono" style="font-size:13px;color:var(--accent);word-break:break-all;">${esc(newlyCreatedKey.key)}</div>
      <div style="font-size:11px;color:#5B6673;margin-top:6px;">Add to <code>gateway/.env</code> as <code>GATEWAY_API_KEY=...</code></div>
    </div>` : ""}
    <div class="form-card">
      ${gatewayKeys.map(k => `<div class="list-row">
        <span class="list-cell">${esc(k.label)}</span>
        <span class="list-cell mono">${esc(k.keyPreview)}</span>
        <span class="list-cell mono" style="flex:0 0 120px;">${new Date(k.createdAt).toLocaleDateString()}</span>
        <span class="list-cell sm"><button class="btn btn-sm btn-danger" onclick="revokeGatewayKey('${k.id}')">Revoke</button></span>
      </div>`).join("") || `<div class="empty">No gateway keys.</div>`}
    </div>`;
}

// ---------- Templates ----------

function viewTemplates() {
  return `
    <div class="top-bar"><div><h2>Configuration Templates</h2></div></div>
    <div class="form-card">
      ${templates.map(t => `<div class="list-row">
        <span class="list-cell">${esc(t.name)}</span>
        <span class="list-cell mono">${esc(t.protocol)}</span>
        <span class="list-cell mono">port ${t.port}</span>
        <span class="list-cell mono">${t.pollingMs}ms</span>
        <span class="list-cell sm">${t.builtIn ? `<span class="status-badge inactive">built-in</span>` : `<button class="btn btn-sm btn-danger" onclick="removeTemplate('${t.id}')">✕</button>`}</span>
      </div>`).join("")}
      <div style="font-size:11px;color:#5B6673;margin-top:12px;">Templates prefill protocol/port/register settings in the device onboarding wizard.</div>
    </div>`;
}

// ---------- Branding ----------

function viewBranding() {
  return `
    <div class="top-bar"><div><h2>Branding</h2></div></div>
    <div class="form-card">
      <div class="form-grid" style="grid-template-columns:1.2fr 1fr 1fr 0.6fr auto;">
        <div><label>Company name</label><input id="bf-name" value="${esc(branding.companyName)}" /></div>
        <div><label>Tagline</label><input id="bf-tagline" value="${esc(branding.tagline)}" /></div>
        <div><label>Logo URL</label><input id="bf-logo" value="${esc(branding.logoUrl)}" placeholder="https://…" /></div>
        <div><label>Accent color</label><input id="bf-color" type="color" value="${branding.accentColor}" style="padding:2px;height:36px;" /></div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-primary" onclick="saveBrandingForm()">Save</button>
        </div>
      </div>
    </div>`;
}

function saveBrandingForm() {
  const accentColor = document.getElementById("bf-color").value;
  saveBranding({
    companyName: document.getElementById("bf-name").value.trim() || "Scale Ops",
    tagline: document.getElementById("bf-tagline").value.trim() || "Fill Line Monitoring",
    logoUrl: document.getElementById("bf-logo").value.trim(),
    accentColor,
  });
}

// ---------- Notifications ----------

function viewNotifications() {
  const cfg = notificationConfig;
  return `
    <div class="top-bar"><div><h2>Notifications</h2><div class="subtitle">Downtime alerts via Email, WhatsApp, Slack, Teams, Browser Push</div></div></div>
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:12px;">Browser Push Notifications</div>
      <div class="toggle-row" style="margin-bottom:12px;">
        <label class="toggle"><input type="checkbox" id="nc-push-enabled" ${pushSubscriptionStatus === "subscribed" ? "checked" : ""} onchange="togglePushNotifications()" /><span class="slider"></span></label>
        <span>${pushSubscriptionStatus === "subscribed" ? "Push notifications enabled" : pushSubscriptionStatus === "unsupported" ? "Not supported in this browser" : "Enable browser push notifications"}</span>
      </div>
      <div style="font-size:12px;color:#8B95A1;">Receive alerts as browser notifications even when the tab is in the background.</div>
    </div>
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:12px;">Email (Gmail SMTP — free)</div>
      <div class="toggle-row" style="margin-bottom:12px;">
        <label class="toggle"><input type="checkbox" id="nc-email-enabled" ${cfg.emailEnabled ? "checked" : ""} /><span class="slider"></span></label>
        <span>Enable email notifications</span>
      </div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr;">
        <div><label>Gmail address</label><input id="nc-smtp-user" value="${esc(cfg.smtpUser)}" placeholder="you@gmail.com" /></div>
        <div><label>App password</label><input id="nc-smtp-pass" type="password" value="${cfg.smtpPass || ""}" placeholder="16-char app password" /></div>
      </div>
      <div style="margin-top:8px;"><label>Recipients (comma-separated)</label><input id="nc-email-recipients" value="${esc(cfg.emailRecipients)}" placeholder="you@gmail.com, ops@company.com" style="width:100%;" /></div>
      <div style="margin-top:8px;"><button class="btn btn-sm" onclick="testNotification('email')">Send test email</button></div>
      <div style="margin-top:10px;font-size:12px;color:var(--muted);">Use a <a href="https://myaccount.google.com/apppasswords" target="_blank" style="color:var(--accent);">Google App Password</a>. Free: 500 emails/day.</div>
    </div>
    <div class="form-card" style="margin-top:16px;">
      <div class="section-label mono" style="margin-bottom:12px;">WhatsApp (Ultrammsg — free: 1000 msgs/month)</div>
      <div class="toggle-row" style="margin-bottom:12px;">
        <label class="toggle"><input type="checkbox" id="nc-whatsapp-enabled" ${cfg.whatsappEnabled ? "checked" : ""} /><span class="slider"></span></label>
        <span>Enable WhatsApp notifications</span>
      </div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr;">
        <div><label>Instance ID</label><input id="nc-ultrammsg-instance" value="${esc(cfg.ultrammsgInstanceId)}" placeholder="instance123" /></div>
        <div><label>Token</label><input id="nc-ultrammsg-token" type="password" value="${cfg.ultrammsgToken || ""}" placeholder="your ultrammsg token" /></div>
      </div>
      <div style="margin-top:8px;"><label>Recipient WhatsApp (e.g. +27821234567)</label><input id="nc-whatsapp-recipients" value="${esc(cfg.whatsappRecipients)}" placeholder="+27821234567" style="width:100%;" /></div>
      <div style="margin-top:8px;"><button class="btn btn-sm" onclick="testNotification('whatsapp')">Send test WhatsApp</button></div>
      <div style="margin-top:10px;font-size:12px;color:var(--muted);">Sign up free at <a href="https://ultrammsg.com" target="_blank" style="color:var(--accent);">ultrammsg.com</a>.</div>
    </div>
    <div class="form-card" style="margin-top:16px;">
      <div class="section-label mono" style="margin-bottom:12px;">Slack (Incoming Webhook — free)</div>
      <div class="toggle-row" style="margin-bottom:12px;">
        <label class="toggle"><input type="checkbox" id="nc-slack-enabled" ${cfg.slackEnabled ? "checked" : ""} /><span class="slider"></span></label>
        <span>Enable Slack notifications</span>
      </div>
      <div><label>Webhook URL</label><input id="nc-slack-webhook" value="${esc(cfg.slackWebhookUrl || "")}" placeholder="https://hooks.slack.com/services/..." style="width:100%;" /></div>
      <div style="margin-top:8px;"><button class="btn btn-sm" onclick="testNotification('slack')">Send test to Slack</button></div>
      <div style="margin-top:10px;font-size:12px;color:var(--muted);">Create a free <a href="https://api.slack.com/messaging/webhooks" target="_blank" style="color:var(--accent);">Incoming Webhook</a> in your Slack workspace.</div>
    </div>
    <div class="form-card" style="margin-top:16px;">
      <div class="section-label mono" style="margin-bottom:12px;">Microsoft Teams (Incoming Webhook — free)</div>
      <div class="toggle-row" style="margin-bottom:12px;">
        <label class="toggle"><input type="checkbox" id="nc-teams-enabled" ${cfg.teamsEnabled ? "checked" : ""} /><span class="slider"></span></label>
        <span>Enable Teams notifications</span>
      </div>
      <div><label>Webhook URL</label><input id="nc-teams-webhook" value="${esc(cfg.teamsWebhookUrl || "")}" placeholder="https://outlook.office.com/webhook/..." style="width:100%;" /></div>
      <div style="margin-top:8px;"><button class="btn btn-sm" onclick="testNotification('teams')">Send test to Teams</button></div>
      <div style="margin-top:10px;font-size:12px;color:var(--muted);">Create an <a href="https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook" target="_blank" style="color:var(--accent);">Incoming Webhook</a> connector in your Teams channel.</div>
    </div>
    <div class="form-card" style="margin-top:16px;">
      <div class="section-label mono" style="margin-bottom:12px;">Downtime alerts</div>
      <div class="toggle-row">
        <label class="toggle"><input type="checkbox" id="nc-downtime-enabled" ${cfg.downtimeNotifyEnabled ? "checked" : ""} /><span class="slider"></span></label>
        <span>Send downtime notifications (when a device goes silent)</span>
      </div>
    </div>
    <div style="margin-top:16px;">
      <button class="btn btn-primary" onclick="saveNotificationConfig()">Save notification settings</button>
    </div>
  `;
}

async function saveNotificationConfig() {
  const payload = {
    emailEnabled: document.getElementById("nc-email-enabled").checked,
    emailRecipients: document.getElementById("nc-email-recipients").value.trim(),
    smtpUser: document.getElementById("nc-smtp-user").value.trim(),
    smtpPass: document.getElementById("nc-smtp-pass").value,
    whatsappEnabled: document.getElementById("nc-whatsapp-enabled").checked,
    whatsappRecipients: document.getElementById("nc-whatsapp-recipients").value.trim(),
    ultrammsgInstanceId: document.getElementById("nc-ultrammsg-instance").value.trim(),
    ultrammsgToken: document.getElementById("nc-ultrammsg-token").value,
    slackEnabled: document.getElementById("nc-slack-enabled").checked,
    slackWebhookUrl: document.getElementById("nc-slack-webhook").value.trim(),
    teamsEnabled: document.getElementById("nc-teams-enabled").checked,
    teamsWebhookUrl: document.getElementById("nc-teams-webhook").value.trim(),
    downtimeNotifyEnabled: document.getElementById("nc-downtime-enabled").checked,
  };
  try {
    const res = await authFetch(`${API}/api/notification-config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    notificationConfig = await res.json();
    toast("Notification settings saved", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function testNotification(channel) {
  try {
    const res = await authFetch(`${API}/api/notification-config/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    toast(`${channel} test sent — check your ${channel === "email" ? "inbox" : "WhatsApp"}`, "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

// ---------- Push Notifications ----------

let pushSubscriptionStatus = "unsupported";

async function initPushNotifications() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    pushSubscriptionStatus = "unsupported";
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription();
    pushSubscriptionStatus = subscription ? "subscribed" : "not_subscribed";
  } catch (e) {
    pushSubscriptionStatus = "error";
  }
}

async function togglePushNotifications() {
  if (pushSubscriptionStatus === "subscribed") {
    // Unsubscribe
    try {
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.getSubscription();
      if (subscription) {
        await authFetch(`${API}/api/push/subscribe`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
        await subscription.unsubscribe();
        pushSubscriptionStatus = "not_subscribed";
        toast("Push notifications disabled", "success");
      }
    } catch (e) { toast("Failed to unsubscribe: " + e.message, "error"); }
  } else {
    // Subscribe — using a simple VAPID-free approach for demo
    try {
      const reg = await navigator.serviceWorker.ready;
      // In production, generate VAPID keys and use them here
      // For now, we use a fallback notification approach
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        pushSubscriptionStatus = "subscribed";
        toast("Notifications enabled", "success");
      } else {
        toast("Notification permission denied", "error");
      }
    } catch (e) { toast("Failed to subscribe: " + e.message, "error"); }
  }
  render();
}

// Browser notification for alerts (called from WS handler)
function browserNotify(title, body, url) {
  if (Notification.permission === "granted") {
    try {
      new Notification(title, { body, icon: "/manifest-icon.png", badge: "/manifest-icon.png", tag: "scale-ops-alert" });
    } catch (e) {}
  }
}

// ---------- Production Schedule ----------

let productionSchedules = [];

function viewSchedule() {
  const today = new Date().toISOString().split("T")[0];
  const todayScheds = productionSchedules.filter(s => s.shiftDate === today);
  const upcoming = productionSchedules.filter(s => s.shiftDate > today).slice(0, 20);

  return `
    <div class="top-bar">
      <div><h2>Production Schedule</h2><div class="subtitle">${todayScheds.length} shifts today · ${upcoming.length} upcoming</div></div>
      <div class="top-bar-actions">
        <button class="btn" onclick="loadProductionSchedules()">Refresh</button>
        ${hasRole("manager") ? `<button class="btn btn-primary" onclick="showAddSchedule()">+ Add shift</button>` : ""}
      </div>
    </div>
    <div id="add-schedule-area"></div>
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">Today's shifts</div>
      ${todayScheds.length ? `
        <div class="list-header"><span>Device</span><span>Shift</span><span>Planned</span><span>Actual</span><span>Status</span><span></span></div>
        ${todayScheds.map(s => {
          const device = devices.find(d => d.id === s.deviceId);
          const pct = s.plannedBags > 0 ? Math.round((s.actualBags / s.plannedBags) * 100) : 0;
          return `<div class="list-row">
            <span class="list-cell">${esc(device?.name || s.deviceId)}</span>
            <span class="list-cell">${esc(s.shiftName)}</span>
            <span class="list-cell mono">${s.plannedBags}</span>
            <span class="list-cell mono">${s.actualBags} <span style="font-size:11px;color:${pct >= 100 ? '#27ae60' : pct >= 80 ? '#F2B705' : '#E5484D'};">(${pct}%)</span></span>
            <span class="list-cell"><span class="status-badge ${s.status === 'completed' ? 'active' : s.status === 'in_progress' ? 'warning' : ''}">${s.status}</span></span>
            <span class="list-cell sm">
              ${s.status !== "completed" ? `<button class="btn btn-sm" onclick="updateScheduleStatus('${s.id}','in_progress')">Start</button>` : ""}
              ${s.status === "in_progress" ? `<button class="btn btn-sm btn-primary" onclick="completeSchedule('${s.id}')">Complete</button>` : ""}
              <button class="btn btn-sm btn-danger" onclick="deleteSchedule('${s.id}')">Delete</button>
            </span>
          </div>`;
        }).join("")}
      ` : `<div style="padding:20px;color:var(--muted);text-align:center;">No shifts scheduled for today.</div>`}
    </div>
    <div class="form-card" style="margin-top:16px;">
      <div class="section-label mono" style="margin-bottom:10px;">Upcoming</div>
      ${upcoming.length ? `
        <div class="list-header"><span>Date</span><span>Device</span><span>Shift</span><span>Planned</span><span>Status</span></div>
        ${upcoming.map(s => {
          const device = devices.find(d => d.id === s.deviceId);
          return `<div class="list-row">
            <span class="list-cell mono">${s.shiftDate}</span>
            <span class="list-cell">${esc(device?.name || s.deviceId)}</span>
            <span class="list-cell">${esc(s.shiftName)}</span>
            <span class="list-cell mono">${s.plannedBags}</span>
            <span class="list-cell"><span class="status-badge">${s.status}</span></span>
          </div>`;
        }).join("")}
      ` : `<div style="padding:20px;color:var(--muted);text-align:center;">No upcoming shifts.</div>`}
    </div>`;
}

function showAddSchedule() {
  const today = new Date().toISOString().split("T")[0];
  document.getElementById("add-schedule-area").innerHTML = `
    <div class="form-card" style="margin-bottom:16px;">
      <div class="section-label mono" style="margin-bottom:10px;">Add shift</div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr 1fr auto;">
        <div><label>Device</label><select id="ps-device">${devices.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}</select></div>
        <div><label>Shift</label><select id="ps-shift"><option>Morning</option><option>Afternoon</option><option>Night</option></select></div>
        <div><label>Date</label><input id="ps-date" type="date" value="${today}" /></div>
        <div><label>Planned bags</label><input id="ps-bags" type="number" value="100" /></div>
        <div style="display:flex;align-items:end;"><button class="btn btn-primary" onclick="addSchedule()">Add</button></div>
      </div>
    </div>`;
}

async function addSchedule() {
  const deviceId = document.getElementById("ps-device").value;
  const shiftName = document.getElementById("ps-shift").value;
  const shiftDate = document.getElementById("ps-date").value;
  const plannedBags = parseInt(document.getElementById("ps-bags").value) || 0;
  try {
    await authFetch(`${API}/api/production-schedules`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId, shiftName, shiftDate, plannedBags }) });
    toast("Shift added", "success");
    await loadProductionSchedules();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function updateScheduleStatus(id, status) {
  await authFetch(`${API}/api/production-schedules/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, actualStart: new Date().toISOString() }) });
  await loadProductionSchedules();
}

async function completeSchedule(id) {
  const actualBags = prompt("How many bags were actually filled?", "0");
  if (actualBags === null) return;
  await authFetch(`${API}/api/production-schedules/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "completed", actualBags: parseInt(actualBags) || 0, actualEnd: new Date().toISOString() }) });
  toast("Shift completed", "success");
  await loadProductionSchedules();
}

async function deleteSchedule(id) {
  if (!confirm("Delete this shift?")) return;
  await authFetch(`${API}/api/production-schedules/${id}`, { method: "DELETE" });
  await loadProductionSchedules();
}

async function loadProductionSchedules() {
  const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const to = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const res = await authFetch(`${API}/api/production-schedules?from=${from}&to=${to}`);
  productionSchedules = await res.json();
  render();
}

// ---------- OEE (Overall Equipment Effectiveness) ----------

let oeeDeviceId = "";
let oeeData = null;

function viewOEE() {
  if (!oeeDeviceId && devices.length) oeeDeviceId = devices[0].id;

  return `
    <div class="top-bar">
      <div><h2>OEE Dashboard</h2><div class="subtitle">Availability x Performance x Quality</div></div>
      <div class="top-bar-actions">
        <select id="oee-device" onchange="oeeDeviceId=this.value;loadOEE()" style="padding:6px 10px;border-radius:6px;background:#1B2129;color:#E8EAED;border:1px solid #2A333D;">
          ${devices.map(d => `<option value="${d.id}" ${d.id === oeeDeviceId ? "selected" : ""}>${esc(d.name)}</option>`).join("")}
        </select>
        <button class="btn btn-sm" onclick="loadOEE()" style="margin-left:8px;">Refresh</button>
      </div>
    </div>
    <div id="oee-content">
      ${oeeData ? renderOEEData() : `<div style="padding:20px;color:var(--muted);text-align:center;">Click Refresh to load OEE data.</div>`}
    </div>`;
}

function oeeGauge(value, label, color) {
  const angle = (value / 100) * 270;
  return `<div style="text-align:center;">
    <svg width="140" height="100" viewBox="0 0 140 100">
      <path d="M 15 85 A 55 55 0 1 1 125 85" fill="none" stroke="#1B2129" stroke-width="12" stroke-linecap="round"/>
      <path d="M 15 85 A 55 55 0 1 1 125 85" fill="none" stroke="${color}" stroke-width="12" stroke-linecap="round"
        stroke-dasharray="${(value / 100) * 173} 173" style="transition:stroke-dasharray 0.5s ease;"/>
      <text x="70" y="65" text-anchor="middle" fill="${color}" font-size="24" font-weight="600">${value}%</text>
      <text x="70" y="82" text-anchor="middle" fill="#8B95A1" font-size="10">${label}</text>
    </svg>
  </div>`;
}

function renderOEEData() {
  if (!oeeData) return "";
  const d = oeeData;
  const oeeColor = d.oee >= 85 ? "#27ae60" : d.oee >= 65 ? "#F2B705" : "#E5484D";
  const availColor = d.availability >= 90 ? "#27ae60" : d.availability >= 75 ? "#F2B705" : "#E5484D";
  const perfColor = d.performance >= 95 ? "#27ae60" : d.performance >= 85 ? "#F2B705" : "#E5484D";
  const qualColor = d.quality >= 99 ? "#27ae60" : d.quality >= 95 ? "#F2B705" : "#E5484D";

  return `
    <div class="form-card" style="text-align:center;padding:30px;">
      <div class="section-label mono" style="margin-bottom:16px;">Overall OEE</div>
      <div style="font-size:48px;font-weight:700;color:${oeeColor};margin-bottom:4px;">${d.oee}%</div>
      <div style="font-size:13px;color:var(--muted);">Target: 85% world-class</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-top:16px;">
      <div class="form-card" style="padding:20px;">${oeeGauge(d.availability, "Availability", availColor)}</div>
      <div class="form-card" style="padding:20px;">${oeeGauge(d.performance, "Performance", perfColor)}</div>
      <div class="form-card" style="padding:20px;">${oeeGauge(d.quality, "Quality", qualColor)}</div>
    </div>
    <div class="form-card" style="margin-top:16px;">
      <div class="section-label mono" style="margin-bottom:12px;">Breakdown</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="kv-row"><span class="kv-label">Planned time</span><span class="kv-value">${formatDuration(d.plannedSeconds)}</span></div>
        <div class="kv-row"><span class="kv-label">Operating time</span><span class="kv-value">${formatDuration(d.operatingSeconds)}</span></div>
        <div class="kv-row"><span class="kv-label">Downtime</span><span class="kv-value" style="color:#E5484D;">${formatDuration(d.downtimeSeconds)}</span></div>
        <div class="kv-row"><span class="kv-label">Total bags</span><span class="kv-value">${d.totalBags}</span></div>
        <div class="kv-row"><span class="kv-label">Good bags</span><span class="kv-value" style="color:#27ae60;">${d.goodBags}</span></div>
        <div class="kv-row"><span class="kv-label">Over target</span><span class="kv-value" style="color:#E5484D;">${d.overBags}</span></div>
        <div class="kv-row"><span class="kv-label">Under target</span><span class="kv-value" style="color:#F2B705;">${d.underBags}</span></div>
      </div>
    </div>`;
}

async function loadOEE() {
  if (!oeeDeviceId && devices.length) oeeDeviceId = devices[0].id;
  if (!oeeDeviceId) return;
  const to = new Date().toISOString();
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const res = await authFetch(`${API}/api/devices/${oeeDeviceId}/oee?from=${from}&to=${to}`);
    oeeData = await res.json();
    render();
  } catch (e) { toast("Failed to load OEE: " + e.message, "error"); }
}

// ---------- SPC (Statistical Process Control) ----------

function calcSPC(values) {
  if (values.length < 2) return null;
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const stdDev = Math.sqrt(variance);

  // Moving ranges
  const ranges = [];
  for (let i = 1; i < n; i++) ranges.push(Math.abs(values[i] - values[i - 1]));
  const avgRange = ranges.length ? ranges.reduce((a, b) => a + b, 0) / ranges.length : 0;

  // Control limits (X-bar chart)
  const ucl = mean + 2.66 * avgRange;
  const lcl = mean - 2.66 * avgRange;

  // Histogram bins
  const min = Math.min(...values);
  const max = Math.max(...values);
  const binCount = Math.min(20, Math.max(5, Math.ceil(Math.sqrt(n))));
  const binWidth = (max - min) / binCount || 1;
  const bins = [];
  for (let i = 0; i < binCount; i++) {
    const lo = min + i * binWidth;
    const hi = lo + binWidth;
    bins.push({ lo, hi, count: values.filter(v => v >= lo && (i === binCount - 1 ? v <= hi : v < hi)).length });
  }

  return { mean, stdDev, ucl, lcl, avgRange, bins, n, min, max };
}

function renderSPCCharts(readings, target, product) {
  const weights = readings.map(r => r.weight).filter(w => w !== null && w !== undefined);
  if (weights.length < 2) return `<div style="padding:20px;color:var(--muted);text-align:center;">Need at least 2 readings for SPC analysis.</div>`;

  const spc = calcSPC(weights);
  const tolMin = product ? (product.toleranceType === "percentage" ? product.targetWeight * (1 - product.toleranceValue / 100) : product.targetWeight - product.toleranceValue) : target * 0.97;
  const tolMax = product ? (product.toleranceType === "percentage" ? product.targetWeight * (1 + product.toleranceValue / 100) : product.targetWeight + product.toleranceValue) : target * 1.03;

  // Cpk calculation
  const cpk = Math.min((tolMax - spc.mean) / (3 * spc.stdDev), (spc.mean - tolMin) / (3 * spc.stdDev));
  const cp = (tolMax - tolMin) / (6 * spc.stdDev);

  const cpkColor = cpk >= 1.33 ? "#27ae60" : cpk >= 1.0 ? "#F2B705" : "#E5484D";
  const cpkLabel = cpk >= 1.33 ? "Capable" : cpk >= 1.0 ? "Marginally Capable" : "Not Capable";

  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px;">
      <div class="form-card" style="text-align:center;padding:16px;">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Mean (X-bar)</div>
        <div style="font-size:24px;font-weight:600;margin-top:4px;">${spc.mean.toFixed(2)}</div>
      </div>
      <div class="form-card" style="text-align:center;padding:16px;">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Std Dev (σ)</div>
        <div style="font-size:24px;font-weight:600;margin-top:4px;">${spc.stdDev.toFixed(3)}</div>
      </div>
      <div class="form-card" style="text-align:center;padding:16px;">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Cpk</div>
        <div style="font-size:24px;font-weight:600;margin-top:4px;color:${cpkColor};">${cpk.toFixed(2)}</div>
        <div style="font-size:11px;color:${cpkColor};margin-top:2px;">${cpkLabel}</div>
      </div>
      <div class="form-card" style="text-align:center;padding:16px;">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Cp</div>
        <div style="font-size:24px;font-weight:600;margin-top:4px;">${cp.toFixed(2)}</div>
      </div>
      <div class="form-card" style="text-align:center;padding:16px;">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;">UCL</div>
        <div style="font-size:24px;font-weight:600;margin-top:4px;">${spc.ucl.toFixed(2)}</div>
      </div>
      <div class="form-card" style="text-align:center;padding:16px;">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;">LCL</div>
        <div style="font-size:24px;font-weight:600;margin-top:4px;">${spc.lcl.toFixed(2)}</div>
      </div>
    </div>
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">X-bar Chart (Individual Readings)</div>
      <canvas id="spc-xbar" height="200"></canvas>
    </div>
    <div class="form-card" style="margin-top:16px;">
      <div class="section-label mono" style="margin-bottom:10px;">Histogram (Weight Distribution)</div>
      <canvas id="spc-histogram" height="160"></canvas>
    </div>
  `;
}

function viewSPC() {
  const device = devices.find(d => d.id === spcDeviceId) || devices[0];
  const product = products.find(p => p.id === device?.productId);

  return `
    <div class="top-bar">
      <div><h2>SPC Analysis</h2><div class="subtitle">Statistical Process Control — X-bar, Cpk, Histogram</div></div>
      <div class="top-bar-actions">
        <select onchange="spcDeviceId=this.value;loadSPCData()" style="padding:6px 10px;border-radius:6px;background:#1B2129;color:#E8EAED;border:1px solid #2A333D;">
          ${devices.map(d => `<option value="${d.id}" ${d.id === spcDeviceId ? "selected" : ""}>${esc(d.name)}</option>`).join("")}
        </select>
      </div>
    </div>
    <div id="spc-content">
      ${renderSPCCharts(spcReadings, device?.target || 25, product)}
    </div>`;
}

async function loadSPCData() {
  if (!spcDeviceId && devices.length) spcDeviceId = devices[0].id;
  if (!spcDeviceId) return;
  try {
    const res = await authFetch(`${API}/api/devices/${spcDeviceId}/readings-range?days=7`);
    spcReadings = await res.json();
    render();
    setTimeout(renderSPCChartInstances, 100);
  } catch (e) { console.error("SPC load failed:", e); }
}

function renderSPCChartInstances() {
  if (currentView !== "spc") return;
  const weights = spcReadings.map(r => r.weight).filter(w => w !== null && w !== undefined);
  if (weights.length < 2) return;
  const spc = calcSPC(weights);
  const device = devices.find(d => d.id === spcDeviceId);
  const product = products.find(p => p.id === device?.productId);
  const tolMin = product ? (product.toleranceType === "percentage" ? product.targetWeight * (1 - product.toleranceValue / 100) : product.targetWeight - product.toleranceValue) : (device?.target || 25) * 0.97;
  const tolMax = product ? (product.toleranceType === "percentage" ? product.targetWeight * (1 + product.toleranceValue / 100) : product.targetWeight + product.toleranceValue) : (device?.target || 25) * 1.03;

  // X-bar chart
  const xbarEl = document.getElementById("spc-xbar");
  if (xbarEl) {
    new Chart(xbarEl, {
      type: "line",
      data: {
        labels: weights.map((_, i) => i + 1),
        datasets: [
          { label: "Weight", data: weights, borderColor: "#3B82F6", backgroundColor: "rgba(59,130,246,0.1)", pointRadius: 2, borderWidth: 1.5, fill: false },
          { label: "Mean", data: weights.map(() => spc.mean), borderColor: "#F2B705", borderWidth: 2, borderDash: [6, 3], pointRadius: 0, fill: false },
          { label: "UCL", data: weights.map(() => spc.ucl), borderColor: "#E5484D", borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false },
          { label: "LCL", data: weights.map(() => spc.lcl), borderColor: "#E5484D", borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false },
          { label: "Target", data: weights.map(() => device?.target || 25), borderColor: "#27ae60", borderWidth: 1, borderDash: [8, 4], pointRadius: 0, fill: false },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: "#8B95A1", font: { size: 11 } } } },
        scales: {
          x: { ticks: { color: "#5B6673", maxTicksLimit: 20 }, grid: { color: "#1B2129" } },
          y: { ticks: { color: "#5B6673" }, grid: { color: "#1B2129" } },
        },
      },
    });
  }

  // Histogram
  const histEl = document.getElementById("spc-histogram");
  if (histEl) {
    new Chart(histEl, {
      type: "bar",
      data: {
        labels: spc.bins.map(b => `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}`),
        datasets: [{ label: "Count", data: spc.bins.map(b => b.count), backgroundColor: "rgba(59,130,246,0.6)", borderColor: "#3B82F6", borderWidth: 1 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: "#5B6673", maxRotation: 45 }, grid: { display: false } },
          y: { ticks: { color: "#5B6673", stepSize: 1 }, grid: { color: "#1B2129" } },
        },
      },
    });
  }
}

// ---------- Device Groups ----------

let deviceGroups = [];

async function loadDeviceGroups() {
  const res = await authFetch(`${API}/api/device-groups`);
  deviceGroups = await res.json();
}

function viewDeviceGroups() {
  const topLevel = deviceGroups.filter(g => !g.parentId);
  const getChildren = (parentId) => deviceGroups.filter(g => g.parentId === parentId);

  function renderGroup(g, depth = 0) {
    const children = getChildren(g.id);
    const devicesInGroup = devices.filter(d => d.groupId === g.id);
    return `<div style="margin-left:${depth * 24}px;margin-bottom:8px;">
      <div class="list-row" style="border-left:3px solid ${g.color};">
        <span class="list-cell" style="flex:2;font-weight:500;">${esc(g.name)}</span>
        <span class="list-cell" style="font-size:12px;color:var(--muted);">${devicesInGroup.length} device${devicesInGroup.length !== 1 ? "s" : ""}</span>
        <span class="list-cell sm">
          <button class="btn btn-sm btn-danger" onclick="deleteDeviceGroup('${g.id}')">Delete</button>
        </span>
      </div>
      ${devicesInGroup.map(d => `<div class="list-row" style="margin-left:${(depth + 1) * 24}px;border-left:2px solid #2A333D;">
        <span class="list-cell" style="flex:2;font-size:13px;">${esc(d.name)}</span>
        <span class="list-cell" style="font-size:12px;color:var(--muted);">${esc(d.ip)}</span>
        <span class="list-cell sm">
          <select onchange="assignDeviceToGroup('${d.id}',this.value)" style="padding:3px 6px;border-radius:4px;background:#1B2129;color:#E8EAED;border:1px solid #2A333D;font-size:11px;">
            <option value="">No group</option>
            ${deviceGroups.map(gr => `<option value="${gr.id}" ${d.groupId === gr.id ? "selected" : ""}>${esc(gr.name)}</option>`).join("")}
          </select>
        </span>
      </div>`).join("")}
      ${children.map(c => renderGroup(c, depth + 1)).join("")}
    </div>`;
  }

  return `
    <div class="top-bar"><div><h2>Device Groups</h2><div class="subtitle">Organize devices into plant &gt; line &gt; station hierarchies</div></div></div>
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">Create group</div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr auto auto;">
        <div><label>Name</label><input id="dg-name" placeholder="Line 1" /></div>
        <div><label>Parent</label><select id="dg-parent"><option value="">None (top level)</option>${deviceGroups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join("")}</select></div>
        <div><label>Color</label><input id="dg-color" type="color" value="#3B82F6" style="width:50px;height:36px;" /></div>
        <div style="display:flex;align-items:end;"><button class="btn btn-primary" onclick="createDeviceGroup()">Create</button></div>
      </div>
    </div>
    <div class="form-card" style="margin-top:16px;">
      <div class="section-label mono" style="margin-bottom:10px;">Groups & Devices</div>
      ${topLevel.length ? topLevel.map(g => renderGroup(g)).join("") : `<div style="padding:20px;color:var(--muted);text-align:center;">No groups yet. Create one above, then assign devices.</div>`}
    </div>
    ${devices.filter(d => !d.groupId).length ? `
    <div class="form-card" style="margin-top:16px;">
      <div class="section-label mono" style="margin-bottom:10px;">Ungrouped devices</div>
      ${devices.filter(d => !d.groupId).map(d => `<div class="list-row">
        <span class="list-cell" style="flex:2;">${esc(d.name)}</span>
        <span class="list-cell" style="font-size:12px;color:var(--muted);">${esc(d.ip)}</span>
        <span class="list-cell sm">
          <select onchange="assignDeviceToGroup('${d.id}',this.value)" style="padding:3px 6px;border-radius:4px;background:#1B2129;color:#E8EAED;border:1px solid #2A333D;font-size:11px;">
            <option value="">No group</option>
            ${deviceGroups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join("")}
          </select>
        </span>
      </div>`).join("")}
    </div>` : ""}`;
}

async function createDeviceGroup() {
  const name = document.getElementById("dg-name").value.trim();
  const parentId = document.getElementById("dg-parent").value || null;
  const color = document.getElementById("dg-color").value;
  if (!name) { toast("Name required", "error"); return; }
  try {
    const res = await authFetch(`${API}/api/device-groups`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, parentId, color }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    await loadDeviceGroups();
    toast("Group created", "success");
    render();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function deleteDeviceGroup(id) {
  if (!confirm("Delete this group? Devices will be ungrouped.")) return;
  try {
    await authFetch(`${API}/api/device-groups/${id}`, { method: "DELETE" });
    await loadDeviceGroups();
    // Update local device state
    devices.forEach(d => { if (d.groupId === id) d.groupId = null; });
    toast("Group deleted", "success");
    render();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function assignDeviceToGroup(deviceId, groupId) {
  try {
    await authFetch(`${API}/api/devices/${deviceId}/group`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupId: groupId || null }) });
    const device = devices.find(d => d.id === deviceId);
    if (device) device.groupId = groupId || null;
    toast("Device assigned", "success");
    render();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

// ---------- Downtime ----------

const DOWNTIME_REASONS = [
  "Mechanical Failure",
  "Material shortage",
  "Changeover",
  "Power outage",
  "Operator break",
  "Quality hold",
  "Other",
];

async function loadDowntimeLogs() {
  const params = downtimeDeviceFilter ? `?deviceId=${downtimeDeviceFilter}` : "";
  const [logsRes, statsRes] = await Promise.all([
    authFetch(`${API}/api/downtime-logs${params}`),
    authFetch(`${API}/api/downtime-logs/stats${params}`),
  ]);
  downtimeLogs = await logsRes.json();
  downtimeStats = await statsRes.json();
  render();
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function viewDowntime() {
  const openLogs = downtimeLogs.filter(l => !l.endedAt);
  const closedLogs = downtimeLogs.filter(l => l.endedAt);
  const maxSeconds = downtimeStats.length ? Math.max(...downtimeStats.map(s => s.totalSeconds)) : 1;

  return `
    <div class="top-bar">
      <div>
        <h2>Downtime</h2>
        <div class="subtitle">${openLogs.length} open · ${closedLogs.length} resolved</div>
      </div>
      <div class="top-bar-actions">
        <select onchange="downtimeDeviceFilter=this.value;loadDowntimeLogs()" style="padding:6px 10px;border-radius:6px;background:#1B2129;color:#E8EAED;border:1px solid #2A333D;">
          <option value="">All devices</option>
          ${devices.map(d => `<option value="${d.id}" ${d.id === downtimeDeviceFilter ? "selected" : ""}>${esc(d.name)}</option>`).join("")}
        </select>
      </div>
    </div>

    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">Open downtime</div>
      ${openLogs.length ? `
        <div class="list-header"><span>Device</span><span>Started</span><span>Duration</span><span>Reason</span><span></span></div>
        ${openLogs.map(l => `<div class="list-row">
          <span class="list-cell">${esc(l.deviceName || l.deviceId)}</span>
          <span class="list-cell mono">${timeAgo(l.startedAt)}</span>
          <span class="list-cell mono">${formatDuration((Date.now() - new Date(l.startedAt).getTime()) / 1000)}</span>
          <span class="list-cell">${l.reasonCode ? esc(l.reasonCode) : `<span style="color:#E5484D;">unassigned</span>`}</span>
          <span class="list-cell sm">
            <select onchange="assignDowntimeReason('${l.id}',this.value)" style="padding:4px 8px;border-radius:4px;background:#1B2129;color:#E8EAED;border:1px solid #2A333D;font-size:12px;">
              <option value="">Assign reason...</option>
              ${DOWNTIME_REASONS.map(r => `<option value="${r}" ${r === l.reasonCode ? "selected" : ""}>${r}</option>`).join("")}
            </select>
          </span>
        </div>`).join("")}
      ` : `<div style="padding:20px;color:var(--muted);text-align:center;">No open downtime events.</div>`}
    </div>

    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">Downtime by reason</div>
      ${downtimeStats.length ? downtimeStats.map(s => {
        const pct = maxSeconds > 0 ? (s.totalSeconds / maxSeconds) * 100 : 0;
        return `<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
          <div style="width:140px;font-size:13px;text-align:right;color:#8B95A1;">${esc(s.reasonCode)}</div>
          <div style="flex:1;height:20px;background:#141922;border-radius:4px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:var(--accent,#F2B705);border-radius:4px;"></div>
          </div>
          <div style="width:100px;font-size:12px;color:#8B95A1;text-align:right;">${formatDuration(s.totalSeconds)} · ${s.count}x</div>
        </div>`;
      }).join("") : `<div style="padding:20px;color:var(--muted);text-align:center;">No downtime data yet.</div>`}
    </div>

    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">History</div>
      ${closedLogs.length ? `
        <div class="list-header"><span>Device</span><span>Started</span><span>Ended</span><span>Duration</span><span>Reason</span><span>Note</span><span>By</span></div>
        ${closedLogs.map(l => {
          const dur = l.endedAt ? (new Date(l.endedAt).getTime() - new Date(l.startedAt).getTime()) / 1000 : 0;
          return `<div class="list-row">
            <span class="list-cell">${esc(l.deviceName || l.deviceId)}</span>
            <span class="list-cell mono" style="font-size:11px;">${new Date(l.startedAt).toLocaleDateString()}</span>
            <span class="list-cell mono" style="font-size:11px;">${new Date(l.endedAt).toLocaleDateString()}</span>
            <span class="list-cell mono">${formatDuration(dur)}</span>
            <span class="list-cell">${l.reasonCode ? esc(l.reasonCode) : `<span style="color:#E5484D;">unassigned</span>`}</span>
            <span class="list-cell" style="font-size:11px;color:#5B6673;max-width:160px;overflow:hidden;text-overflow:ellipsis;">${esc(l.reasonNote || "")}</span>
            <span class="list-cell mono" style="font-size:11px;">${esc(l.reportedBy || "")}</span>
          </div>`;
        }).join("")}
      ` : `<div style="padding:20px;color:var(--muted);text-align:center;">No resolved downtime events yet.</div>`}
    </div>`;
}

async function assignDowntimeReason(id, reasonCode) {
  if (!reasonCode) return;
  const note = prompt("Optional note for this downtime event:", "") || "";
  try {
    const res = await authFetch(`${API}/api/downtime-logs/${id}/reason`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reasonCode, reasonNote: note }),
    });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    toast("Reason assigned", "success");
    await loadDowntimeLogs();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

// ---------- Engineering ----------

function viewEngineering() {
  const d = engineeringData;
  return `
    <div class="top-bar"><div><h2 style="color:#E5484D;">Engineering Mode</h2><div class="subtitle">Restricted — read-only diagnostics, admin-only config changes</div></div></div>
    <div class="form-card" style="border-color:#E5484D;">
      <div class="section-label mono" style="margin-bottom:10px;">Select device</div>
      <select onchange="selectEngineeringDevice(this.value)" style="max-width:400px;">
        <option value="">Choose a device…</option>
        ${devices.map(dv => `<option value="${dv.id}" ${dv.id === engineeringDeviceId ? "selected" : ""}>${esc(dv.name)}</option>`).join("")}
      </select>
      ${engineeringDeviceId ? `
        <div style="display:flex;gap:8px;margin:14px 0;flex-wrap:wrap;">
          <button class="btn" onclick="runEngineeringTestConnection()">Test connection</button>
          <button class="btn" onclick="runEngineeringTestDatapoint()">Test data point</button>
        </div>
        ${d.testConn && !d.testConn.loading ? `<div class="result-box ${d.testConn.success ? "success" : "error"}">Connection: ${esc(d.testConn.message)} (${d.testConn.latencyMs}ms)</div>` : ""}
        ${d.testDp && !d.testDp.loading ? `<div class="result-box ${d.testDp.success ? "success" : "error"}">Data point: ${esc(d.testDp.message)} — raw: ${d.testDp.rawValue ?? "n/a"} ${d.testDp.unit || ""} (${d.testDp.latencyMs}ms)</div>` : ""}

        <div class="section-label mono" style="margin:16px 0 8px;">Raw data</div>
        <pre class="mono" style="background:#141922;border:1px solid #2A333D;border-radius:6px;padding:10px;font-size:11px;color:#8B95A1;overflow-x:auto;">${d.raw ? esc(JSON.stringify(d.raw.rawReading, null, 2)) : "loading…"}</pre>

        <div class="section-label mono" style="margin:16px 0 8px;">Protocol config</div>
        ${hasRole("admin") ? `
          <textarea id="eng-config-json" class="mono" style="width:100%;min-height:100px;background:#141922;border:1px solid #2A333D;border-radius:6px;color:#E8EAED;padding:10px;font-size:11px;">${d.protocolConfig ? esc(JSON.stringify(d.protocolConfig.connectionConfig || {}, null, 2)) : ""}</textarea>
          <div style="display:flex;justify-content:flex-end;margin-top:8px;">
            <button class="btn btn-primary" onclick="saveEngineeringConfig()">Save (admin only)</button>
          </div>
        ` : `<pre class="mono" style="background:#141922;border:1px solid #2A333D;border-radius:6px;padding:10px;font-size:11px;color:#8B95A1;">${d.protocolConfig ? esc(JSON.stringify(d.protocolConfig.connectionConfig, null, 2)) : "loading…"}</pre>`}

        <div class="section-label mono" style="margin:16px 0 8px;">Comm log</div>
        ${d.commLog.map(e => `<div class="list-row">
          <span class="list-cell mono" style="flex:0 0 80px;">${new Date(e.ts).toLocaleTimeString()}</span>
          <span class="list-cell sm"><span class="status-badge ${e.success ? "active" : "critical"}">${e.success ? "OK" : "FAIL"}</span></span>
          <span class="list-cell">${esc(e.note || "")}</span>
          <span class="list-cell mono" style="flex:0 0 60px;">${e.latencyMs ? e.latencyMs + "ms" : ""}</span>
        </div>`).join("") || `<div class="empty">No communication yet.</div>`}
      ` : ""}
    </div>`;
}

// ---------- Sync ----------

function viewSync() {
  const s = syncStatus;
  return `
    <div class="top-bar"><div><h2>Multi-site Sync</h2></div></div>
    ${s ? `<div class="form-card">
      <div class="kv-row"><span class="kv-label">Role</span><span class="kv-value">${esc(s.role)}</span></div>
      ${s.role === "local" ? `<div class="kv-row"><span class="kv-label">Cloud URL</span><span class="kv-value">${esc(s.cloudUrl || "")}</span></div>
        <div class="kv-row"><span class="kv-label">Buffered records</span><span class="kv-value">${s.pendingCount}</span></div>` : ""}
    </div>` : ""}
    ${hasRole("admin") ? `
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">Site sync keys</div>
      ${newlyCreatedSyncKey ? `<div style="background:#141922;border:1px solid var(--accent);border-radius:8px;padding:12px;margin-bottom:12px;">
        <div style="font-size:11px;color:#8B95A1;text-transform:uppercase;margin-bottom:6px;">New key for "${esc(newlyCreatedSyncKey.siteLabel)}"</div>
        <div class="mono" style="font-size:13px;color:var(--accent);word-break:break-all;">${esc(newlyCreatedSyncKey.key)}</div>
      </div>` : ""}
      <button class="btn btn-primary" onclick="createSyncKey()" style="margin-bottom:12px;">+ New site key</button>
      ${syncKeys.map(k => `<div class="list-row">
        <span class="list-cell">${esc(k.siteLabel)}</span>
        <span class="list-cell mono">${esc(k.siteId)}</span>
        <span class="list-cell mono">${esc(k.keyPreview)}</span>
        <span class="list-cell sm"><button class="btn btn-sm btn-danger" onclick="revokeSyncKey('${k.id}')">Revoke</button></span>
      </div>`).join("") || `<div class="empty">No sites syncing in.</div>`}
    </div>` : ""}`;
}

// ---------- Audit Log ----------

function viewAudit() {
  return `
    <div class="top-bar"><div><h2>Audit Log</h2><div class="subtitle">${auditLog.length} entries</div></div>
      <div class="top-bar-actions">
        <button class="btn" onclick="exportAuditLog('csv')">Export CSV</button>
        <button class="btn" onclick="exportAuditLog('json')">Export JSON</button>
      </div></div>
    <div class="form-card">
      ${auditLog.map(e => `<div class="list-row">
        <span class="list-cell mono" style="flex:0 0 100px;">${timeAgo(e.ts)}</span>
        <span class="list-cell" style="flex:0 0 100px;">${esc(e.username)}</span>
        <span class="list-cell mono" style="flex:0 0 80px;">${esc(e.role)}</span>
        <span class="list-cell" style="color:var(--accent);flex:0 0 140px;">${esc(e.action)}</span>
        <span class="list-cell" style="color:#5B6673;font-size:11px;">${esc(JSON.stringify(e.details || {}))}</span>
      </div>`).join("") || `<div class="empty">No activity yet.</div>`}
    </div>`;
}

async function exportAuditLog(format) {
  try {
    const res = await authFetch(`${API}/api/audit-log/export?format=${format}&limit=5000`);
    const blob = await res.blob();
    const ext = format === "csv" ? "csv" : "json";
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `audit-log.${ext}`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
    toast(`Audit log exported as ${format.toUpperCase()}`, "success");
  } catch (e) { toast("Export failed: " + e.message, "error"); }
}

// ---------- Users ----------

function viewUsers() {
  return `
    <div class="top-bar"><div><h2>Users</h2><div class="subtitle">${users.length} accounts</div></div></div>
    ${hasRole("admin") ? `
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">Add user</div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 0.8fr auto;">
        <div><label>Username</label><input id="u-username" placeholder="jane" /></div>
        <div><label>Password</label><input id="u-password" type="password" placeholder="temporary" /></div>
        <div><label>Role</label><select id="u-role">${ROLES.map(r => `<option value="${r}">${r}</option>`).join("")}</select></div>
        <button class="btn btn-primary" onclick="createUser()">+ Add</button>
      </div>
    </div>` : ""}
    <div class="form-card">
      ${users.map(u => `<div class="list-row">
        <span class="list-cell">${esc(u.username)}</span>
        <span class="list-cell mono" style="flex:0 0 100px;">${esc(u.role)}</span>
        <span class="list-cell mono" style="flex:0 0 120px;">${new Date(u.createdAt).toLocaleDateString()}</span>
        <span class="list-cell sm">
          ${hasRole("admin") ? `<select onchange="changeUserRole('${u.id}',this.value)" style="width:auto;padding:4px 8px;">
            ${ROLES.map(r => `<option value="${r}" ${r === u.role ? "selected" : ""}>${r}</option>`).join("")}
          </select>` : ""}
          ${u.username !== currentUser?.username && hasRole("admin") ? `
            <button class="btn btn-sm" onclick="permUserId='${u.id}';render()" title="Device permissions">perms</button>
            <button class="btn btn-sm" onclick="anonymizeUser('${u.id}','${esc(u.username)}')" title="GDPR: Anonymize">anon</button>
            <button class="btn btn-sm" onclick="gdprDeleteUser('${u.id}','${esc(u.username)}')" title="GDPR: Delete all data">gdpr-del</button>
            <button class="btn btn-sm btn-danger" onclick="deleteUser('${u.id}')">Remove</button>` : ""}
          ${u.username === currentUser?.username ? `<span class="mono" style="color:#5B6673;font-size:11px;">(you)</span>` : ""}
        </span>
      </div>`).join("")}
    </div>
    <div class="form-card" style="margin-top:16px;">
      <div class="section-label mono" style="margin-bottom:10px;">GDPR — My Data</div>
      <p style="font-size:13px;color:var(--muted);margin-bottom:12px;">Export or delete your personal data as required by GDPR Article 15/17.</p>
      <div style="display:flex;gap:8px;">
        <button class="btn" onclick="exportMyData()">Export my data (JSON)</button>
        <button class="btn btn-danger" onclick="requestMyDataDeletion()">Request data deletion</button>
      </div>
    </div>`;
}

async function anonymizeUser(id, username) {
  if (!confirm(`Anonymize "${username}"? This replaces their username with a hash and invalidates all sessions.`)) return;
  try {
    await authFetch(`${API}/api/gdpr/anonymize/${id}`, { method: "POST" });
    toast("User anonymized", "success");
    users = await (await authFetch(`${API}/api/users`)).json();
    render();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function gdprDeleteUser(id, username) {
  if (!confirm(`PERMANENTLY DELETE all data for "${username}"? This cannot be undone.`)) return;
  const confirm2 = prompt(`Type "${username}" to confirm permanent deletion:`);
  if (confirm2 !== username) { toast("Confirmation mismatch", "error"); return; }
  try {
    await authFetch(`${API}/api/gdpr/delete-user/${id}`, { method: "DELETE" });
    toast("User and all data deleted", "success");
    users = await (await authFetch(`${API}/api/users`)).json();
    render();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function exportMyData() {
  try {
    const res = await authFetch(`${API}/api/gdpr/my-data`);
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `my-data-${currentUser.username}.json`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
    await authFetch(`${API}/api/gdpr/consent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "data_export", detail: "User requested GDPR data export" }) });
    toast("Data exported", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function requestMyDataDeletion() {
  if (!confirm("Request deletion of your account and all associated data? An admin must approve.")) return;
  try {
    await authFetch(`${API}/api/gdpr/consent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "deletion_request", detail: "User requested GDPR data deletion" }) });
    toast("Deletion request logged. An admin will review.", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

// ---------- SSO / SAML ----------

let ssoProviders = [];

async function loadSSOProviders() {
  try {
    const res = await authFetch(`${API}/api/sso/providers`);
    ssoProviders = await res.json();
  } catch (e) { console.error("loadSSOProviders:", e); }
}

function viewSSO() {
  return `
    <div class="top-bar"><div><h2>SSO / SAML Providers</h2><div class="subtitle">Enterprise single sign-on configuration</div></div>
      <div class="top-bar-actions"><button class="btn btn-primary" onclick="showSSOForm=!showSSOForm;render()">+ Add Provider</button></div></div>
    ${showSSOForm ? `
    <div class="form-card" style="border-left:3px solid #4FD1B5;">
      <div class="section-label mono" style="margin-bottom:10px;">Add SSO Provider</div>
      <div class="form-grid">
        <div><label>Provider Name</label><input id="sso-name" placeholder="Azure AD" /></div>
        <div><label>Type</label><select id="sso-type"><option value="oidc">OIDC</option><option value="saml">SAML 2.0</option></select></div>
        <div><label>Issuer URL</label><input id="sso-issuer" placeholder="https://login.microsoftonline.com/..." /></div>
        <div><label>Client ID</label><input id="sso-client-id" placeholder="your-app-id" /></div>
        <div><label>Client Secret</label><input id="sso-client-secret" type="password" placeholder="••••••" /></div>
        <div><label>Redirect URL</label><input id="sso-redirect" placeholder="http://localhost:4000/api/sso/callback" /></div>
        <div><label>Default Role</label><select id="sso-role">${ROLES.map(r => `<option value="${r}">${r}</option>`).join("")}</select></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button class="btn btn-primary" onclick="createSSOProvider()">Save Provider</button>
        <button class="btn" onclick="showSSOForm=false;render()">Cancel</button>
      </div>
    </div>` : ""}
    ${ssoProviders.length ? `
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">Configured Providers (${ssoProviders.length})</div>
      ${ssoProviders.map(p => `<div class="list-row" style="align-items:center;">
        <span class="list-cell" style="flex:0 0 30px;width:30px;height:30px;border-radius:50%;background:${p.type === "saml" ? "#4FD1C0" : "#4A90D9"};display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:700;">${p.type === "saml" ? "S" : "O"}</span>
        <span class="list-cell" style="flex:1;">
          <div style="font-weight:600;">${esc(p.name)}</div>
          <div class="mono" style="font-size:11px;color:#8B95A1;">${esc(p.type.toUpperCase())} · Default role: ${esc(p.defaultRole)}</div>
        </span>
        <span class="list-cell sm">
          <span class="status-badge ${p.enabled ? "status-ok" : "status-alert"}">${p.enabled ? "Enabled" : "Disabled"}</span>
          <button class="btn btn-sm" onclick="toggleSSOProvider('${p.id}',${!p.enabled})">${p.enabled ? "Disable" : "Enable"}</button>
          <button class="btn btn-sm btn-danger" onclick="deleteSSOProvider('${p.id}','${esc(p.name)}')">Delete</button>
        </span>
      </div>`).join("")}
    </div>` : `<div class="empty-state"><div class="empty-icon">🔑</div><div>No SSO providers configured.</div><div style="font-size:12px;color:#8B95A1;margin-top:6px;">Add a provider to enable enterprise single sign-on.</div></div>`}
    <div class="form-card" style="margin-top:16px;">
      <div class="section-label mono" style="margin-bottom:10px;">SSO Login Test</div>
      <p style="font-size:13px;color:var(--muted);margin-bottom:12px;">Simulate an SSO login to verify the flow. In production, users are redirected to the provider's login page.</p>
      <div class="form-grid" style="grid-template-columns:1fr 1fr auto;">
        <div><label>Provider Name</label><input id="sso-test-name" placeholder="Azure AD" /></div>
        <div><label>SSO Email</label><input id="sso-test-email" placeholder="user@company.com" /></div>
        <div style="display:flex;align-items:end;"><button class="btn" onclick="testSSOLogin()">Simulate SSO Login</button></div>
      </div>
    </div>`;
}

let showSSOForm = false;
let devicePermissions = [];
let showDevicePermForm = false;
let permUserId = "";
let deviceHealthScores = [];
let batches = [];
let showBatchForm = false;
let aiInsights = [];
let organizations = [];
let reportTemplates = [];
let showReportTemplateForm = false;
let integrations = [];
let integrationLogs = [];
let showIntegrationForm = false;
let apiUsageStats = null;

async function loadAIInsights() {
  try {
    const res = await authFetch(`${API}/api/ai-insights`);
    aiInsights = await res.json();
  } catch (e) { console.error("loadAIInsights:", e); }
}

async function runAIAnalysis() {
  try {
    const res = await authFetch(`${API}/api/ai-insights/analyze`, { method: "POST" });
    const data = await res.json();
    toast(`Analysis complete: ${data.newInsights} new insight(s)`, "success");
    await loadAIInsights();
    render();
  } catch (e) { toast("Analysis failed: " + e.message, "error"); }
}

async function acknowledgeInsight(id) {
  try {
    await authFetch(`${API}/api/ai-insights/${id}/acknowledge`, { method: "PUT" });
    await loadAIInsights();
    render();
    toast("Insight acknowledged", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function createSSOProvider() {
  const name = document.getElementById("sso-name").value.trim();
  const type = document.getElementById("sso-type").value;
  const issuerUrl = document.getElementById("sso-issuer").value.trim();
  const clientId = document.getElementById("sso-client-id").value.trim();
  const clientSecret = document.getElementById("sso-client-secret").value.trim();
  const redirectUrl = document.getElementById("sso-redirect").value.trim();
  const defaultRole = document.getElementById("sso-role").value;
  if (!name) { toast("Provider name required", "error"); return; }
  try {
    await authFetch(`${API}/api/sso/providers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, type, issuerUrl, clientId, clientSecret, redirectUrl, defaultRole }) });
    showSSOForm = false;
    await loadSSOProviders();
    render();
    toast("SSO provider added", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function toggleSSOProvider(id, enabled) {
  try {
    await authFetch(`${API}/api/sso/providers/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
    await loadSSOProviders();
    render();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function deleteSSOProvider(id, name) {
  if (!confirm(`Delete SSO provider "${name}"?`)) return;
  try {
    await authFetch(`${API}/api/sso/providers/${id}`, { method: "DELETE" });
    await loadSSOProviders();
    render();
    toast("Provider deleted", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function testSSOLogin() {
  const providerName = document.getElementById("sso-test-name").value.trim();
  const email = document.getElementById("sso-test-email").value.trim();
  if (!providerName || !email) { toast("Fill provider name and email", "error"); return; }
  try {
    const res = await fetch(`${API}/api/sso/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: providerName, token: "test-token", email }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast(`SSO login successful as ${data.user.username} (${data.user.role})`, "success");
  } catch (e) { toast("SSO login failed: " + e.message, "error"); }
}

// ---------- Device Permissions ----------

async function loadDevicePermissions() {
  try {
    const res = await authFetch(`${API}/api/device-permissions`);
    devicePermissions = await res.json();
  } catch (e) { console.error("loadDevicePermissions:", e); }
}

async function loadDeviceHealthScores() {
  try {
    const res = await authFetch(`${API}/api/device-health`);
    deviceHealthScores = await res.json();
  } catch (e) { console.error("loadDeviceHealthScores:", e); }
}

async function grantDevicePermission(userId, deviceId, permission) {
  try {
    await authFetch(`${API}/api/device-permissions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId, deviceId, permission }) });
    await loadDevicePermissions();
    render();
    toast("Device permission granted", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function revokeDevicePermission(id) {
  try {
    await authFetch(`${API}/api/device-permissions/${id}`, { method: "DELETE" });
    await loadDevicePermissions();
    render();
    toast("Permission revoked", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

function viewDevicePermissions(userId) {
  const userPerms = devicePermissions.filter(p => p.userId === userId);
  const user = users.find(u => u.id === userId);
  return `
    <div class="top-bar"><div><h2>Device Permissions — ${esc(user?.username || userId)}</h2></div>
      <div class="top-bar-actions"><button class="btn" onclick="permUserId='';showDevicePermForm=false;render()">← Back</button></div></div>
    ${hasRole("admin") ? `
    <div class="form-card" style="border-left:3px solid #4FD1B5;">
      <div class="section-label mono" style="margin-bottom:10px;">Grant Device Access</div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 0.8fr auto;">
        <div><label>Device</label><select id="perm-device">${devices.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}</select></div>
        <div><label>Permission</label><select id="perm-level"><option value="read">Read Only</option><option value="readwrite">Read + Write</option></select></div>
        <div></div>
        <button class="btn btn-primary" onclick="grantDevicePermission('${userId}',document.getElementById('perm-device').value,document.getElementById('perm-level').value)">Grant</button>
      </div>
    </div>` : ""}
    <div class="form-card">
      ${userPerms.length ? userPerms.map(p => `<div class="list-row">
        <span class="list-cell" style="flex:1;">${esc(p.deviceName || p.deviceId)}</span>
        <span class="list-cell mono" style="flex:0 0 100px;">${esc(p.permission)}</span>
        <span class="list-cell sm">
          <button class="btn btn-sm btn-danger" onclick="revokeDevicePermission('${p.id}')">Revoke</button>
        </span>
      </div>`).join("") : `<div class="empty-state"><div class="empty-icon">🔓</div><div>No device-specific permissions.</div><div style="font-size:12px;color:#8B95A1;margin-top:6px;">All devices are accessible based on role.</div></div>`}
    </div>`;
}

// ---------- Batch / Lot Tracking ----------

async function loadBatches(status) {
  try {
    const res = await authFetch(`${API}/api/batches${status ? "?status=" + status : ""}`);
    batches = await res.json();
  } catch (e) { console.error("loadBatches:", e); }
}

function viewBatches() {
  const activeCount = batches.filter(b => b.status === "active").length;
  const completedCount = batches.filter(b => b.status === "completed").length;
  return `
    <div class="top-bar"><div><h2>Batch / Lot Tracking</h2><div class="subtitle">${batches.length} batches · ${activeCount} active</div></div>
      <div class="top-bar-actions">
        <button class="btn" onclick="loadBatches();render()">Refresh</button>
        <button class="btn btn-primary" onclick="showBatchForm=!showBatchForm;render()">+ New Batch</button>
      </div></div>
    ${showBatchForm ? `
    <div class="form-card" style="border-left:3px solid #4FD1B5;">
      <div class="section-label mono" style="margin-bottom:10px;">Create Batch</div>
      <div class="form-grid">
        <div><label>Batch Name *</label><input id="bt-name" placeholder="LOT-2026-001" /></div>
        <div><label>Customer</label><input id="bt-customer" placeholder="Customer ABC" /></div>
        <div><label>Product</label><select id="bt-product"><option value="">— none —</option>${products.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></div>
        <div><label>Device</label><select id="bt-device"><option value="">— any —</option>${devices.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}</select></div>
        <div><label>Target Bags</label><input id="bt-target" type="number" placeholder="1000" /></div>
        <div><label>Notes</label><input id="bt-notes" placeholder="Production notes..." /></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button class="btn btn-primary" onclick="createBatch()">Start Batch</button>
        <button class="btn" onclick="showBatchForm=false;render()">Cancel</button>
      </div>
    </div>` : ""}
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">Batches</div>
      ${batches.length ? batches.map(b => {
        const product = b.productId ? products.find(p => p.id === b.productId) : null;
        const device = b.deviceId ? devices.find(d => d.id === b.deviceId) : null;
        const pct = b.targetBags ? Math.round((b.totalBags / b.targetBags) * 100) : null;
        return `<div class="list-row" style="align-items:center;">
          <span class="list-cell" style="flex:0 0 24px;width:24px;height:24px;border-radius:50%;background:${b.status === "active" ? "#4FD1B5" : b.status === "completed" ? "#4A90D9" : "#5B6673"};display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;">${b.status === "active" ? "▸" : b.status === "completed" ? "✓" : "—"}</span>
          <span class="list-cell" style="flex:1;">
            <div style="font-weight:600;">${esc(b.name)}</div>
            <div class="mono" style="font-size:11px;color:#8B95A1;">
              ${esc(b.customer || "No customer")} · ${product ? esc(product.name) : "Any product"} · ${device ? esc(device.name) : "Any device"}
            </div>
          </span>
          <span class="list-cell" style="flex:0 0 160px;">
            ${pct !== null ? `<div style="height:4px;background:#1B2129;border-radius:2px;overflow:hidden;margin-bottom:4px;"><div style="height:100%;width:${Math.min(pct, 100)}%;background:${pct >= 100 ? "#4FD1B5" : "#4A90D9"};transition:width 0.3s;"></div></div><div class="mono" style="font-size:11px;color:#8B95A1;">${b.totalBags}/${b.targetBags} bags (${pct}%)</div>` : `<div class="mono" style="font-size:11px;color:#8B95A1;">${b.totalBags} bags</div>`}
          </span>
          <span class="list-cell sm">
            <span class="status-badge ${b.status === "active" ? "status-ok" : b.status === "completed" ? "status-needs-cal" : "status-offline"}">${b.status}</span>
            ${b.status === "active" ? `<button class="btn btn-sm" onclick="completeBatch('${b.id}')">Complete</button>` : ""}
            <button class="btn btn-sm btn-danger" onclick="deleteBatch('${b.id}','${esc(b.name)}')">Delete</button>
          </span>
        </div>`;
      }).join("") : `<div class="empty-state"><div class="empty-icon">📦</div><div>No batches yet.</div><div style="font-size:12px;color:#8B95A1;margin-top:6px;">Create a batch to start tracking production lots.</div></div>`}
    </div>`;
}

async function createBatch() {
  const name = document.getElementById("bt-name").value.trim();
  const customer = document.getElementById("bt-customer").value.trim();
  const productId = document.getElementById("bt-product").value || null;
  const deviceId = document.getElementById("bt-device").value || null;
  const targetBags = document.getElementById("bt-target").value ? parseInt(document.getElementById("bt-target").value) : null;
  const notes = document.getElementById("bt-notes").value.trim();
  if (!name) { toast("Batch name required", "error"); return; }
  try {
    await authFetch(`${API}/api/batches`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, customer, productId, deviceId, targetBags, notes }) });
    showBatchForm = false;
    await loadBatches();
    render();
    toast("Batch created", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function completeBatch(id) {
  try {
    await authFetch(`${API}/api/batches/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "completed" }) });
    await loadBatches();
    render();
    toast("Batch completed", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function deleteBatch(id, name) {
  if (!confirm(`Delete batch "${name}"?`)) return;
  try {
    await authFetch(`${API}/api/batches/${id}`, { method: "DELETE" });
    await loadBatches();
    render();
    toast("Batch deleted", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

// ---------- AI Insights ----------

function viewAIInsights() {
  const unacknowledged = aiInsights.filter(i => !i.acknowledged).length;
  const criticalCount = aiInsights.filter(i => i.severity === "critical" && !i.acknowledged).length;
  const warningCount = aiInsights.filter(i => i.severity === "warning" && !i.acknowledged).length;

  return `
    <div class="top-bar"><div><h2>AI Insights</h2><div class="subtitle">${aiInsights.length} total · ${unacknowledged} new</div></div>
      <div class="top-bar-actions">
        <button class="btn" onclick="loadAIInsights();render()">Refresh</button>
        <button class="btn btn-primary" onclick="runAIAnalysis()">Run Analysis</button>
      </div></div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px;">
      <div class="form-card" style="text-align:center;border-left:3px solid #E5484D;">
        <div style="font-size:24px;font-weight:700;color:#E5484D;">${criticalCount}</div>
        <div style="font-size:12px;color:#8B95A1;">Critical</div>
      </div>
      <div class="form-card" style="text-align:center;border-left:3px solid #F2B705;">
        <div style="font-size:24px;font-weight:700;color:#F2B705;">${warningCount}</div>
        <div style="font-size:12px;color:#8B95A1;">Warnings</div>
      </div>
      <div class="form-card" style="text-align:center;border-left:3px solid #4FD1B5;">
        <div style="font-size:24px;font-weight:700;color:#4FD1B5;">${aiInsights.filter(i => i.type === "drift").length}</div>
        <div style="font-size:12px;color:#8B95A1;">Drift Alerts</div>
      </div>
    </div>
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">Recent Insights</div>
      ${aiInsights.length ? aiInsights.map(i => {
        const device = devices.find(d => d.id === i.deviceId);
        const sevColor = i.severity === "critical" ? "#E5484D" : i.severity === "warning" ? "#F2B705" : "#4A90D9";
        const typeIcon = i.type === "drift" ? "📊" : i.type === "maintenance_due" ? "🔧" : i.type === "precision_drop" ? "🎯" : "💡";
        return `<div class="list-row" style="align-items:flex-start;${i.acknowledged ? "opacity:0.5;" : ""}">
          <span class="list-cell" style="flex:0 0 24px;width:24px;height:24px;border-radius:50%;background:${sevColor};display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;">${typeIcon}</span>
          <span class="list-cell" style="flex:1;">
            <div style="font-weight:600;color:${sevColor};">${esc(i.title)}</div>
            <div style="font-size:12px;color:#8B95A1;margin-top:2px;">${esc(device?.name || i.deviceId)} · ${timeAgo(i.createdAt)} · Confidence: ${Math.round((i.confidence || 0) * 100)}%</div>
            <div style="font-size:12px;color:#5B6673;margin-top:4px;">${esc(i.description)}</div>
          </span>
          <span class="list-cell sm">
            ${!i.acknowledged ? `<button class="btn btn-sm" onclick="acknowledgeInsight('${i.id}')">Ack</button>` : `<span class="mono" style="font-size:10px;color:#5B6673;">ACK'd</span>`}
          </span>
        </div>`;
      }).join("") : `<div class="empty-state"><div class="empty-icon">🤖</div><div>No insights yet.</div><div style="font-size:12px;color:#8B95A1;margin-top:6px;">Click "Run Analysis" to scan devices for patterns.</div></div>`}
    </div>
    <div class="form-card" style="margin-top:16px;">
      <div class="section-label mono" style="margin-bottom:10px;">What AI Monitors</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
        <div style="font-size:12px;"><strong>📊 Weight Drift</strong><br/>Detects gradual shifts in fill weight over time. Alerts when mean drifts >1% from target.</div>
        <div style="font-size:12px;"><strong>🔧 Predictive Maintenance</strong><br/>Tracks days since last maintenance. Warns when approaching the 30-day interval.</div>
        <div style="font-size:12px;"><strong>🎯 Precision Drop</strong><br/>Monitors Cpk degradation. Flags when process capability drops below 80% of baseline.</div>
      </div>
    </div>`;
}

// ---------- Organizations ----------

function viewOrganizations() {
  return `
    <div class="top-bar"><div><h2>Organizations</h2><div class="subtitle">${organizations.length} tenants</div></div>
      <div class="top-bar-actions"><button class="btn btn-primary" onclick="showOrgForm=!showOrgForm;render()">+ New Organization</button></div></div>
    ${showOrgForm ? `
    <div class="form-card" style="border-left:3px solid #4FD1B5;">
      <div class="section-label mono" style="margin-bottom:10px;">Create Organization</div>
      <div class="form-grid">
        <div><label>Name *</label><input id="org-name" placeholder="Acme Corp" /></div>
        <div><label>Plan</label><select id="org-plan"><option value="free">Free</option><option value="starter">Starter</option><option value="pro">Pro</option><option value="enterprise">Enterprise</option></select></div>
        <div><label>Max Devices</label><input id="org-max-devices" type="number" value="10" /></div>
        <div><label>Max Users</label><input id="org-max-users" type="number" value="5" /></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button class="btn btn-primary" onclick="createOrg()">Create</button>
        <button class="btn" onclick="showOrgForm=false;render()">Cancel</button>
      </div>
    </div>` : ""}
    <div class="form-card">
      ${organizations.length ? organizations.map(o => {
        const orgUsers = users.filter(u => u.orgId === o.id);
        const orgDevices = devices.filter(d => d.orgId === o.id);
        const planColor = { free: "#5B6673", starter: "#4A90D9", pro: "#F2B705", enterprise: "#4FD1B5" }[o.plan] || "#5B6673";
        return `<div class="list-row" style="align-items:center;">
          <span class="list-cell" style="flex:0 0 30px;width:30px;height:30px;border-radius:50%;background:${planColor};display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;">${o.name.charAt(0)}</span>
          <span class="list-cell" style="flex:1;">
            <div style="font-weight:600;">${esc(o.name)}</div>
            <div class="mono" style="font-size:11px;color:#8B95A1;">${esc(o.slug)} · ${esc(o.plan)} · ${orgUsers.length}/${o.maxUsers} users · ${orgDevices.length}/${o.maxDevices} devices</div>
          </span>
          <span class="list-cell sm">
            <span class="status-badge ${o.enabled ? "status-ok" : "status-alert"}">${o.enabled ? "Active" : "Disabled"}</span>
            <button class="btn btn-sm" onclick="toggleOrg('${o.id}',${!o.enabled})">${o.enabled ? "Disable" : "Enable"}</button>
            <button class="btn btn-sm btn-danger" onclick="deleteOrg('${o.id}','${esc(o.name)}')">Delete</button>
          </span>
        </div>`;
      }).join("") : `<div class="empty-state"><div class="empty-icon">🏢</div><div>No organizations yet.</div><div style="font-size:12px;color:#8B95A1;margin-top:6px;">Create an organization to enable multi-tenant data isolation.</div></div>`}
    </div>`;
}

let showOrgForm = false;

async function createOrg() {
  const name = document.getElementById("org-name").value.trim();
  const plan = document.getElementById("org-plan").value;
  const maxDevices = parseInt(document.getElementById("org-max-devices").value) || 10;
  const maxUsers = parseInt(document.getElementById("org-max-users").value) || 5;
  if (!name) { toast("Name required", "error"); return; }
  try {
    await authFetch(`${API}/api/organizations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, plan, maxDevices, maxUsers }) });
    showOrgForm = false;
    organizations = await (await authFetch(`${API}/api/organizations`)).json();
    render();
    toast("Organization created", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function toggleOrg(id, enabled) {
  try {
    await authFetch(`${API}/api/organizations/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
    organizations = await (await authFetch(`${API}/api/organizations`)).json();
    render();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function deleteOrg(id, name) {
  if (!confirm(`Delete organization "${name}"? Users and devices will be unlinked.`)) return;
  try {
    await authFetch(`${API}/api/organizations/${id}`, { method: "DELETE" });
    organizations = await (await authFetch(`${API}/api/organizations`)).json();
    render();
    toast("Organization deleted", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

// ---------- Report Builder ----------

function viewReportBuilder() {
  return `
    <div class="top-bar"><div><h2>Report Builder</h2><div class="subtitle">${reportTemplates.length} templates</div></div>
      <div class="top-bar-actions"><button class="btn btn-primary" onclick="showReportTemplateForm=!showReportTemplateForm;render()">+ New Template</button></div></div>
    ${showReportTemplateForm ? `
    <div class="form-card" style="border-left:3px solid #4FD1B5;">
      <div class="section-label mono" style="margin-bottom:10px;">Create Report Template</div>
      <div class="form-grid">
        <div><label>Report Name *</label><input id="rpt-name" placeholder="Daily Production Report" /></div>
        <div><label>Report Type</label><select id="rpt-type"><option value="readings">Readings</option><option value="alerts">Alerts</option><option value="production">Production Batches</option></select></div>
      </div>
      <div class="form-grid" style="margin-top:8px;">
        <div><label>From Date</label><input id="rpt-from" type="date" /></div>
        <div><label>To Date</label><input id="rpt-to" type="date" /></div>
        <div><label>Limit</label><input id="rpt-limit" type="number" value="1000" /></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button class="btn btn-primary" onclick="createReportTemplate()">Save Template</button>
        <button class="btn" onclick="showReportTemplateForm=false;render()">Cancel</button>
      </div>
    </div>` : ""}
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">Saved Templates</div>
      ${reportTemplates.length ? reportTemplates.map(t => `<div class="list-row" style="align-items:center;">
        <span class="list-cell" style="flex:0 0 24px;width:24px;height:24px;border-radius:50%;background:${t.type === "readings" ? "#4A90D9" : t.type === "alerts" ? "#E5484D" : "#4FD1B5"};display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;">${t.type === "readings" ? "R" : t.type === "alerts" ? "A" : "P"}</span>
        <span class="list-cell" style="flex:1;">
          <div style="font-weight:600;">${esc(t.name)}</div>
          <div class="mono" style="font-size:11px;color:#8B95A1;">${esc(t.type)} · ${timeAgo(t.createdAt)}</div>
        </span>
        <span class="list-cell sm">
          <button class="btn btn-sm" onclick="generateReport('${t.id}','json')">Preview</button>
          <button class="btn btn-sm" onclick="generateReport('${t.id}','csv')">Export CSV</button>
          <button class="btn btn-sm btn-danger" onclick="deleteReportTemplate('${t.id}','${esc(t.name)}')">Delete</button>
        </span>
      </div>`).join("") : `<div class="empty-state"><div class="empty-icon">📋</div><div>No report templates yet.</div><div style="font-size:12px;color:#8B95A1;margin-top:6px;">Create a template to generate custom reports.</div></div>`}
    </div>`;
}

async function createReportTemplate() {
  const name = document.getElementById("rpt-name").value.trim();
  const type = document.getElementById("rpt-type").value;
  const from = document.getElementById("rpt-from").value || null;
  const to = document.getElementById("rpt-to").value || null;
  const limit = parseInt(document.getElementById("rpt-limit").value) || 1000;
  if (!name) { toast("Name required", "error"); return; }
  const config = { from, to, limit };
  try {
    await authFetch(`${API}/api/report-templates`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, type, config }) });
    showReportTemplateForm = false;
    reportTemplates = await (await authFetch(`${API}/api/report-templates`)).json();
    render();
    toast("Template created", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function generateReport(templateId, format) {
  try {
    if (format === "csv") {
      const res = await authFetch(`${API}/api/report-templates/${templateId}/generate?format=csv`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const blob = await res.blob();
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `report.csv`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
      toast("Report exported as CSV", "success");
    } else {
      const res = await authFetch(`${API}/api/report-templates/${templateId}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `report.json`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
      toast(`Report generated: ${data.rowCount} rows`, "success");
    }
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function deleteReportTemplate(id, name) {
  if (!confirm(`Delete template "${name}"?`)) return;
  try {
    await authFetch(`${API}/api/report-templates/${id}`, { method: "DELETE" });
    reportTemplates = await (await authFetch(`${API}/api/report-templates`)).json();
    render();
    toast("Template deleted", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

// ---------- Integration Hub ----------

function viewIntegrations() {
  return `
    <div class="top-bar"><div><h2>Integration Hub</h2><div class="subtitle">${integrations.length} integrations</div></div>
      <div class="top-bar-actions">
        <button class="btn" onclick="loadIntegrationLogs();render()">View Logs</button>
        <button class="btn btn-primary" onclick="showIntegrationForm=!showIntegrationForm;render()">+ New Integration</button>
      </div></div>
    ${showIntegrationForm ? `
    <div class="form-card" style="border-left:3px solid #4FD1B5;">
      <div class="section-label mono" style="margin-bottom:10px;">Add Integration</div>
      <div class="form-grid">
        <div><label>Name *</label><input id="int-name" placeholder="ERP Connector" /></div>
        <div><label>Type</label><select id="int-type"><option value="webhook">Webhook</option><option value="erp">ERP/MES</option><option value="mqtt">MQTT</option><option value="opcua">OPC-UA</option></select></div>
        <div><label>URL / Endpoint</label><input id="int-url" placeholder="https://api.example.com/webhook" /></div>
        <div><label>API Key</label><input id="int-apikey" type="password" placeholder="••••••" /></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button class="btn btn-primary" onclick="createIntegration()">Save</button>
        <button class="btn" onclick="showIntegrationForm=false;render()">Cancel</button>
      </div>
    </div>` : ""}
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">Active Integrations</div>
      ${integrations.length ? integrations.map(i => {
        const typeColors = { webhook: "#4A90D9", erp: "#4FD1B5", mqtt: "#F2B705", opcua: "#E5484D" };
        return `<div class="list-row" style="align-items:center;">
          <span class="list-cell" style="flex:0 0 24px;width:24px;height:24px;border-radius:50%;background:${typeColors[i.type] || "#5B6673"};display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;">${i.type.charAt(0).toUpperCase()}</span>
          <span class="list-cell" style="flex:1;">
            <div style="font-weight:600;">${esc(i.name)}</div>
            <div class="mono" style="font-size:11px;color:#8B95A1;">${esc(i.type)} · ${i.config?.url ? esc(i.config.url.slice(0, 40)) : "No URL"}</div>
          </span>
          <span class="list-cell sm">
            <span class="status-badge ${i.enabled ? "status-ok" : "status-alert"}">${i.enabled ? "Active" : "Disabled"}</span>
            <button class="btn btn-sm" onclick="testIntegration('${i.id}')">Test</button>
            <button class="btn btn-sm" onclick="toggleIntegration('${i.id}',${!i.enabled})">${i.enabled ? "Disable" : "Enable"}</button>
            <button class="btn btn-sm btn-danger" onclick="deleteIntegration('${i.id}','${esc(i.name)}')">Delete</button>
          </span>
        </div>`;
      }).join("") : `<div class="empty-state"><div class="empty-icon">🔗</div><div>No integrations configured.</div><div style="font-size:12px;color:#8B95A1;margin-top:6px;">Connect to ERP, MES, MQTT, or external APIs.</div></div>`}
    </div>
    ${integrationLogs.length ? `
    <div class="form-card" style="margin-top:16px;">
      <div class="section-label mono" style="margin-bottom:10px;">Recent Logs</div>
      ${integrationLogs.slice(0, 20).map(l => {
        const intg = integrations.find(i => i.id === l.integrationId);
        return `<div class="list-row" style="align-items:center;font-size:12px;">
          <span class="list-cell mono" style="flex:0 0 80px;">${timeAgo(l.createdAt)}</span>
          <span class="list-cell" style="flex:0 0 120px;">${esc(intg?.name || l.integrationId)}</span>
          <span class="list-cell" style="flex:0 0 60px;">${esc(l.direction)}</span>
          <span class="list-cell" style="flex:0 0 60px;"><span class="status-badge ${l.status === "success" ? "status-ok" : "status-alert"}">${l.status}</span></span>
          <span class="list-cell" style="color:#5B6673;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(l.error || JSON.stringify(l.response || {}).slice(0, 80))}</span>
        </div>`;
      }).join("")}
    </div>` : ""}`;
}

async function loadIntegrationLogs() {
  try {
    const res = await authFetch(`${API}/api/integration-logs`);
    integrationLogs = await res.json();
  } catch (e) { console.error("loadIntegrationLogs:", e); }
}

async function createIntegration() {
  const name = document.getElementById("int-name").value.trim();
  const type = document.getElementById("int-type").value;
  const url = document.getElementById("int-url").value.trim();
  const apiKey = document.getElementById("int-apikey").value.trim();
  if (!name) { toast("Name required", "error"); return; }
  const config = { url, apiKey };
  try {
    await authFetch(`${API}/api/integrations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, type, config }) });
    showIntegrationForm = false;
    integrations = await (await authFetch(`${API}/api/integrations`)).json();
    render();
    toast("Integration created", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function testIntegration(id) {
  try {
    const res = await authFetch(`${API}/api/integrations/${id}/test`, { method: "POST" });
    const data = await res.json();
    toast(`Test ${data.status}: ${data.statusCode || data.error}`, data.status === "success" ? "success" : "error");
    await loadIntegrationLogs();
  } catch (e) { toast("Test failed: " + e.message, "error"); }
}

async function toggleIntegration(id, enabled) {
  try {
    await authFetch(`${API}/api/integrations/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
    integrations = await (await authFetch(`${API}/api/integrations`)).json();
    render();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function deleteIntegration(id, name) {
  if (!confirm(`Delete integration "${name}"?`)) return;
  try {
    await authFetch(`${API}/api/integrations/${id}`, { method: "DELETE" });
    integrations = await (await authFetch(`${API}/api/integrations`)).json();
    render();
    toast("Integration deleted", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

// ---------- API Usage ----------

async function loadAPIUsage(days = 7) {
  try {
    const res = await authFetch(`${API}/api/usage/stats?days=${days}`);
    apiUsageStats = await res.json();
    render();
  } catch (e) { console.error("loadAPIUsage:", e); }
}

function viewAPIUsage() {
  if (!apiUsageStats) loadAPIUsage();
  const stats = apiUsageStats || { topUsers: [], topEndpoints: [], dailyTotals: [], totalRequests: 0 };

  return `
    <div class="top-bar"><div><h2>API Usage & Rate Limiting</h2><div class="subtitle">${stats.totalRequests.toLocaleString()} requests (7d)</div></div>
      <div class="top-bar-actions">
        <select onchange="loadAPIUsage(this.value)" style="padding:6px 12px;border-radius:6px;background:#1B2129;color:#E8EAED;border:1px solid #2A333D;">
          <option value="1">Last 24 hours</option>
          <option value="7" selected>Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </select>
        <button class="btn" onclick="loadAPIUsage()">Refresh</button>
      </div></div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px;">
      <div class="form-card" style="text-align:center;border-left:3px solid #4FD1B5;">
        <div style="font-size:24px;font-weight:700;color:#4FD1B5;">${stats.totalRequests.toLocaleString()}</div>
        <div style="font-size:12px;color:#8B95A1;">Total Requests</div>
      </div>
      <div class="form-card" style="text-align:center;border-left:3px solid #E5484D;">
        <div style="font-size:24px;font-weight:700;color:#E5484D;">${stats.topUsers.reduce((s, u) => s + u.errors, 0).toLocaleString()}</div>
        <div style="font-size:12px;color:#8B95A1;">Errors (4xx/5xx)</div>
      </div>
      <div class="form-card" style="text-align:center;border-left:3px solid #4A90D9;">
        <div style="font-size:24px;font-weight:700;color:#4A90D9;">${stats.topUsers.length}</div>
        <div style="font-size:12px;color:#8B95A1;">Active Users</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div class="form-card">
        <div class="section-label mono" style="margin-bottom:10px;">Top Users</div>
        ${stats.topUsers.length ? stats.topUsers.map(u => {
          const user = users.find(usr => usr.id === u.userId);
          const errRate = u.total > 0 ? Math.round((u.errors / u.total) * 100) : 0;
          return `<div class="list-row">
            <span class="list-cell" style="flex:1;">${esc(user?.username || u.userId)}</span>
            <span class="list-cell mono" style="flex:0 0 80px;">${u.total.toLocaleString()} req</span>
            <span class="list-cell mono" style="flex:0 0 60px;color:${errRate > 5 ? "#E5484D" : "#4FD1B5"};">${errRate}% err</span>
          </div>`;
        }).join("") : `<div class="empty-state" style="padding:20px;"><div style="font-size:12px;color:#8B95A1;">No usage data yet.</div></div>`}
      </div>
      <div class="form-card">
        <div class="section-label mono" style="margin-bottom:10px;">Top Endpoints</div>
        ${stats.topEndpoints.length ? stats.topEndpoints.slice(0, 10).map(e => `<div class="list-row">
          <span class="list-cell" style="flex:0 0 50px;"><span class="mono" style="font-size:10px;padding:2px 6px;border-radius:3px;background:${e.method === "GET" ? "#4FD1B533" : e.method === "POST" ? "#4A90D933" : "#F2B70533"};color:${e.method === "GET" ? "#4FD1B5" : e.method === "POST" ? "#4A90D9" : "#F2B705"};">${e.method}</span></span>
          <span class="list-cell mono" style="flex:1;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(e.endpoint)}</span>
          <span class="list-cell mono" style="flex:0 0 60px;">${e.total.toLocaleString()}</span>
        </div>`).join("") : `<div class="empty-state" style="padding:20px;"><div style="font-size:12px;color:#8B95A1;">No usage data yet.</div></div>`}
      </div>
    </div>
    <div class="form-card" style="margin-top:16px;">
      <div class="section-label mono" style="margin-bottom:10px;">Rate Limiting</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
        <div style="font-size:12px;"><strong>Window</strong><br/>1 minute sliding window</div>
        <div style="font-size:12px;"><strong>Max Requests</strong><br/>200 requests per window (configurable via RATE_LIMIT_MAX env)</div>
        <div style="font-size:12px;"><strong>Headers</strong><br/>X-RateLimit-Limit, X-RateLimit-Remaining returned on every response</div>
      </div>
    </div>`;
}

// ---------- Wizard ----------

function renderWizard() {
  if (wizardStep === 8) {
    return `<div class="form-card" style="text-align:center;padding:32px;">
      <div style="font-size:32px;color:#4FD1B5;margin-bottom:10px;">✓</div>
      <div style="font-size:16px;font-weight:600;margin-bottom:6px;">Device activated</div>
      <div style="font-size:13px;color:#8B95A1;margin-bottom:20px;">${esc(wizardData.name)} is live — the gateway will poll it on its next cycle.</div>
      <button class="btn btn-primary" onclick="closeWizard()">Done</button>
    </div>`;
  }

  const labels = ["Info", "Protocol", "Connect", "Data point", "Read test", "Validate", "Activate"];
  let stepContent = "";

  if (wizardStep === 1) {
    stepContent = `
      <div class="form-grid" style="grid-template-columns:1fr 1fr;">
        <div><label>Device name</label><input id="wz-name" value="${esc(wizardData.name)}" placeholder="Line 3 – Filler C" oninput="wizardData.name=this.value" /></div>
        <div><label>IP address</label><input id="wz-ip" value="${esc(wizardData.ip)}" placeholder="10.20.4.25" oninput="wizardData.ip=this.value" /></div>
      </div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;margin-top:12px;">
        <div><label>Product</label><select onchange="wizardSelectProduct(this.value)"><option value="">None</option>${products.filter(p => p.status === "active").map(p => `<option value="${p.id}" ${p.id === wizardData.productId ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
        <div><label>Target</label><input id="wz-target" value="${wizardData.target}" oninput="wizardData.target=this.value" ${wizardData.productId ? "disabled" : ""} /></div>
        <div><label>Cost/kg</label><input id="wz-cost" value="${wizardData.costPerUnit}" oninput="wizardData.costPerUnit=this.value" /></div>
      </div>`;
  } else if (wizardStep === 2) {
    stepContent = `
      <div style="margin-bottom:14px;"><label>Template</label><select onchange="wizardApplyTemplate(this.value)"><option value="">Manual config</option>${templates.map(t => `<option value="${t.id}" ${t.id === wizardData.templateId ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;">
        <div><label>Protocol</label><select onchange="wizardSetProtocolManually(this.value)">${PROTOCOLS.map(p => `<option value="${p}" ${p === wizardData.protocol ? "selected" : ""}>${p}</option>`).join("")}</select></div>
        <div><label>IP Address</label><input value="${esc(wizardData.ip || "")}" oninput="wizardData.ip=this.value" placeholder="192.168.1.100" /></div>
        <div><label>Port</label><input value="${wizardData.port ?? ""}" oninput="wizardData.port=this.value" placeholder="${wizardData.protocol?.includes('Modbus') ? '502' : wizardData.protocol === 'OPC-UA' ? '4840' : wizardData.protocol === 'MQTT' ? '1883' : wizardData.protocol === 'SNMP' ? '161' : '8080'}" /></div>
      </div>
      ${wizardData.protocol?.includes('Modbus') ? `
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;margin-top:8px;">
        <div><label>Unit ID</label><input value="${wizardData.modbusUnitId || 1}" oninput="wizardData.modbusUnitId=this.value" placeholder="1" /></div>
        <div><label>Connection</label><select onchange="wizardData.connectionType=this.value"><option value="tcp">TCP</option><option value="rtu">Serial (RTU)</option></select></div>
        <div><label>Weight Format</label><select onchange="wizardData.weightFormat=this.value"><option value="float32">Float32</option><option value="int32">Int32</option><option value="int16">Int16</option><option value="bcd">BCD</option></select></div>
      </div>
      ${wizardData.connectionType === 'rtu' ? `
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;margin-top:8px;">
        <div><label>Serial Port</label><input value="${wizardData.serialPort || ''}" oninput="wizardData.serialPort=this.value" placeholder="/dev/ttyUSB0" /></div>
        <div><label>Baud Rate</label><select onchange="wizardData.baudRate=this.value"><option value="9600">9600</option><option value="19200">19200</option><option value="38400">38400</option><option value="57600">57600</option><option value="115200">115200</option></select></div>
        <div><label>Parity</label><select onchange="wizardData.serialParity=this.value"><option value="none">None</option><option value="even">Even</option><option value="odd">Odd</option></select></div>
      </div>` : ""}` : ""}
      ${wizardData.protocol === 'OPC-UA' ? `
      <div class="form-grid" style="grid-template-columns:1fr 1fr;margin-top:8px;">
        <div><label>Weight Node ID</label><input value="${wizardData.opcuaWeightNode || 'ns=2;s=Weight'}" oninput="wizardData.opcuaWeightNode=this.value" placeholder="ns=2;s=Weight" /></div>
        <div><label>Status Node ID</label><input value="${wizardData.opcuaStatusNode || 'ns=2;s=Status'}" oninput="wizardData.opcuaStatusNode=this.value" placeholder="ns=2;s=Status" /></div>
      </div>` : ""}
      ${wizardData.protocol === 'MQTT' ? `
      <div class="form-grid" style="grid-template-columns:1fr 1fr;margin-top:8px;">
        <div><label>Broker URL</label><input value="${wizardData.mqttBroker || ''}" oninput="wizardData.mqttBroker=this.value" placeholder="mqtt://broker.hivemq.com:1883" /></div>
        <div><label>Topic</label><input value="${wizardData.mqttTopic || 'scale/weight'}" oninput="wizardData.mqttTopic=this.value" placeholder="scale/weight" /></div>
      </div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr;margin-top:8px;">
        <div><label>Username (optional)</label><input value="${wizardData.mqttUsername || ''}" oninput="wizardData.mqttUsername=this.value" /></div>
        <div><label>Password (optional)</label><input type="password" value="${wizardData.mqttPassword || ''}" oninput="wizardData.mqttPassword=this.value" /></div>
      </div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;margin-top:8px;">
        <div><label>Weight Field</label><input value="${wizardData.mqttWeightField || 'weight'}" oninput="wizardData.mqttWeightField=this.value" /></div>
        <div><label>Phase Field</label><input value="${wizardData.mqttPhaseField || 'phase'}" oninput="wizardData.mqttPhaseField=this.value" /></div>
        <div><label>Bag Count Field</label><input value="${wizardData.mqttBagCountField || 'bagCount'}" oninput="wizardData.mqttBagCountField=this.value" /></div>
      </div>` : ""}
      ${wizardData.protocol === 'EtherNet/IP' ? `
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;margin-top:8px;">
        <div><label>Weight Tag</label><input value="${wizardData.enipWeightTag || 'Weight'}" oninput="wizardData.enipWeightTag=this.value" /></div>
        <div><label>Status Tag</label><input value="${wizardData.enipStatusTag || 'Status'}" oninput="wizardData.enipStatusTag=this.value" /></div>
        <div><label>Bag Count Tag</label><input value="${wizardData.enipBagCountTag || 'BagCount'}" oninput="wizardData.enipBagCountTag=this.value" /></div>
      </div>` : ""}
      ${wizardData.protocol === 'PROFINET' || wizardData.protocol === 'S7' ? `
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;margin-top:8px;">
        <div><label>Rack</label><input value="${wizardData.s7Rack || 0}" oninput="wizardData.s7Rack=this.value" /></div>
        <div><label>Slot</label><input value="${wizardData.s7Slot || 1}" oninput="wizardData.s7Slot=this.value" /></div>
        <div><label>DB Number</label><input value="${wizardData.s7DbNumber || 1}" oninput="wizardData.s7DbNumber=this.value" /></div>
      </div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;margin-top:8px;">
        <div><label>Weight Start (byte)</label><input value="${wizardData.s7WeightStart || 0}" oninput="wizardData.s7WeightStart=this.value" /></div>
        <div><label>Status Start (byte)</label><input value="${wizardData.s7StatusStart || 4}" oninput="wizardData.s7StatusStart=this.value" /></div>
        <div><label>Bag Count Start (byte)</label><input value="${wizardData.s7BagCountStart || 6}" oninput="wizardData.s7BagCountStart=this.value" /></div>
      </div>` : ""}
      ${wizardData.protocol === 'SNMP' ? `
      <div class="form-grid" style="grid-template-columns:1fr 1fr;margin-top:8px;">
        <div><label>Weight OID</label><input value="${wizardData.snmpWeightOid || ''}" oninput="wizardData.snmpWeightOid=this.value" placeholder="1.3.6.1.4.1.2020.1.1.1.0" /></div>
        <div><label>Community</label><input value="${wizardData.snmpCommunity || 'public'}" oninput="wizardData.snmpCommunity=this.value" /></div>
      </div>` : ""}
      ${wizardData.protocol === 'REST API' ? `
      <div class="form-grid" style="grid-template-columns:1fr 1fr;margin-top:8px;">
        <div><label>API URL</label><input value="${wizardData.restUrl || ''}" oninput="wizardData.restUrl=this.value" placeholder="http://192.168.1.100/api/weight" /></div>
        <div><label>Method</label><select onchange="wizardData.restMethod=this.value"><option value="GET">GET</option><option value="POST">POST</option></select></div>
      </div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;margin-top:8px;">
        <div><label>Weight Field</label><input value="${wizardData.restWeightField || 'weight'}" oninput="wizardData.restWeightField=this.value" /></div>
        <div><label>Auth Type</label><select onchange="wizardData.restAuthType=this.value"><option value="none">None</option><option value="bearer">Bearer Token</option><option value="basic">Basic Auth</option></select></div>
        <div><label>Token</label><input type="password" value="${wizardData.restAuthToken || ''}" oninput="wizardData.restAuthToken=this.value" /></div>
      </div>` : ""}
      ${wizardData.protocol === 'TCP Socket' ? `
      <div class="form-grid" style="grid-template-columns:1fr 1fr;margin-top:8px;">
        <div><label>TCP Port</label><input value="${wizardData.tcpPort || 8080}" oninput="wizardData.tcpPort=this.value" /></div>
        <div><label>Delimiter</label><select onchange="wizardData.tcpDelimiter=this.value"><option value="\r\n">CR+LF</option><option value="\n">LF</option><option value=",">Comma</option></select></div>
      </div>
      <div style="margin-top:8px;"><label>Parse Regex</label><input value="${wizardData.tcpParseRegex || '([\\d.]+)'}" oninput="wizardData.tcpParseRegex=this.value" placeholder="([\\d.]+)" style="width:100%;" /></div>` : ""}
      ${wizardData.protocol?.includes('Serial') || wizardData.protocol === 'RS232' || wizardData.protocol === 'RS485' ? `
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;margin-top:8px;">
        <div><label>Serial Port</label><input value="${wizardData.serialPort || ''}" oninput="wizardData.serialPort=this.value" placeholder="/dev/ttyUSB0" /></div>
        <div><label>Baud Rate</label><select onchange="wizardData.baudRate=this.value"><option value="9600">9600</option><option value="19200">19200</option><option value="38400">38400</option><option value="57600">57600</option><option value="115200">115200</option></select></div>
        <div><label>Parity</label><select onchange="wizardData.serialParity=this.value"><option value="none">None</option><option value="even">Even</option><option value="odd">Odd</option></select></div>
      </div>
      <div style="margin-top:8px;"><label>Parse Regex</label><input value="${wizardData.serialParseRegex || '([\\d.]+)'}" oninput="wizardData.serialParseRegex=this.value" placeholder="([\\d.]+)" style="width:100%;" /></div>` : ""}`;
  } else if (wizardStep === 3) {
    const r = wizardData.connResult;
    stepContent = `<div style="font-size:13px;color:#8B95A1;margin-bottom:14px;">Testing ${esc(wizardData.ip)} over ${wizardData.protocol}.</div>
      <button class="btn btn-primary" onclick="wizardTestConnection()">Test connection</button>
      ${r && r.loading ? `<div style="margin-top:12px;color:#8B95A1;">Testing…</div>` : ""}
      ${r && !r.loading ? `<div class="result-box ${r.success ? "success" : "error"}">${r.success ? "✓" : "✕"} ${esc(r.message)} (${r.latencyMs}ms)</div>` : ""}`;
  } else if (wizardStep === 4) {
    const r = wizardData.registerMap.weight || {};
    const p = wizardData.protocol;
    let aLabel, aPlaceholder, bLabel, bPlaceholder;
    if (p === "Modbus TCP" || p === "Modbus RTU") { aLabel = "Weight Register"; aPlaceholder = "0"; bLabel = "Scale Factor"; bPlaceholder = "1"; }
    else if (p === "OPC-UA") { aLabel = "Weight Node ID"; aPlaceholder = "ns=2;s=Weight"; bLabel = "Status Node ID"; bPlaceholder = "ns=2;s=Status"; }
    else if (p === "REST API") { aLabel = "Weight JSON Field"; aPlaceholder = "weight"; bLabel = "Phase Field"; bPlaceholder = "phase"; }
    else if (p === "MQTT") { aLabel = "Weight Field"; aPlaceholder = "weight"; bLabel = "Phase Field"; bPlaceholder = "phase"; }
    else if (p === "EtherNet/IP") { aLabel = "Weight Tag"; aPlaceholder = "Weight"; bLabel = "Status Tag"; bPlaceholder = "Status"; }
    else if (p === "PROFINET" || p === "S7") { aLabel = "Weight Byte Offset"; aPlaceholder = "0"; bLabel = "Status Byte Offset"; bPlaceholder = "4"; }
    else if (p === "SNMP") { aLabel = "Weight OID"; aPlaceholder = "1.3.6.1.4.1.2020.1.1.1.0"; bLabel = "Status OID"; bPlaceholder = "1.3.6.1.4.1.2020.1.1.2.0"; }
    else { aLabel = "Parse Pattern"; aPlaceholder = "([\\d.]+)"; bLabel = "Unit"; bPlaceholder = "kg"; }
    stepContent = `<div style="font-size:13px;color:#8B95A1;margin-bottom:14px;">Configure the weight data point for ${esc(p)}.</div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr;">
        <div><label>${aLabel}</label><input id="wz-dp-a" value="${esc(r.register || r.nodeId || r.path || r.topic || r.field || r.weightOid || "")}" placeholder="${aPlaceholder}" /></div>
        <div><label>${bLabel}</label><input id="wz-dp-b" value="${esc(r.statusNode || r.phaseField || r.statusOid || r.scaleFactor || "")}" placeholder="${bPlaceholder}" /></div>
      </div>`;
  } else if (wizardStep === 5) {
    const r = wizardData.dpResult;
    stepContent = `<div style="font-size:13px;color:#8B95A1;margin-bottom:14px;">Read the configured data point once.</div>
      <button class="btn btn-primary" onclick="wizardTestDatapoint()">Run read test</button>
      ${r && r.loading ? `<div style="margin-top:12px;color:#8B95A1;">Reading…</div>` : ""}
      ${r && !r.loading ? `<div class="result-box ${r.success ? "success" : "error"}">${r.success ? "✓" : "✕"} ${esc(r.message)} — raw: ${r.rawValue ?? "n/a"} ${r.unit || ""} (${r.latencyMs}ms)</div>` : ""}`;
  } else if (wizardStep === 6) {
    const checks = [
      { label: "Name and IP set", pass: !!wizardData.name && !!wizardData.ip },
      { label: "Protocol selected", pass: !!wizardData.protocol },
      { label: "Connection test passed", pass: !!(wizardData.connResult?.success) },
      { label: "Data point read", pass: !!(wizardData.dpResult?.success) },
      { label: "Target valid", pass: Number(wizardData.target) > 0 },
    ];
    const allPass = checks.every(c => c.pass);
    stepContent = `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;">
      ${checks.map(c => `<div style="display:flex;align-items:center;gap:10px;font-size:13px;">
        <span style="color:${c.pass ? "#4FD1B5" : "#E5484D"};">${c.pass ? "✓" : "✕"}</span><span>${c.label}</span>
      </div>`).join("")}
    </div>
    <div class="result-box ${allPass ? "success" : "error"}">${allPass ? "Ready to activate." : "Fix the items above."}</div>`;
  } else if (wizardStep === 7) {
    const product = wizardData.productId ? products.find(p => p.id === wizardData.productId) : null;
    stepContent = `<div style="font-size:13px;color:#8B95A1;margin-bottom:14px;">Review, then activate.</div>
      <div class="device-chip" style="width:100%;margin-bottom:8px;">
        <span style="flex:1;">${esc(wizardData.name)}</span>
        <span class="mono" style="color:#5B6673;">${esc(wizardData.ip)}</span>
        <span class="mono" style="color:#8B95A1;">${wizardData.protocol}</span>
      </div>
      <div style="font-size:12px;color:#5B6673;">Target: ${product ? `${product.targetWeight}${product.unit} (${esc(product.name)})` : `${wizardData.target}${wizardData.unit}`}</div>
      <div style="display:flex;justify-content:flex-end;margin-top:16px;">
        <button class="btn btn-primary" onclick="wizardActivate()">Activate</button>
      </div>`;
  }

  return `<div class="form-card">
    <div class="section-label mono" style="margin-bottom:4px;">Add device — step ${wizardStep}/7</div>
    <div class="wizard-steps">${labels.map((l, i) => `<div class="wizard-step ${wizardStep === i + 1 ? "active" : wizardStep > i + 1 ? "done" : ""}">${i + 1}. ${l}</div>`).join("")}</div>
    ${stepContent}
    <div style="display:flex;justify-content:space-between;margin-top:18px;">
      <button class="btn" onclick="closeWizard()">Cancel</button>
      <div style="display:flex;gap:8px;">
        ${wizardStep > 1 ? `<button class="btn" onclick="wizardBack()">Back</button>` : ""}
        ${wizardStep < 7 ? `<button class="btn btn-primary" onclick="wizardNext()">Next</button>` : ""}
      </div>
    </div>
  </div>`;
}

// ---------- Boot ----------

async function boot() {
  try { const bRes = await fetch(`${API}/api/branding`); branding = await bRes.json(); applyBranding(); } catch {}
  if (!getToken()) { renderLogin(); return; }
  try { await loadInitial(); connectWs(); } catch {}
}

boot();
