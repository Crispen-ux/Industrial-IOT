const API = "";
const PROTOCOLS = ["Simulator", "Modbus TCP", "Modbus RTU", "OPC-UA", "MQTT", "EtherNet/IP", "PROFINET", "S7", "SNMP", "REST API", "TCP Socket", "Serial", "RS232", "RS485"];
const METRICS = [
  { id: "live_weight", label: "Live weight" },
  { id: "trend", label: "Weight trend" },
  { id: "bag_count", label: "Bag counter" },
  { id: "deviation", label: "Target deviation" },
  { id: "giveaway", label: "Give-away / loss" },
  { id: "classification", label: "Bag classification" },
  { id: "status_overview", label: "Status overview" },
  { id: "metric_chart", label: "Metric chart" },
  { id: "kpi_card", label: "KPI card" },
];
const ROLES = ["operator", "manager", "admin"];
const ROLE_RANK = { operator: 0, manager: 1, admin: 2 };

let devices = [];
let currentWidgets = [];
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
const latestTelemetry = new Map();
const assetStatuses = new Map();
let alertRules = [];
let productionOrders = [];
let qualityMetrics = [];
let shiftTemplates = [];

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
let spcMetric = "weight";
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

// ============================================================
// REUSABLE UI COMPONENTS
// ============================================================

// Toast notification system
let toastQueue = [];
let toastTimer = null;

function showToast(message, type = "info", duration = 3000) {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${esc(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.classList.add("toast-show"), 10);
  setTimeout(() => {
    toast.classList.remove("toast-show");
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// Override the existing toast() function if it exists
// The app already has a toast() function - we need to find and update it

// Modal dialog system
let activeModal = null;

function openModal(options) {
  closeModal();
  const { title, subtitle, body, footer, size = "md", onClose } = options;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
  
  const sizeClass = size === "sm" ? "modal-sm" : size === "lg" ? "modal-lg" : "";
  overlay.innerHTML = `
    <div class="modal-content ${sizeClass}">
      <div class="modal-header">
        <div>
          <h3 class="modal-title">${title || ""}</h3>
          ${subtitle ? `<div class="modal-subtitle">${subtitle}</div>` : ""}
        </div>
        <button class="modal-close" onclick="closeModal()">&times;</button>
      </div>
      <div class="modal-body">${body || ""}</div>
      ${footer ? `<div class="modal-footer">${footer}</div>` : ""}
    </div>`;
  
  document.body.appendChild(overlay);
  activeModal = { overlay, onClose };
  setTimeout(() => overlay.classList.add("modal-show"), 10);
  
  // ESC to close
  const escHandler = (e) => { if (e.key === "Escape") { closeModal(); document.removeEventListener("keydown", escHandler); } };
  document.addEventListener("keydown", escHandler);
  
  // Focus first input
  setTimeout(() => {
    const firstInput = overlay.querySelector("input, select, textarea");
    if (firstInput) firstInput.focus();
  }, 100);
}

function closeModal() {
  if (activeModal) {
    activeModal.overlay.classList.remove("modal-show");
    setTimeout(() => {
      activeModal.overlay.remove();
      if (activeModal.onClose) activeModal.onClose();
      activeModal = null;
    }, 200);
  }
}

// Confirm dialog (replaces window.confirm)
function showConfirm(options) {
  return new Promise((resolve) => {
    const { title = "Confirm", message, confirmText = "Confirm", cancelText = "Cancel", danger = false } = typeof options === "string" ? { message: options } : options;
    openModal({
      title,
      size: "sm",
      body: `<p style="color:#8B949E;font-size:14px;line-height:1.5;">${esc(message)}</p>`,
      footer: `
        <button class="btn btn-secondary" onclick="closeModal(); window._confirmResolve(false);">${esc(cancelText)}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" onclick="closeModal(); window._confirmResolve(true);">${esc(confirmText)}</button>`,
      onClose: () => { window._confirmResolve = null; resolve(false); }
    });
    window._confirmResolve = resolve;
  });
}

// Prompt dialog (replaces window.prompt)
function showPrompt(options) {
  return new Promise((resolve) => {
    const { title = "Input", label, placeholder = "", defaultValue = "", type = "text" } = typeof options === "string" ? { label: options } : options;
    const inputId = "prompt-input-" + Date.now();
    openModal({
      title,
      size: "sm",
      body: `
        <div class="form-group">
          <label class="form-label">${esc(label)}</label>
          <input class="form-input" id="${inputId}" type="${type}" value="${esc(defaultValue)}" placeholder="${esc(placeholder)}" />
        </div>`,
      footer: `
        <button class="btn btn-secondary" onclick="closeModal(); window._promptResolve(null);">Cancel</button>
        <button class="btn btn-primary" onclick="window._promptResolve(document.getElementById('${inputId}').value); closeModal();">OK</button>`,
      onClose: () => { window._promptResolve = null; resolve(null); }
    });
    // Enter to submit
    setTimeout(() => {
      const input = document.getElementById(inputId);
      if (input) {
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { window._promptResolve(input.value); closeModal(); }
        });
      }
    }, 150);
  });
}

// Multi-field prompt (replaces chained window.prompt calls)
function showFormModal(options) {
  return new Promise((resolve) => {
    const { title, subtitle, fields, submitText = "Create", cancelText = "Cancel", danger = false } = options;
    const fieldsHtml = fields.map(f => {
      const id = "form-field-" + f.name;
      if (f.type === "select") {
        return `<div class="form-group">
          <label class="form-label">${esc(f.label)}</label>
          <select class="form-select" id="${id}">${f.options.map(o => `<option value="${esc(o.value)}" ${o.value === f.defaultValue ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>
        </div>`;
      }
      if (f.type === "textarea") {
        return `<div class="form-group">
          <label class="form-label">${esc(f.label)}</label>
          <textarea class="form-textarea" id="${id}" placeholder="${esc(f.placeholder || "")}" rows="3">${esc(f.defaultValue || "")}</textarea>
        </div>`;
      }
      return `<div class="form-group">
        <label class="form-label">${esc(f.label)}</label>
        <input class="form-input" id="${id}" type="${f.type || 'text'}" value="${esc(f.defaultValue || "")}" placeholder="${esc(f.placeholder || "")}" ${f.required ? 'required' : ''} />
      </div>`;
    }).join("");
    
    openModal({
      title,
      subtitle,
      body: `<form id="modal-form" onsubmit="event.preventDefault(); window._formSubmitHandler();">${fieldsHtml}</form>`,
      footer: `
        <button class="btn btn-secondary" onclick="closeModal(); window._formResolve(null);">${esc(cancelText)}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" onclick="window._formSubmitHandler();">${esc(submitText)}</button>`,
      onClose: () => { window._formResolve = null; resolve(null); }
    });
    
    window._formSubmitHandler = () => {
      const values = {};
      for (const f of fields) {
        const el = document.getElementById("form-field-" + f.name);
        values[f.name] = el ? el.value : null;
      }
      // Validate required fields
      for (const f of fields) {
        if (f.required && !values[f.name]) {
          const el = document.getElementById("form-field-" + f.name);
          if (el) el.style.borderColor = "#E5484D";
          return;
        }
      }
      closeModal();
      resolve(values);
    };
  });
}

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

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
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
  devices = []; currentWidgets = []; currentUser = null;
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
    authFetch(`${API}/api/alerts`),
    authFetch(`${API}/api/alert-config`),
    authFetch(`${API}/api/products`),
    authFetch(`${API}/api/templates`),
    authFetch(`${API}/api/maintenance`),
    authFetch(`${API}/api/maintenance-schedules`),
    authFetch(`${API}/api/maintenance-failures`),
    authFetch(`${API}/api/calibrations`),
    authFetch(`${API}/api/device-health`),
    authFetch(`${API}/api/dashboard-views`),
    brandingPromise,
  ];
  if (hasRole("manager")) {
    calls.push(authFetch(`${API}/api/gateway-keys`));
    calls.push(authFetch(`${API}/api/audit-log?limit=100`));
    calls.push(authFetch(`${API}/api/notification-config`));
    calls.push(authFetch(`${API}/api/downtime-logs`));
    calls.push(authFetch(`${API}/api/downtime-logs/stats`));
    calls.push(authFetch(`${API}/api/scheduled-reports`));
    calls.push(authFetch(`${API}/api/device-groups`));
    calls.push(authFetch(`${API}/api/batches`));
    calls.push(authFetch(`${API}/api/ai-insights`));
    calls.push(authFetch(`${API}/api/ml-models`));
    calls.push(authFetch(`${API}/api/ml-predictions`));
    calls.push(authFetch(`${API}/api/organizations`));
    calls.push(authFetch(`${API}/api/report-templates`));
    calls.push(authFetch(`${API}/api/integrations`));
  }
  if (hasRole("admin")) {
    calls.push(authFetch(`${API}/api/users`));
    calls.push(authFetch(`${API}/api/sso/providers`));
    calls.push(authFetch(`${API}/api/device-permissions`));
  }
  calls.push(authFetch(`${API}/api/hierarchy`));
  calls.push(authFetch(`${API}/api/asset-types`));
  calls.push(authFetch(`${API}/api/asset-status`));
  calls.push(authFetch(`${API}/api/production-orders`));
  calls.push(authFetch(`${API}/api/quality-metrics`));
  calls.push(authFetch(`${API}/api/shift-templates`));
  calls.push(authFetch(`${API}/api/alert-rules`));

  const results = await Promise.all(calls);
  let i = 0;
  devices = await results[i++].json();
  const alertData = await results[i++].json();
  activeAlerts = alertData.active;
  alertHistory = alertData.history;
  alertConfig = await results[i++].json();
  products = await results[i++].json();
  templates = await results[i++].json();
  maintenanceRecords = await results[i++].json();
  maintenanceSchedules = await results[i++].json();
  maintenanceFailures = await results[i++].json();
  calibrationRecords = await results[i++].json();
  deviceHealthScores = await results[i++].json();
  if (!Array.isArray(deviceHealthScores)) deviceHealthScores = [];
  dashboardViews = await results[i++].json();
  branding = await results[i++].json();
  if (dashboardViews.length && !currentDashboardViewId) {
    const def = dashboardViews.find(v => v.isDefault) || dashboardViews[0];
    currentDashboardViewId = def.id;
  }
  // Load widgets for current view
  if (currentDashboardViewId) {
    try {
      const wRes = await authFetch(`${API}/api/dashboard-views/${currentDashboardViewId}/widgets`);
      currentWidgets = await wRes.json();
    } catch { currentWidgets = []; }
  }
  if (hasRole("manager")) {
    gatewayKeys = await results[i++].json();
    auditLog = await results[i++].json();
    notificationConfig = await results[i++].json();
    downtimeLogs = await results[i++].json();
    downtimeStats = await results[i++].json();
    scheduledReports = await results[i++].json();
    deviceGroups = await results[i++].json();
    batches = await results[i++].json();
    aiInsights = await results[i++].json();
    mlModels = await results[i++].json();
    mlPredictions = await results[i++].json();
    organizations = await results[i++].json();
    reportTemplates = await results[i++].json();
    integrations = await results[i++].json();
  }
  if (hasRole("admin")) {
    users = await results[i++].json();
    ssoProviders = await results[i++].json();
    devicePermissions = await results[i++].json();
  }
  hierarchyData = await results[i++].json();
  assetTypes = await results[i++].json();
  const statusData = await results[i++].json();
  if (Array.isArray(statusData)) {
    statusData.forEach(s => assetStatuses.set(s.deviceId, s));
  }
  productionOrders = await results[i++].json();
  qualityMetrics = await results[i++].json();
  shiftTemplates = await results[i++].json();
  alertRules = await results[i++].json();
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
    if (currentView === "dashboard") setTimeout(initGridStack, 50);
  }
}

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "snapshot") {
      msg.devices.forEach(({ deviceId, reading, stats, telemetry, assetStatus }) => {
        if (reading) { latestByDevice.set(deviceId, reading); readingsByDevice.set(deviceId, [reading]); }
        if (stats) statsByDevice.set(deviceId, stats);
        if (telemetry) latestTelemetry.set(deviceId, telemetry);
        if (assetStatus) assetStatuses.set(deviceId, assetStatus);
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
    } else if (msg.type === "telemetry") {
      latestTelemetry.set(msg.deviceId, { metrics: msg.metrics, connected: msg.connected, ts: msg.ts });
      liveRender();
    } else if (msg.type === "asset_status") {
      const existing = assetStatuses.get(msg.deviceId) || {};
      assetStatuses.set(msg.deviceId, { ...existing, deviceId: msg.deviceId, status: msg.status });
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
  if (!await showConfirm({ title: "Reset Stats", message: "Reset give-away/loss stats for this device?", danger: false })) return;
  try {
    await authFetch(`${API}/api/devices/${id}/reset-stats`, { method: "POST" });
    await loadInitial();
    toast("Stats reset", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

// Old addWidget/removeWidget replaced by dashboard_views system — see addWidgetDialog/removeWidget below

async function createGatewayKey() {
  const label = await showPrompt({ title: "Create Gateway Key", label: "Label for this gateway key:", defaultValue: "gateway" });
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
  if (!await showConfirm({ title: "Revoke Gateway Key", message: "Revoke this gateway key?", danger: true })) return;
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
  if (!await showConfirm({ title: "Remove User", message: "Remove this user?", danger: true })) return;
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
  if (!await showConfirm({ title: "Delete Scheduled Report", message: "Delete this scheduled report?", danger: true })) return;
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
  if (!await showConfirm({ title: "Delete Product", message: "Delete this product?", danger: true })) return;
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
  if (!await showConfirm({ title: "Delete Maintenance Record", message: "Delete this maintenance record?", danger: true })) return;
  try {
    await authFetch(`${API}/api/maintenance/${id}`, { method: "DELETE" });
    await loadInitial();
    toast("Record removed", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function updateMaintenanceStatus(id, status) {
  let extra = {};
  if (status === "COMPLETED") {
    const maintenanceExtra = await showFormModal({
      title: "Complete Maintenance",
      subtitle: "Enter completion details",
      fields: [
        { name: "labourHours", label: "Labour hours:", defaultValue: "0", type: "number" },
        { name: "downtimeMinutes", label: "Downtime minutes:", defaultValue: "0", type: "number" },
      ],
      submitText: "Save"
    });
    if (!maintenanceExtra) return;
    extra = { labourHours: maintenanceExtra.labourHours || 0, downtimeMinutes: maintenanceExtra.downtimeMinutes || 0 };
  }
  try {
    await authFetch(`${API}/api/maintenance/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, ...extra }) });
    await loadInitial();
    toast("Status updated", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function removeCalibrationRecord(id) {
  if (!await showConfirm({ title: "Delete Calibration Record", message: "Delete this calibration record?", danger: true })) return;
  try {
    await authFetch(`${API}/api/calibrations/${id}`, { method: "DELETE" });
    await loadInitial();
    toast("Record removed", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function removeTemplate(id) {
  if (!await showConfirm({ title: "Delete Template", message: "Delete this template?", danger: true })) return;
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
  const syncKeyData = await showFormModal({
    title: "Create Sync Key",
    subtitle: "Configure site sync credentials",
    fields: [
      { name: "siteId", label: "Site ID (letters/numbers/hyphens):", required: true },
      { name: "siteLabel", label: "Display label:", placeholder: "Site ID" },
    ],
    submitText: "Create"
  });
  if (!syncKeyData) return;
  const siteId = syncKeyData.siteId;
  const siteLabel = syncKeyData.siteLabel || siteId;
  try {
    const res = await authFetch(`${API}/api/sync-keys`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ siteId, siteLabel }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    newlyCreatedSyncKey = await res.json();
    await loadSyncPanel();
    toast("Sync key created — copy it now!", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function revokeSyncKey(id) {
  if (!await showConfirm({ title: "Revoke Sync Key", message: "Revoke this sync key?", danger: true })) return;
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
  if (!await showConfirm({ title: "Change Configuration", message: "Change live protocol/register configuration?", danger: true })) return;
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
  if (wizardStep === 1 && (!wizardData.name || !wizardData.ip)) { showToast("Name and IP required.", "error"); return; }
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
  const res = await authFetch(`${API}/api/engineering/test-datapoint`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registerMap: wizardData.registerMap, unit: wizardData.unit, ip: wizardData.ip, protocol: wizardData.protocol, port: wizardData.port }) });
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
  const maintenanceType = document.getElementById("mf-type").value;
  const priority = document.getElementById("mf-priority").value;
  const intervalDays = document.getElementById("mf-interval").value;
  const technician = document.getElementById("mf-tech").value.trim();
  if (!deviceId) return;
  try {
    const res = await authFetch(`${API}/api/maintenance`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId, status: "SCHEDULED", maintenanceType, priority, dueDate: dueDate ? new Date(dueDate).toISOString() : null, intervalDays: intervalDays || null, technician }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    await loadMaintenanceRecords();
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
  else if (view === "dashboard") { render(); setTimeout(initGridStack, 50); }
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
    { id: "dashboard", label: "Dashboard", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>` },
    { id: "hierarchy", label: "Hierarchy", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>` },
    { id: "devices", label: "Devices", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="12" cy="12" r="3"/></svg>` },
    { id: "asset-types", label: "Asset Types", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>` },
    { id: "alerts", label: "Alerts", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`, badge: alertCount || null },
    { id: "documentation", label: "Docs & FAQ", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>` },
  ];

  const opsItems = [];
  if (hasRole("manager")) {
    opsItems.push(
      { id: "production-orders", label: "Production", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>` },
      { id: "maintenance", label: "Maintenance", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>` },
      { id: "predictive", label: "Predictive", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>` },
      { id: "spc", label: "SPC", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>` },
      { id: "oee", label: "OEE", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>` },
      { id: "quality-metrics", label: "Quality", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>` },
      { id: "calibration", label: "Calibration", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>` },
      { id: "reports", label: "Reports", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>` },
    );
  }

  const adminItems = [];
  if (hasRole("manager")) {
    adminItems.push(
      { id: "sensors", label: "Sensors", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>` },
      { id: "alert-rules", label: "Alert Rules", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>` },
      { id: "quality-metrics", label: "Quality", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>` },
      { id: "shift-templates", label: "Shifts", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>` },
      { id: "downtime", label: "Downtime", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>` },
      { id: "batches", label: "Batches", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05"/><path d="M12 22.08V12"/></svg>` },
      { id: "engineering", label: "Engineering", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`, danger: true },
    );
  }
  if (hasRole("admin")) {
    adminItems.push(
      { id: "users", label: "Users", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>` },
      { id: "sso", label: "SSO / SAML", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>` },
      { id: "organizations", label: "Organizations", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>` },
    );
  }
  if (hasRole("manager")) {
    adminItems.push(
      { id: "gateway-keys", label: "Gateway Keys", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>` },
      { id: "templates", label: "Templates", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>` },
      { id: "branding", label: "Branding", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="13.5" cy="6.5" r="2.5"/><path d="M17.5 10.5l-2.5 2.5"/><path d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M6 14l2 2 4-4"/></svg>` },
      { id: "notifications", label: "Notifications", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>` },
      { id: "device-groups", label: "Groups", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>` },
      { id: "sync", label: "Sync", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>` },
      { id: "audit", label: "Audit Log", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>` },
      { id: "ai-insights", label: "AI Insights", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>` },
      { id: "ml-models", label: "ML Models", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>` },
      { id: "ml-analysis", label: "ML Analysis", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>` },
      { id: "report-builder", label: "Report Builder", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>` },
      { id: "integrations", label: "Integrations", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>` },
      { id: "webhooks", label: "Webhooks", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>` },
      { id: "integration-mappings", label: "Mappings", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>` },
      { id: "data-export", label: "Export", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>` },
      { id: "data-import", label: "Import", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>` },
      { id: "api-usage", label: "API Usage", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>` },
      { id: "api-discovery", label: "API Docs", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>` },
      { id: "analytics", label: "Analytics", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>` },
      { id: "system-health", label: "System", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>` },
      { id: "sessions", label: "Sessions", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>` },
    );
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
      <div class="mobile-brand">
        <span class="mobile-logo-mark"></span>
        <h1>${esc(branding.companyName)}</h1>
      </div>
    </div>
    <div class="sidebar-overlay" id="sidebar-overlay" onclick="toggleMobileSidebar()"></div>
    <div class="layout">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-brand">
          <div class="brand-row">
            ${branding.logoUrl ? `<img src="${esc(branding.logoUrl)}" alt="logo" />` : `<span class="logo-mark"></span>`}
            <div class="brand-text">
              <div class="eyebrow">${esc(branding.tagline)}</div>
              <h1>${esc(branding.companyName)}</h1>
            </div>
          </div>
          <div class="brand-accent-bar"></div>
        </div>
        <nav class="sidebar-nav">
          <div class="nav-section">
            ${navItems.map(n => `
              <button class="nav-item ${currentView === n.id ? 'active' : ''} ${n.danger ? 'danger' : ''}" onclick="navigate('${n.id}')">
                <span class="nav-icon">${n.icon}</span>
                <span class="nav-label">${n.label}</span>
                ${n.badge ? `<span class="nav-badge" id="alert-badge">${n.badge}</span>` : (n.id === "alerts" ? `<span class="nav-badge" id="alert-badge" style="display:none;"></span>` : "")}
              </button>
            `).join("")}
          </div>
          ${opsItems.length ? `
          <div class="nav-section">
            <div class="nav-section-label">Operations</div>
            ${opsItems.map(n => `
              <button class="nav-item ${currentView === n.id ? 'active' : ''} ${n.danger ? 'danger' : ''}" onclick="navigate('${n.id}')">
                <span class="nav-icon">${n.icon}</span>
                <span class="nav-label">${n.label}</span>
              </button>
            `).join("")}
          </div>` : ""}
          ${adminItems.length ? `
          <div class="nav-section">
            <div class="nav-section-label">Administration</div>
            ${adminItems.map(n => `
              <button class="nav-item ${currentView === n.id ? 'active' : ''} ${n.danger ? 'danger' : ''}" onclick="navigate('${n.id}')">
                <span class="nav-icon">${n.icon}</span>
                <span class="nav-label">${n.label}</span>
              </button>
            `).join("")}
          </div>` : ""}
        </nav>
        <div class="sidebar-footer">
          <div class="sidebar-status">
            <span class="status-dot status-online"></span>
            <span class="status-label">System Online</span>
          </div>
          <div class="sidebar-divider"></div>
          <div style="margin-bottom:8px;">
            <select onchange="setLanguage(this.value)" style="width:100%;padding:4px 8px;border-radius:4px;background:#1B2129;color:#E8EAED;border:1px solid #2A333D;font-size:12px;">
              ${getLanguages().map(l => `<option value="${l}" ${l === currentLang ? "selected" : ""}>${l.toUpperCase()}</option>`).join("")}
            </select>
          </div>
          <div class="user-info">
            <span class="user-avatar">${esc((currentUser?.username || "?")[0].toUpperCase())}</span>
            <div class="user-details">
              <span class="user-name">${esc(currentUser?.username)}</span>
              <span class="user-role">${currentUser?.role}</span>
            </div>
          </div>
          <button class="logout-btn" onclick="logout()">Log out</button>
        </div>
      </aside>
      <main class="main" id="main-content">
        <div class="top-bar-global">
          <div class="top-bar-global-left">
            <h2 class="page-title" id="page-title">${esc(branding.companyName)}</h2>
            <div class="page-subtitle" id="page-subtitle"></div>
          </div>
          <div class="top-bar-global-right">
            <div class="topbar-status">
              <span class="status-dot status-online"></span>
              <span class="topbar-status-label">Online</span>
            </div>
            <button class="topbar-icon-btn" id="notif-btn" title="Notifications" onclick="navigate('alerts')">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
              ${alertCount > 0 ? `<span class="topbar-notif-badge">${alertCount}</span>` : ""}
            </button>
            <div class="topbar-avatar" title="${esc(currentUser?.username)}">
              ${esc((currentUser?.username || "?")[0].toUpperCase())}
            </div>
          </div>
        </div>
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
  const password = await showPrompt({ title: "Disable 2FA", label: "Enter your password to disable 2FA:", type: "password" });
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
    case "hierarchy": return viewHierarchy();
    case "devices": return viewDevices();
    case "asset-types": return viewAssetTypes();
    case "products": return viewProducts();
    case "maintenance": return viewMaintenance();
    case "predictive": return viewPredictiveMaintenance();
    case "calibration": return viewCalibration();
    case "reports": return viewReports();
    case "alerts": return viewAlerts();
    case "sensors": return viewSensors();
    case "alert-rules": return viewAlertRules();
    case "production-orders": return viewProductionOrders();
    case "quality-metrics": return viewQualityMetrics();
    case "shift-templates": return viewShiftTemplates();
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
    case "ml-models": return viewMLModels();
    case "ml-analysis": return viewMLAnalysis();
    case "organizations": return viewOrganizations();
    case "report-builder": return viewReportBuilder();
    case "integrations": return viewIntegrations();
    case "webhooks": return viewWebhookConfigs();
    case "integration-mappings": return viewIntegrationMappings();
    case "data-export": return viewDataExport();
    case "data-import": return viewDataImport();
    case "api-discovery": return viewAPIDiscovery();
    case "analytics": return viewAdvancedAnalytics();
    case "system-health": return viewSystemHealth();
    case "sessions": return viewSessions();
    case "api-usage": return viewAPIUsage();
    case "documentation": return viewDocumentation();
    default: return viewDashboard();
  }
}

// ---------- Dashboard ----------

function viewDashboard() {
  const currentViewData = dashboardViews.find(v => v.id === currentDashboardViewId);
  const isPersonal = currentViewData?.userId === currentUser?.id;
  const canEdit = isPersonal || hasRole("manager");
  return `
    <div class="top-bar">
      <div>
        <h2>Dashboard</h2>
        <div class="subtitle">${devices.length} device${devices.length !== 1 ? "s" : ""} connected</div>
      </div>
      <div class="top-bar-actions">
        ${canEdit ? `<button class="btn btn-primary" onclick="addWidgetDialog()">+ Add widget</button>` : ""}
        <button class="btn" onclick="showPasswordChange=true;render()">Change password</button>
      </div>
    </div>
    ${dashboardViews.length > 0 ? `
    <div style="display:flex;gap:8px;margin-bottom:16px;align-items:center;flex-wrap:wrap;">
      ${dashboardViews.map(v => `
        <button class="btn ${v.id === currentDashboardViewId ? 'btn-primary' : ''}" onclick="switchDashboardView('${v.id}')" style="font-size:13px;">
          ${esc(v.name)}${v.isDefault ? ' (default)' : ''}${v.userId ? ' (you)' : ''}
        </button>`).join("")}
      <button class="btn btn-sm" onclick="createDashboardView(false)">+ Personal view</button>
      ${hasRole("manager") ? `<button class="btn btn-sm" onclick="createDashboardView(true)">+ Shared view</button>` : ""}
      ${currentViewData && !currentViewData.isDefault ? `
        <button class="btn btn-sm" onclick="duplicateDashboardView('${currentDashboardViewId}')">Duplicate</button>
        <button class="btn btn-sm btn-danger" onclick="deleteDashboardView('${currentDashboardViewId}')">Delete</button>
      ` : ""}
    </div>` : ""}
    <div class="section-label mono">Widgets</div>
    <div class="grid-stack" id="widget-grid"></div>`;
}

function initGridStack() {
  const gridEl = document.getElementById("widget-grid");
  if (!gridEl || !window.GridStack) return;
  // Destroy existing instance
  if (gridEl._gridstack) { gridEl._gridstack.destroy(false); gridEl.innerHTML = ""; }

  const grid = GridStack.init({
    cellHeight: 80,
    margin: 8,
    column: 12,
    animate: true,
    disableOneColumnMode: false,
    float: true,
  }, gridEl);
  gridEl._gridstack = grid;

  // Render existing widgets
  grid.removeAll();
  for (const w of currentWidgets) {
    const device = devices.find(d => d.id === w.deviceId);
    if (!device) continue;
    const node = { id: w.id, x: w.x || 0, y: w.y || 0, w: w.w || 4, h: w.h || 3 };
    grid.addWidget(node);
  }

  // Render widget content after layout
  renderGridWidgets(grid);

  // Save on change
  grid.on("change", (event, items) => {
    if (!items || !items.length) return;
    const updates = items.map(item => ({
      id: item.id,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
    }));
    authFetch(`${API}/api/dashboard-widgets/${currentDashboardViewId}/batch`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ widgets: updates }),
    }).catch(() => {});
  });
}

function renderGridWidgets(grid) {
  for (const w of currentWidgets) {
    const el = grid.el.querySelector(`[gs-id="${w.id}"]`);
    if (!el) continue;
    el.innerHTML = renderWidgetContent(w);
    el.classList.add("widget");
  }
}

async function switchDashboardView(viewId) {
  currentDashboardViewId = viewId;
  try {
    const res = await authFetch(`${API}/api/dashboard-views/${viewId}/widgets`);
    currentWidgets = await res.json();
    render();
  } catch (e) { console.error("Failed to load dashboard view:", e); }
}

async function createDashboardView(shared) {
  const name = await showPrompt({ title: shared ? "Create Shared View" : "Create Personal View", label: shared ? "Shared view name:" : "Personal view name:" });
  if (!name) return;
  try {
    const res = await authFetch(`${API}/api/dashboard-views`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, shared }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    const view = await res.json();
    dashboardViews.push(view);
    currentDashboardViewId = view.id;
    currentWidgets = [];
    toast("View created", "success");
    render();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function duplicateDashboardView(viewId) {
  const name = await showPrompt({ title: "Duplicate Dashboard View", label: "Name for duplicated view:" });
  if (!name) return;
  try {
    const res = await authFetch(`${API}/api/dashboard-views/${viewId}/duplicate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    const view = await res.json();
    dashboardViews.push(view);
    currentDashboardViewId = view.id;
    await switchDashboardView(view.id);
    toast("View duplicated", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function deleteDashboardView(viewId) {
  if (!await showConfirm({ title: "Delete Dashboard View", message: "Delete this dashboard view?", danger: true })) return;
  try {
    await authFetch(`${API}/api/dashboard-views/${viewId}`, { method: "DELETE" });
    dashboardViews = dashboardViews.filter(v => v.id !== viewId);
    const def = dashboardViews.find(v => v.isDefault) || dashboardViews[0];
    currentDashboardViewId = def?.id || "";
    if (currentDashboardViewId) await switchDashboardView(currentDashboardViewId);
    else { currentWidgets = []; render(); }
    toast("View deleted", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

// initDragDrop replaced by GridStack — see initGridStack()

function renderWidgetContent(widget) {
  const device = devices.find(d => d.id === widget.deviceId);
  if (!device) return `<div class="widget-metric">Unknown device</div>`;
  const reading = latestByDevice.get(device.id);
  const connected = reading ? reading.connected : false;
  const metric = METRICS.find(m => m.id === widget.metric);
  const config = widget.config || {};
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
  } else if (widget.metric === "status_overview") {
    const status = assetStatuses.get(device.id);
    const statusColor = status?.status === "running" ? "#4FD1B5" : status?.status === "warning" ? "#F2B705" : status?.status === "critical" ? "#E5484D" : "#5B6673";
    const statusLabel = status?.status || "unknown";
    body = `<div style="display:flex;align-items:center;gap:10px;margin-top:4px;">
      <div style="width:12px;height:12px;border-radius:50%;background:${statusColor};"></div>
      <div class="big-number" style="font-size:20px;color:${statusColor};">${statusLabel.toUpperCase()}</div>
    </div>
    <div style="font-size:11px;color:#5B6673;margin-top:4px;">${status?.statusText || "No data"}</div>
    <div class="widget-footer">
      <span>${status?.lastSeenAt ? new Date(status.lastSeenAt).toLocaleTimeString() : "never"}</span>
    </div>`;
  } else if (widget.metric === "metric_chart") {
    const telemetry = latestTelemetry.get(device.id);
    const metrics = telemetry?.metrics || {};
    const metricNames = Object.keys(metrics).filter(k => typeof metrics[k] === "number");
    const latest = metricNames.map(k => `${k}: ${metrics[k]}`).join(" · ") || "No metrics";
    body = `<div style="font-size:12px;color:#8B95A1;margin-top:4px;">${latest}</div>
      <div class="widget-footer">
        <span>${device.protocol}</span>
        <span class="${connected ? "status-live" : "status-off"}">${connected ? "● LIVE" : "● OFFLINE"}</span>
      </div>`;
  } else if (widget.metric === "kpi_card") {
    const telemetry = latestTelemetry.get(device.id);
    const metrics = telemetry?.metrics || {};
    const weight = metrics.weight !== undefined ? metrics.weight : (reading?.weight || null);
    const bagCount = metrics.bag_count !== undefined ? metrics.bag_count : (reading?.bagCount || 0);
    body = `<div class="big-number" style="font-size:28px;">${weight !== null ? weight.toFixed(2) : "—"}</div>
      <div style="font-size:11px;color:#5B6673;">${device.unit || "kg"} · ${bagCount} bags</div>
      <div class="widget-footer">
        <span>${device.protocol}</span>
        <span class="${connected ? "status-live" : "status-off"}">${connected ? "● LIVE" : "● OFFLINE"}</span>
      </div>`;
  }

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <div class="widget-metric">${metric?.label || widget.metric}</div>
      <button class="widget-remove" onclick="removeWidget('${widget.id}')" style="background:none;border:none;color:#5B6673;cursor:pointer;font-size:16px;">✕</button>
    </div>
    <div class="widget-device">${esc(device.name)}</div>
    ${body}`;
}

async function addWidgetDialog() {
  const widgetData = await showFormModal({
    title: "Add Widget",
    subtitle: "Select device and metric for the widget",
    fields: [
      { name: "deviceId", label: "Device ID (from Devices page):", required: true },
      { name: "metricIdx", label: `Select metric:\n${METRICS.map((m, i) => `${i + 1}. ${m.label}`).join("\n")}\n\nEnter number (1-${METRICS.length}):`, type: "number", required: true },
    ],
    submitText: "Add"
  });
  if (!widgetData) return;
  const deviceId = widgetData.deviceId;
  const device = devices.find(d => d.id === deviceId);
  if (!device) { toast("Device not found", "error"); return; }
  const idx = widgetData.metricIdx;
  const metricIdx = parseInt(idx) - 1;
  if (isNaN(metricIdx) || metricIdx < 0 || metricIdx >= METRICS.length) { toast("Invalid selection", "error"); return; }
  const metric = METRICS[metricIdx].id;

  try {
    const res = await authFetch(`${API}/api/dashboard-views/${currentDashboardViewId}/widgets`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, metric, x: 0, y: 0, w: 4, h: 3 }),
    });
    if (!res.ok) { const b = await res.json().catch(() => ({})); toast(b.error || "Failed", "error"); return; }
    const widget = await res.json();
    currentWidgets.push(widget);
    toast("Widget added", "success");
    render();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function removeWidget(widgetId) {
  try {
    await authFetch(`${API}/api/dashboard-widgets/${widgetId}`, { method: "DELETE" });
    currentWidgets = currentWidgets.filter(w => w.id !== widgetId);
    render();
  } catch (e) { toast("Failed: " + e.message, "error"); }
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
    <div class="form-card">
      <div style="font-size:13px;color:#8B95A1;">Switch to Dashboard and click "+ Add widget" to add widgets for any device.</div>
    </div>
  `;
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
  const totalCost = maintenanceRecords.filter(m => m.status === "COMPLETED").reduce((s, m) => s + (m.totalCost || 0), 0);
  const totalDowntime = maintenanceRecords.filter(m => m.status === "COMPLETED").reduce((s, m) => s + (m.downtimeMinutes || 0), 0);
  const dueCount = maintenanceRecords.filter(m => m.status === "SCHEDULED" && m.dueDate && new Date(m.dueDate) < new Date(Date.now() + 7 * 86400000)).length;

  return `
    <div class="top-bar">
      <div><h2>Maintenance</h2><div class="subtitle">${maintenanceRecords.length} records | ${dueCount} due soon</div></div>
      <div class="top-bar-actions">
        <button class="btn btn-sm" onclick="viewMaintenanceSchedules()">Schedules</button>
        <button class="btn btn-sm" onclick="viewMaintenanceFailures()">Failures</button>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px;">
      <div class="form-card" style="text-align:center;padding:12px;"><div style="font-size:11px;color:var(--muted);">Total Cost</div><div style="font-size:20px;font-weight:600;color:#F2B705;">$${totalCost.toFixed(2)}</div></div>
      <div class="form-card" style="text-align:center;padding:12px;"><div style="font-size:11px;color:var(--muted);">Downtime</div><div style="font-size:20px;font-weight:600;color:#E5484D;">${Math.round(totalDowntime / 60)}h</div></div>
      <div class="form-card" style="text-align:center;padding:12px;"><div style="font-size:11px;color:var(--muted);">Completed</div><div style="font-size:20px;font-weight:600;color:#27ae60;">${maintenanceRecords.filter(m => m.status === "COMPLETED").length}</div></div>
      <div class="form-card" style="text-align:center;padding:12px;"><div style="font-size:11px;color:var(--muted);">Scheduled</div><div style="font-size:20px;font-weight:600;">${maintenanceRecords.filter(m => m.status === "SCHEDULED").length}</div></div>
    </div>
    ${hasRole("manager") ? `
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">Schedule maintenance</div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 0.7fr 0.7fr 0.7fr 1fr auto;">
        <div><label>Device</label><select id="mf-device">${devices.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}</select></div>
        <div><label>Due date</label><input id="mf-due" type="date" /></div>
        <div><label>Type</label><select id="mf-type"><option value="preventive">Preventive</option><option value="corrective">Corrective</option><option value="predictive">Predictive</option></select></div>
        <div><label>Priority</label><select id="mf-priority"><option value="low">Low</option><option value="normal" selected>Normal</option><option value="high">High</option><option value="critical">Critical</option></select></div>
        <div><label>Interval (days)</label><input id="mf-interval" placeholder="90" /></div>
        <div><label>Technician</label><input id="mf-tech" placeholder="name" /></div>
        <button class="btn btn-primary" onclick="submitMaintenanceForm()">+ Schedule</button>
      </div>
    </div>` : ""}
    <div class="form-card">
      <div class="list-header"><span>WO #</span><span style="flex:2;">Device</span><span>Type</span><span>Priority</span><span>Due</span><span>Cost</span><span>Status</span><span></span></div>
      ${maintenanceRecords.map(m => {
        const device = devices.find(d => d.id === m.deviceId);
        const sc = m.status === "COMPLETED" ? "active" : m.status === "CANCELLED" ? "inactive" : m.status === "IN_PROGRESS" ? "warning" : "";
        const typeColors = { preventive: "#3B82F6", corrective: "#E5484D", predictive: "#8B5CF6" };
        const priColors = { low: "#8B95A1", normal: "#3B82F6", high: "#F2B705", critical: "#E5484D" };
        return `<div class="list-row">
          <span class="list-cell mono">${esc(m.workOrderNumber)}</span>
          <span class="list-cell" style="flex:2;">${device ? esc(device.name) : m.deviceId}</span>
          <span class="list-cell" style="font-size:11px;color:${typeColors[m.maintenanceType] || "#8B95A1"};">${m.maintenanceType || "corrective"}</span>
          <span class="list-cell" style="font-size:11px;color:${priColors[m.priority] || "#8B95A1"};">${m.priority || "normal"}</span>
          <span class="list-cell mono">${m.dueDate ? new Date(m.dueDate).toLocaleDateString() : "—"}</span>
          <span class="list-cell mono">${m.totalCost > 0 ? "$" + m.totalCost.toFixed(2) : "—"}</span>
          <span class="list-cell"><span class="status-badge ${sc}">${m.status}</span></span>
          <span class="list-cell sm">
            ${hasRole("manager") && m.status === "SCHEDULED" ? `<button class="btn btn-sm" onclick="updateMaintenanceStatus('${m.id}','IN_PROGRESS')">Start</button>` : ""}
            ${hasRole("manager") && m.status === "IN_PROGRESS" ? `<button class="btn btn-sm" onclick="showCompleteMaintenance('${m.id}')">Done</button>` : ""}
            ${hasRole("manager") && (m.status === "SCHEDULED" || m.status === "IN_PROGRESS") ? `<button class="btn btn-sm btn-danger" onclick="updateMaintenanceStatus('${m.id}','CANCELLED')">Cancel</button>` : ""}
          </span>
        </div>`;
      }).join("") || `<div class="empty">No maintenance records.</div>`}
    </div>`;
}

function showCompleteMaintenance(id) {
  const m = maintenanceRecords.find(r => r.id === id);
  if (!m) return;
  const html = `<div class="form-card" style="margin-bottom:16px;">
    <div class="section-label mono" style="margin-bottom:10px;">Complete: ${esc(m.workOrderNumber)}</div>
    <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr 1fr 1fr 1fr;">
      <div><label>Failure Mode</label><input id="cm-failure" placeholder="e.g. sensor drift" /></div>
      <div><label>Root Cause</label><input id="cm-root" placeholder="e.g. worn bearing" /></div>
      <div><label>Parts Cost ($)</label><input id="cm-parts" type="number" step="0.01" value="0" /></div>
      <div><label>Labour Cost ($)</label><input id="cm-labour" type="number" step="0.01" value="0" /></div>
      <div><label>Labour Hours</label><input id="cm-hours" type="number" step="0.1" value="1" /></div>
      <div><label>Downtime (min)</label><input id="cm-down" type="number" value="0" /></div>
    </div>
    <div style="margin-top:8px;"><label>Notes</label><input id="cm-notes" style="width:100%;" placeholder="Additional notes..." /></div>
    <div style="margin-top:8px;"><button class="btn btn-primary" onclick="submitCompleteMaintenance('${id}')">Complete & Save</button> <button class="btn" onclick="render()">Cancel</button></div>
  </div>`;
  document.getElementById("main-content").insertAdjacentHTML("afterbegin", html);
}

async function submitCompleteMaintenance(id) {
  const body = {
    status: "COMPLETED",
    failureMode: document.getElementById("cm-failure").value,
    rootCause: document.getElementById("cm-root").value,
    partsCost: parseFloat(document.getElementById("cm-parts").value) || 0,
    labourCost: parseFloat(document.getElementById("cm-labour").value) || 0,
    labourHours: parseFloat(document.getElementById("cm-hours").value) || 0,
    downtimeMinutes: parseInt(document.getElementById("cm-down").value) || 0,
    notes: document.getElementById("cm-notes").value,
  };
  await authFetch(`${API}/api/maintenance/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  toast("Maintenance completed", "success");
  await loadMaintenanceRecords();
}

// ---------- Maintenance Schedules ----------

let maintenanceSchedules = [];
let maintenanceFailures = [];
let mlModels = [];
let mlPredictions = [];

async function loadMaintenanceSchedules() {
  try { const res = await authFetch(`${API}/api/maintenance-schedules`); maintenanceSchedules = await res.json(); } catch (e) { maintenanceSchedules = []; }
}

async function loadMaintenanceFailures() {
  try { const res = await authFetch(`${API}/api/maintenance-failures`); maintenanceFailures = await res.json(); } catch (e) { maintenanceFailures = []; }
}

function viewMaintenanceSchedules() {
  return `
    <div class="top-bar">
      <div><h2>Maintenance Schedules</h2><div class="subtitle">Preventive maintenance rules</div></div>
      <div class="top-bar-actions">
        <button class="btn" onclick="currentView='maintenance';render();">Back</button>
        ${hasRole("manager") ? `<button class="btn btn-primary" onclick="showNewMaintenanceSchedule()">+ New Schedule</button>` : ""}
        ${hasRole("manager") ? `<button class="btn" onclick="generateFromSchedules()">Generate Now</button>` : ""}
      </div>
    </div>
    <div id="ms-form-area"></div>
    <div class="form-card">
      ${maintenanceSchedules.length ? maintenanceSchedules.map(s => {
        const device = devices.find(d => d.id === s.deviceId);
        return `<div class="list-row">
          <span class="list-cell" style="flex:2;">
            <div style="font-weight:500;">${esc(s.name)}</div>
            <div style="font-size:11px;color:var(--muted);">${device ? esc(device.name) : s.deviceId}</div>
          </span>
          <span class="list-cell" style="font-size:11px;">${esc(s.maintenanceType)}</span>
          <span class="list-cell mono">Every ${s.intervalDays} days</span>
          <span class="list-cell">${s.reminderDays || 7}d reminder</span>
          <span class="list-cell">${s.technician || "Any"}</span>
          <span class="list-cell"><span class="status-badge ${s.enabled ? "active" : "inactive"}">${s.enabled ? "Enabled" : "Disabled"}</span></span>
          <span class="list-cell sm">
            ${hasRole("manager") ? `<button class="btn btn-sm btn-danger" onclick="deleteMaintenanceSchedule('${s.id}')">✕</button>` : ""}
          </span>
        </div>`;
      }).join("") : `<div class="empty">No maintenance schedules defined.</div>`}
    </div>`;
}

function showNewMaintenanceSchedule() {
  document.getElementById("ms-form-area").innerHTML = `
    <div class="form-card" style="margin-bottom:16px;">
      <div class="section-label mono" style="margin-bottom:10px;">New Maintenance Schedule</div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr 1fr 1fr auto;">
        <div><label>Name</label><input id="ms-name" placeholder="Weekly Inspection" /></div>
        <div><label>Device</label><select id="ms-device">${devices.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}</select></div>
        <div><label>Interval (days)</label><input id="ms-interval" type="number" value="30" /></div>
        <div><label>Type</label><select id="ms-type"><option value="preventive">Preventive</option><option value="predictive">Predictive</option></select></div>
        <div><label>Reminder (days)</label><input id="ms-reminder" type="number" value="7" /></div>
        <div style="display:flex;align-items:end;"><button class="btn btn-primary" onclick="createMaintenanceSchedule()">Create</button></div>
      </div>
    </div>`;
}

async function createMaintenanceSchedule() {
  const name = document.getElementById("ms-name").value || "Schedule";
  const deviceId = document.getElementById("ms-device").value;
  const intervalDays = parseInt(document.getElementById("ms-interval").value) || 30;
  const maintenanceType = document.getElementById("ms-type").value;
  const reminderDays = parseInt(document.getElementById("ms-reminder").value) || 7;
  await authFetch(`${API}/api/maintenance-schedules`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, deviceId, intervalDays, maintenanceType, reminderDays }) });
  toast("Schedule created", "success");
  await loadMaintenanceSchedules();
  render();
}

async function deleteMaintenanceSchedule(id) {
  if (!await showConfirm({ title: "Delete Schedule", message: "Delete this schedule?", danger: true })) return;
  await authFetch(`${API}/api/maintenance-schedules/${id}`, { method: "DELETE" });
  toast("Schedule deleted", "success");
  await loadMaintenanceSchedules();
  render();
}

async function generateFromSchedules() {
  const res = await authFetch(`${API}/api/maintenance-schedules/generate`, { method: "POST" });
  const data = await res.json();
  toast(`Generated ${data.generated} maintenance record(s)`, "success");
  await loadMaintenanceRecords();
  render();
}

// ---------- Maintenance Failures ----------

function viewMaintenanceFailures() {
  return `
    <div class="top-bar">
      <div><h2>Maintenance Failures</h2><div class="subtitle">Track failures for MTBF analysis</div></div>
      <div class="top-bar-actions">
        <button class="btn" onclick="currentView='maintenance';render();">Back</button>
        ${hasRole("manager") ? `<button class="btn btn-primary" onclick="showNewFailure()">+ Log Failure</button>` : ""}
      </div>
    </div>
    <div id="mf-fail-form-area"></div>
    <div class="form-card">
      <div class="list-header"><span>Time</span><span style="flex:1.5;">Device</span><span>Type</span><span>Mode</span><span>Severity</span><span>Downtime</span><span>Cost</span><span></span></div>
      ${maintenanceFailures.length ? maintenanceFailures.map(f => {
        const device = devices.find(d => d.id === f.deviceId);
        const sevColors = { low: "#8B95A1", normal: "#F2B705", high: "#E5484D", critical: "#E5484D" };
        return `<div class="list-row">
          <span class="list-cell" style="font-size:12px;">${new Date(f.occurredAt).toLocaleString()}</span>
          <span class="list-cell" style="flex:1.5;">${device ? esc(device.name) : f.deviceId}</span>
          <span class="list-cell" style="font-size:11px;">${esc(f.failureType)}</span>
          <span class="list-cell" style="font-size:11px;">${esc(f.failureMode || "-")}</span>
          <span class="list-cell" style="font-size:11px;color:${sevColors[f.severity] || "#8B95A1"};">${f.severity}</span>
          <span class="list-cell mono">${f.downtimeMinutes || 0}m</span>
          <span class="list-cell mono">${f.cost > 0 ? "$" + f.cost.toFixed(2) : "—"}</span>
          <span class="list-cell sm">${f.resolvedAt ? '<span class="status-badge active">Resolved</span>' : `<button class="btn btn-sm" onclick="resolveFailure('${f.id}')">Resolve</button>`}</span>
        </div>`;
      }).join("") : `<div class="empty">No failure records.</div>`}
    </div>`;
}

function showNewFailure() {
  document.getElementById("mf-fail-form-area").innerHTML = `
    <div class="form-card" style="margin-bottom:16px;">
      <div class="section-label mono" style="margin-bottom:10px;">Log Failure</div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr 1fr 1fr auto;">
        <div><label>Device</label><select id="fl-device">${devices.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}</select></div>
        <div><label>Type</label><input id="fl-type" placeholder="e.g. mechanical" /></div>
        <div><label>Failure Mode</label><input id="fl-mode" placeholder="e.g. sensor drift" /></div>
        <div><label>Severity</label><select id="fl-severity"><option value="low">Low</option><option value="normal" selected>Normal</option><option value="high">High</option><option value="critical">Critical</option></select></div>
        <div><label>Cost ($)</label><input id="fl-cost" type="number" step="0.01" value="0" /></div>
        <div style="display:flex;align-items:end;"><button class="btn btn-primary" onclick="addFailure()">Log</button></div>
      </div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;margin-top:8px;">
        <div><label>Description</label><input id="fl-desc" placeholder="What happened" /></div>
        <div><label>Root Cause</label><input id="fl-root" placeholder="Why it happened" /></div>
        <div><label>Downtime (min)</label><input id="fl-down" type="number" value="0" /></div>
      </div>
    </div>`;
}

async function addFailure() {
  const deviceId = document.getElementById("fl-device").value;
  const failureType = document.getElementById("fl-type").value || "unknown";
  const failureMode = document.getElementById("fl-mode").value;
  const severity = document.getElementById("fl-severity").value;
  const cost = parseFloat(document.getElementById("fl-cost").value) || 0;
  const description = document.getElementById("fl-desc").value;
  const rootCause = document.getElementById("fl-root").value;
  const downtimeMinutes = parseInt(document.getElementById("fl-down").value) || 0;
  await authFetch(`${API}/api/maintenance-failures`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId, failureType, failureMode, severity, cost, description, rootCause, downtimeMinutes }) });
  toast("Failure logged", "success");
  await loadMaintenanceFailures();
  render();
}

async function resolveFailure(id) {
  const resolution = await showPrompt({ title: "Resolve Failure", label: "Describe the resolution:" });
  if (resolution === null) return;
  await authFetch(`${API}/api/maintenance-failures/${id}/resolve`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resolution }) });
  toast("Failure resolved", "success");
  await loadMaintenanceFailures();
  render();
}

// ---------- Calibration ----------

// ============================================================
// PHASE 6: Predictive Maintenance — Frontend Views
// ============================================================

let healthTrend = null;
let rulEstimate = null;
let failureAnalysis = null;
let costAnalysis = null;

function viewPredictiveMaintenance() {
  return `
    <div class="top-bar">
      <div><h2>Predictive Maintenance</h2><div class="subtitle">Health trends, RUL, optimization</div></div>
      <div class="top-bar-actions">
        <button class="btn" onclick="currentView='maintenance';render();">Back</button>
      </div>
    </div>
    <div class="form-card" style="margin-bottom:16px;">
      <div class="form-grid" style="grid-template-columns:1fr auto;">
        <div><label>Device</label><select id="pm-device" onchange="loadPredictiveData()">${devices.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}</select></div>
        <button class="btn btn-primary" onclick="loadPredictiveData()" style="align-self:end;">Analyze</button>
      </div>
    </div>
    <div id="pm-results">
      ${healthTrend ? renderHealthTrend() : ""}
      ${rulEstimate ? renderRUL() : ""}
      ${failureAnalysis ? renderFailureAnalysis() : ""}
      ${costAnalysis ? renderCostAnalysis() : ""}
      ${!healthTrend && !rulEstimate && !failureAnalysis && !costAnalysis ? '<div class="form-card" style="text-align:center;padding:30px;color:var(--muted);">Select a device and click Analyze to see predictive insights.</div>' : ""}
    </div>`;
}

async function loadPredictiveData() {
  const deviceId = document.getElementById("pm-device")?.value || devices[0]?.id;
  if (!deviceId) return;
  toast("Analyzing...", "info");
  try {
    const [trendRes, rulRes, failRes, costRes] = await Promise.all([
      authFetch(`${API}/api/devices/${deviceId}/health-trend`),
      authFetch(`${API}/api/devices/${deviceId}/rul`),
      authFetch(`${API}/api/devices/${deviceId}/failure-analysis`),
      authFetch(`${API}/api/devices/${deviceId}/cost-analysis`),
    ]);
    healthTrend = await trendRes.json();
    rulEstimate = await rulRes.json();
    failureAnalysis = await failRes.json();
    costAnalysis = await costRes.json();
    render();
  } catch (e) { toast("Analysis failed", "error"); }
}

function renderHealthTrend() {
  if (!healthTrend || healthTrend.message) return `<div class="form-card" style="padding:16px;color:var(--muted);">${healthTrend?.message || "No data"}</div>`;
  const t = healthTrend;
  const dirColor = t.trend.direction === "degrading" ? "#E5484D" : t.trend.direction === "improving" ? "#27ae60" : "#3B82F6";
  return `<div class="form-card" style="margin-bottom:16px;">
    <div class="section-label mono" style="margin-bottom:12px;">Health Trend</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;">
      <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Current</span><span class="kv-value mono" style="color:${t.stats.currentScore >= 80 ? "#27ae60" : t.stats.currentScore >= 50 ? "#F2B705" : "#E5484D"};">${t.stats.currentScore}</span></div>
      <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Average</span><span class="kv-value mono">${t.stats.averageScore}</span></div>
      <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Trend</span><span class="kv-value mono" style="color:${dirColor};">${t.trend.direction}</span></div>
      <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Degradation</span><span class="kv-value mono">${t.trend.degradationRate} pts/wk</span></div>
    </div>
    <div class="kv-row"><span class="kv-label">Volatility</span><span class="kv-value">${t.stats.volatility}</span></div>
    <div class="kv-row"><span class="kv-label">Old Avg</span><span class="kv-value">${t.comparison.oldAverage}</span></div>
    <div class="kv-row"><span class="kv-label">Recent Avg</span><span class="kv-value">${t.comparison.recentAverage}</span></div>
    <div class="kv-row"><span class="kv-label">Change</span><span class="kv-value" style="color:${t.comparison.change >= 0 ? "#27ae60" : "#E5484D"};">${t.comparison.change > 0 ? "+" : ""}${t.comparison.change}</span></div>
    ${t.history.length ? `<div style="margin-top:12px;font-size:11px;color:var(--muted);">Score history:</div>
    <div style="display:flex;gap:2px;margin-top:4px;align-items:end;height:40px;">
      ${t.history.map(h => `<div style="flex:1;background:${h.score >= 80 ? "#27ae60" : h.score >= 50 ? "#F2B705" : "#E5484D"};height:${h.score}%;min-height:2px;border-radius:2px 2px 0 0;" title="${h.score} at ${new Date(h.at).toLocaleDateString()}"></div>`).join("")}
    </div>` : ""}
  </div>`;
}

function renderRUL() {
  if (!rulEstimate || rulEstimate.message) return `<div class="form-card" style="padding:16px;color:var(--muted);">${rulEstimate?.message || "No data"}</div>`;
  const r = rulEstimate;
  const urgColor = r.urgency === "critical" ? "#E5484D" : r.urgency === "high" ? "#F2B705" : r.urgency === "medium" ? "#3B82F6" : "#27ae60";
  return `<div class="form-card" style="margin-bottom:16px;border-left:4px solid ${urgColor};">
    <div class="section-label mono" style="margin-bottom:12px;">Remaining Useful Life</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;">
      <div class="kv-row" style="flex-direction:column;"><span class="kv-label">RUL</span><span class="kv-value mono" style="font-size:24px;color:${urgColor};">${r.rulDays} days</span></div>
      <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Confidence</span><span class="kv-value mono">${(r.confidence * 100).toFixed(0)}%</span></div>
      <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Health Score</span><span class="kv-value mono">${r.currentScore}</span></div>
      <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Threshold</span><span class="kv-value mono">${r.failureThreshold}</span></div>
    </div>
    <div class="kv-row"><span class="kv-label">Degradation Rate</span><span class="kv-value">${r.degradationRate} pts/wk</span></div>
    <div class="kv-row"><span class="kv-label">Est. Failure</span><span class="kv-value">${r.estimatedFailureDate ? new Date(r.estimatedFailureDate).toLocaleDateString() : "N/A"}</span></div>
    <div class="kv-row"><span class="kv-label">Urgency</span><span class="kv-value" style="color:${urgColor};font-weight:600;">${r.urgency.toUpperCase()}</span></div>
    <div style="margin-top:12px;padding:10px;background:#1B2129;border-radius:6px;font-size:12px;color:var(--muted);">${r.recommendation}</div>
  </div>`;
}

function renderFailureAnalysis() {
  if (!failureAnalysis || failureAnalysis.message) return `<div class="form-card" style="padding:16px;color:var(--muted);">${failureAnalysis?.message || "No data"}</div>`;
  const f = failureAnalysis;
  return `<div class="form-card" style="margin-bottom:16px;">
    <div class="section-label mono" style="margin-bottom:12px;">Failure Mode Analysis</div>
    <div class="kv-row"><span class="kv-label">Total Failures</span><span class="kv-value">${f.totalFailures}</span></div>
    ${f.timeAnalysis.avgIntervalHours ? `<div class="kv-row"><span class="kv-label">Avg Interval</span><span class="kv-value">${f.timeAnalysis.avgIntervalHours}h</span></div>` : ""}
    ${f.byType.length ? `<div style="margin-top:12px;font-size:12px;color:var(--muted);margin-bottom:8px;">By Type:</div>
    ${f.byType.map(t => `<div class="list-row">
      <span class="list-cell" style="flex:2;font-weight:500;">${esc(t.type)}</span>
      <span class="list-cell mono">${t.count}x</span>
      <span class="list-cell mono">${t.totalDowntime}m</span>
      <span class="list-cell mono">$${t.totalCost.toFixed(2)}</span>
      <span class="list-cell" style="font-size:11px;color:var(--muted);">${t.topMode ? `Top: ${esc(t.topMode)}` : ""}</span>
    </div>`).join("")}` : ""}
    ${f.topRootCauses.length ? `<div style="margin-top:12px;font-size:12px;color:var(--muted);margin-bottom:8px;">Top Root Causes:</div>
    ${f.topRootCauses.map(r => `<div class="list-row"><span class="list-cell" style="flex:2;">${esc(r.cause)}</span><span class="list-cell mono">${r.count}x</span></div>`).join("")}` : ""}
  </div>`;
}

function renderCostAnalysis() {
  if (!costAnalysis || costAnalysis.message) return `<div class="form-card" style="padding:16px;color:var(--muted);">${costAnalysis?.message || "No data"}</div>`;
  const c = costAnalysis;
  return `<div class="form-card" style="margin-bottom:16px;">
    <div class="section-label mono" style="margin-bottom:12px;">Cost Optimization Analysis</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px;">
      <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Total Cost</span><span class="kv-value mono">$${c.summary.totalCost.toFixed(2)}</span></div>
      <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Avg/Event</span><span class="kv-value mono">$${c.summary.avgCostPerEvent.toFixed(2)}</span></div>
      <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Total Downtime</span><span class="kv-value mono">${c.summary.totalDowntime}m</span></div>
    </div>
    ${c.byType.length ? `<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">By Type:</div>
    ${c.byType.map(t => `<div class="list-row">
      <span class="list-cell" style="flex:1.5;">${esc(t.type)}</span>
      <span class="list-cell mono">$${t.cost.toFixed(2)}</span>
      <span class="list-cell mono">${t.count} events</span>
      <span class="list-cell mono">${t.downtime}m downtime</span>
    </div>`).join("")}` : ""}
    <div style="margin-top:12px;padding:10px;background:#1B2129;border-radius:6px;">
      <div style="font-size:12px;color:var(--muted);margin-bottom:4px;">Optimization</div>
      <div class="kv-row"><span class="kv-label">Corrective %</span><span class="kv-value" style="color:${c.optimization.correctiveRatio > 60 ? "#E5484D" : "#F2B705"};">${c.optimization.correctiveRatio}%</span></div>
      <div class="kv-row"><span class="kv-label">Preventive %</span><span class="kv-value" style="color:#27ae60;">${c.optimization.preventiveRatio}%</span></div>
      <div class="kv-row"><span class="kv-label">Potential Savings</span><span class="kv-value" style="color:#27ae60;">$${c.optimization.potentialSavings.toFixed(2)}</span></div>
      <div style="margin-top:6px;font-size:11px;color:var(--muted);">${c.optimization.recommendation}</div>
    </div>
  </div>`;
}

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
  const actualBags = await showPrompt({ title: "Complete Shift", label: "How many bags were actually filled?", defaultValue: "0", type: "number" });
  if (actualBags === null) return;
  await authFetch(`${API}/api/production-schedules/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "completed", actualBags: parseInt(actualBags) || 0, actualEnd: new Date().toISOString() }) });
  toast("Shift completed", "success");
  await loadProductionSchedules();
}

async function deleteSchedule(id) {
  if (!await showConfirm({ title: "Delete Shift", message: "Delete this shift?", danger: true })) return;
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
        <div class="kv-row"><span class="kv-label">Total units</span><span class="kv-value">${d.totalUnits || d.totalBags}</span></div>
        <div class="kv-row"><span class="kv-label">Good units</span><span class="kv-value" style="color:#27ae60;">${d.goodUnits || d.goodBags}</span></div>
        <div class="kv-row"><span class="kv-label">Rejects</span><span class="kv-value" style="color:#E5484D;">${d.rejectUnits || d.overBags}</span></div>
        <div class="kv-row"><span class="kv-label">Source</span><span class="kv-value" style="font-size:12px;">${d.hasOrders ? "Production orders" : "Readings"}</span></div>
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
      <div class="section-label mono" style="margin-bottom:10px;">X-bar Chart (Individual Readings) — ${esc(spcMetric)}</div>
      <canvas id="spc-xbar" height="200"></canvas>
    </div>
    <div class="form-card" style="margin-top:16px;">
      <div class="section-label mono" style="margin-bottom:10px;">Histogram (${esc(spcMetric)} Distribution)</div>
      <canvas id="spc-histogram" height="160"></canvas>
    </div>
  `;
}

function viewSPC() {
  const device = devices.find(d => d.id === spcDeviceId) || devices[0];
  const product = products.find(p => p.id === device?.productId);

  // Collect all available metrics for this device
  const availableMetrics = [
    { id: "weight", label: "Weight (from readings)" },
    { id: "bag_count", label: "Bag Count" },
  ];
  const telemetry = latestTelemetry.get(device?.id);
  if (telemetry?.metrics) {
    for (const [k, v] of Object.entries(telemetry.metrics)) {
      if (typeof v === "number" && !availableMetrics.find(m => m.id === k)) {
        availableMetrics.push({ id: k, label: k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " ") });
      }
    }
  }

  return `
    <div class="top-bar">
      <div><h2>SPC Analysis</h2><div class="subtitle">Statistical Process Control — X-bar, Cpk, Histogram</div></div>
      <div class="top-bar-actions">
        <select onchange="spcDeviceId=this.value;loadSPCData()" style="padding:6px 10px;border-radius:6px;background:#1B2129;color:#E8EAED;border:1px solid #2A333D;">
          ${devices.map(d => `<option value="${d.id}" ${d.id === spcDeviceId ? "selected" : ""}>${esc(d.name)}</option>`).join("")}
        </select>
        <select onchange="spcMetric=this.value;loadSPCData()" style="padding:6px 10px;border-radius:6px;background:#1B2129;color:#E8EAED;border:1px solid #2A333D;margin-left:8px;">
          ${availableMetrics.map(m => `<option value="${m.id}" ${m.id === spcMetric ? "selected" : ""}>${esc(m.label)}</option>`).join("")}
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

  if (spcMetric === "weight") {
    // Use traditional readings
    try {
      const res = await authFetch(`${API}/api/devices/${spcDeviceId}/readings-range?days=7`);
      spcReadings = await res.json();
    } catch (e) { console.error("SPC load failed:", e); spcReadings = []; }
  } else {
    // Use telemetry data for the selected metric
    try {
      const res = await authFetch(`${API}/api/telemetry/${spcDeviceId}/range?from=${new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()}&to=${new Date().toISOString()}&metric=${spcMetric}`);
      const data = await res.json();
      // Convert telemetry format to readings format for SPC
      spcReadings = data.map(d => ({
        weight: d.value,
        ts: d.ts,
        phase: "complete",
        bagCount: 0,
        connected: true,
      }));
    } catch (e) { console.error("SPC telemetry load failed:", e); spcReadings = []; }
  }

  render();
  setTimeout(renderSPCChartInstances, 100);
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

// ============================================================
// PHASE 3: Manufacturing — Production Orders, Quality, Shifts
// ============================================================

function viewProductionOrders() {
  const orders = productionOrders;
  const statuses = ["planned", "in_progress", "completed", "cancelled"];
  const statusColors = { planned: "#8B95A1", in_progress: "#3B82F6", completed: "#27ae60", cancelled: "#E5484D" };
  return `
    <div class="top-bar">
      <div><h2>Production Orders</h2><div class="subtitle">Track production runs, quantities, and status</div></div>
      <div class="top-bar-actions">
        ${hasRole("manager") ? `<button class="btn btn-primary" onclick="showNewProductionOrder()">+ New Order</button>` : ""}
      </div>
    </div>
    <div id="po-form-area"></div>
    <div class="list" style="display:flex;flex-direction:column;gap:4px;">
      <div class="list-row header">
        <span class="list-cell" style="flex:2;">Order #</span>
        <span class="list-cell">Product</span>
        <span class="list-cell">Device</span>
        <span class="list-cell">Planned</span>
        <span class="list-cell">Actual</span>
        <span class="list-cell">Quality</span>
        <span class="list-cell">Status</span>
        <span class="list-cell sm">Actions</span>
      </div>
      ${orders.length ? orders.map(o => {
        const product = products.find(p => p.id === o.productId);
        const device = devices.find(d => d.id === o.deviceId);
        const pct = o.plannedQuantity > 0 ? Math.round((o.actualQuantity / o.plannedQuantity) * 100) : 0;
        return `<div class="list-row">
          <span class="list-cell" style="flex:2;font-weight:500;">${esc(o.orderNumber)}</span>
          <span class="list-cell">${product ? esc(product.name) : "-"}</span>
          <span class="list-cell">${device ? esc(device.name) : "-"}</span>
          <span class="list-cell mono">${o.plannedQuantity} ${esc(o.unit || "units")}</span>
          <span class="list-cell mono">${o.actualQuantity} (${pct}%)</span>
          <span class="list-cell mono" style="color:${o.goodQuantity > 0 ? "#27ae60" : "#8B95A1"};">${o.goodQuantity} good</span>
          <span class="list-cell"><span class="status-badge" style="background:${statusColors[o.status] || "#8B95A1"}22;color:${statusColors[o.status] || "#8B95A1"}">${o.status}</span></span>
          <span class="list-cell sm">
            ${o.status === "planned" && hasRole("manager") ? `<button class="btn btn-sm" onclick="updatePOStatus('${o.id}','in_progress')">Start</button>` : ""}
            ${o.status === "in_progress" && hasRole("manager") ? `<button class="btn btn-sm btn-success" onclick="updatePOStatus('${o.id}','completed')">Complete</button>` : ""}
            ${hasRole("manager") ? `<button class="btn btn-sm btn-danger" onclick="deletePO('${o.id}')">✕</button>` : ""}
          </span>
        </div>`;
      }).join("") : `<div style="padding:20px;color:var(--muted);text-align:center;">No production orders. Create one to start tracking.</div>`}
    </div>`;
}

function showNewProductionOrder() {
  document.getElementById("po-form-area").innerHTML = `
    <div class="form-card" style="margin-bottom:16px;">
      <div class="section-label mono" style="margin-bottom:10px;">New Production Order</div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr 1fr auto;">
        <div><label>Order #</label><input id="po-num" placeholder="PO-001" /></div>
        <div><label>Product</label><select id="po-product">${products.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></div>
        <div><label>Device</label><select id="po-device"><option value="">None</option>${devices.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}</select></div>
        <div><label>Planned Qty</label><input id="po-qty" type="number" value="100" /></div>
        <div style="display:flex;align-items:end;"><button class="btn btn-primary" onclick="createPO()">Create</button></div>
      </div>
    </div>`;
}

async function createPO() {
  const orderNumber = document.getElementById("po-num").value || `PO-${Date.now()}`;
  const productId = document.getElementById("po-product").value;
  const deviceId = document.getElementById("po-device").value || undefined;
  const plannedQuantity = parseInt(document.getElementById("po-qty").value) || 100;
  const product = products.find(p => p.id === productId);
  await authFetch(`${API}/api/production-orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderNumber, productId, deviceId, plannedQuantity, unit: product?.unit || "units" }) });
  toast("Production order created", "success");
  await loadProductionOrders();
}

async function updatePOStatus(id, status) {
  await authFetch(`${API}/api/production-orders/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, actualStart: status === "in_progress" ? new Date().toISOString() : undefined, actualEnd: status === "completed" ? new Date().toISOString() : undefined }) });
  toast(`Order ${status}`, "success");
  await loadProductionOrders();
}

async function deletePO(id) {
  if (!await showConfirm({ title: "Delete Production Order", message: "Delete this production order?", danger: true })) return;
  await authFetch(`${API}/api/production-orders/${id}`, { method: "DELETE" });
  toast("Order deleted", "success");
  await loadProductionOrders();
}

async function loadProductionOrders() {
  try { const res = await authFetch(`${API}/api/production-orders`); productionOrders = await res.json(); } catch (e) { productionOrders = []; }
}

// --- Quality Metrics ---

function viewQualityMetrics() {
  return `
    <div class="top-bar">
      <div><h2>Quality Metrics</h2><div class="subtitle">Track pass/fail for any metric against tolerances</div></div>
      <div class="top-bar-actions">
        ${hasRole("manager") ? `<button class="btn btn-primary" onclick="showNewQualityMetric()">+ Add Measurement</button>` : ""}
      </div>
    </div>
    <div id="qm-form-area"></div>
    <div class="list" style="display:flex;flex-direction:column;gap:4px;">
      <div class="list-row header">
        <span class="list-cell">Time</span>
        <span class="list-cell" style="flex:1.5;">Metric</span>
        <span class="list-cell">Value</span>
        <span class="list-cell">Target</span>
        <span class="list-cell">Range</span>
        <span class="list-cell">Result</span>
        <span class="list-cell">Order</span>
      </div>
      ${qualityMetrics.length ? qualityMetrics.map(q => {
        const order = productionOrders.find(o => o.id === q.orderId);
        return `<div class="list-row">
          <span class="list-cell" style="font-size:12px;">${new Date(q.measuredAt).toLocaleString()}</span>
          <span class="list-cell" style="flex:1.5;font-weight:500;">${esc(q.metricName)}</span>
          <span class="list-cell mono">${q.metricValue} ${esc(q.unit || "")}</span>
          <span class="list-cell mono">${q.targetValue !== null ? q.targetValue : "-"}</span>
          <span class="list-cell mono" style="font-size:11px;">${q.minValue !== null ? q.minValue : "-"} to ${q.maxValue !== null ? q.maxValue : "-"}</span>
          <span class="list-cell"><span class="status-badge" style="background:${q.pass ? "#27ae6022" : "#E5484D22"};color:${q.pass ? "#27ae60" : "#E5484D"}">${q.pass ? "PASS" : "FAIL"}</span></span>
          <span class="list-cell" style="font-size:12px;">${order ? esc(order.orderNumber) : "-"}</span>
        </div>`;
      }).join("") : `<div style="padding:20px;color:var(--muted);text-align:center;">No quality measurements recorded.</div>`}
    </div>`;
}

function showNewQualityMetric() {
  document.getElementById("qm-form-area").innerHTML = `
    <div class="form-card" style="margin-bottom:16px;">
      <div class="section-label mono" style="margin-bottom:10px;">Add Quality Measurement</div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr 1fr 1fr auto;">
        <div><label>Metric Name</label><input id="qm-name" placeholder="e.g. weight, temperature" /></div>
        <div><label>Value</label><input id="qm-value" type="number" step="any" /></div>
        <div><label>Target</label><input id="qm-target" type="number" step="any" /></div>
        <div><label>Min</label><input id="qm-min" type="number" step="any" /></div>
        <div><label>Max</label><input id="qm-max" type="number" step="any" /></div>
        <div style="display:flex;align-items:end;"><button class="btn btn-primary" onclick="addQM()">Add</button></div>
      </div>
    </div>`;
}

async function addQM() {
  const metricName = document.getElementById("qm-name").value || "unknown";
  const metricValue = parseFloat(document.getElementById("qm-value").value) || 0;
  const targetValue = document.getElementById("qm-target").value ? parseFloat(document.getElementById("qm-target").value) : null;
  const minValue = document.getElementById("qm-min").value ? parseFloat(document.getElementById("qm-min").value) : null;
  const maxValue = document.getElementById("qm-max").value ? parseFloat(document.getElementById("qm-max").value) : null;
  await authFetch(`${API}/api/quality-metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: devices[0]?.id, metricName, metricValue, targetValue, minValue, maxValue }) });
  toast("Quality measurement added", "success");
  await loadQualityMetrics();
}

async function loadQualityMetrics() {
  try { const res = await authFetch(`${API}/api/quality-metrics`); qualityMetrics = await res.json(); } catch (e) { qualityMetrics = []; }
}

// --- Shift Templates ---

function viewShiftTemplates() {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `
    <div class="top-bar">
      <div><h2>Shift Templates</h2><div class="subtitle">Define reusable shift schedules</div></div>
      <div class="top-bar-actions">
        ${hasRole("manager") ? `<button class="btn btn-primary" onclick="showNewShiftTemplate()">+ New Shift</button>` : ""}
      </div>
    </div>
    <div id="st-form-area"></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;">
      ${shiftTemplates.length ? shiftTemplates.map(s => `<div class="form-card" style="border-left:4px solid ${s.color || '#3B82F6'};">
        <div style="display:flex;justify-content:space-between;align-items:start;">
          <div>
            <div style="font-weight:600;font-size:16px;">${esc(s.name)}</div>
            <div style="color:var(--muted);font-size:13px;margin-top:4px;">${s.startTime} – ${s.endTime} ${s.breakMinutes > 0 ? `(${s.breakMinutes}m break)` : ""}</div>
            <div style="margin-top:6px;display:flex;gap:4px;">
              ${dayNames.map((d, i) => `<span style="width:28px;height:20px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;background:${s.daysOfWeek.includes(i) ? s.color || "#3B82F6" : "#1B2129"};color:${s.daysOfWeek.includes(i) ? "#fff" : "#5B6673"};">${d}</span>`).join("")}
            </div>
          </div>
          ${hasRole("manager") ? `<button class="btn btn-sm btn-danger" onclick="deleteShiftTemplate('${s.id}')">Delete</button>` : ""}
        </div>
      </div>`).join("") : `<div style="padding:20px;color:var(--muted);text-align:center;grid-column:1/-1;">No shift templates defined.</div>`}
    </div>`;
}

function showNewShiftTemplate() {
  document.getElementById("st-form-area").innerHTML = `
    <div class="form-card" style="margin-bottom:16px;">
      <div class="section-label mono" style="margin-bottom:10px;">New Shift Template</div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr 1fr auto;">
        <div><label>Name</label><input id="st-name" placeholder="Morning" /></div>
        <div><label>Start</label><input id="st-start" type="time" value="06:00" /></div>
        <div><label>End</label><input id="st-end" type="time" value="14:00" /></div>
        <div><label>Break (min)</label><input id="st-break" type="number" value="30" /></div>
        <div style="display:flex;align-items:end;"><button class="btn btn-primary" onclick="createShiftTemplate()">Create</button></div>
      </div>
    </div>`;
}

async function createShiftTemplate() {
  const name = document.getElementById("st-name").value || "Shift";
  const startTime = document.getElementById("st-start").value || "06:00";
  const endTime = document.getElementById("st-end").value || "14:00";
  const breakMinutes = parseInt(document.getElementById("st-break").value) || 0;
  await authFetch(`${API}/api/shift-templates`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, startTime, endTime, breakMinutes }) });
  toast("Shift template created", "success");
  await loadShiftTemplates();
}

async function deleteShiftTemplate(id) {
  if (!await showConfirm({ title: "Delete Shift Template", message: "Delete this shift template?", danger: true })) return;
  await authFetch(`${API}/api/shift-templates/${id}`, { method: "DELETE" });
  toast("Shift template deleted", "success");
  await loadShiftTemplates();
}

async function loadShiftTemplates() {
  try { const res = await authFetch(`${API}/api/shift-templates`); shiftTemplates = await res.json(); } catch (e) { shiftTemplates = []; }
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
  if (!await showConfirm({ title: "Delete Device Group", message: "Delete this group? Devices will be ungrouped.", danger: true })) return;
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
  const note = await showPrompt({ title: "Downtime Reason", label: "Optional note for this downtime event:", defaultValue: "" }) || "";
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
  if (!await showConfirm({ title: "Anonymize User", message: `Anonymize "${username}"? This replaces their username with a hash and invalidates all sessions.`, danger: true })) return;
  try {
    await authFetch(`${API}/api/gdpr/anonymize/${id}`, { method: "POST" });
    toast("User anonymized", "success");
    users = await (await authFetch(`${API}/api/users`)).json();
    render();
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function gdprDeleteUser(id, username) {
  if (!await showConfirm({ title: "Permanently Delete User", message: `PERMANENTLY DELETE all data for "${username}"? This cannot be undone.`, danger: true })) return;
  const confirm2 = await showPrompt({ title: "Confirm Deletion", label: `Type "${username}" to confirm permanent deletion:` });
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
  if (!await showConfirm({ title: "Request Data Deletion", message: "Request deletion of your account and all associated data? An admin must approve.", danger: true })) return;
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
  if (!await showConfirm({ title: "Delete SSO Provider", message: `Delete SSO provider "${name}"?`, danger: true })) return;
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
  if (!await showConfirm({ title: "Delete Batch", message: `Delete batch "${name}"?`, danger: true })) return;
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

// ============================================================
// PHASE 5: Machine Learning Pipeline — Frontend Views
// ============================================================

let mlDeviceId = "";
let mlMetric = "weight";
let anomalyResult = null;
let driftResult = null;
let forecastResult = null;

function viewMLModels() {
  return `
    <div class="top-bar">
      <div><h2>ML Models</h2><div class="subtitle">Train and manage predictive models</div></div>
      <div class="top-bar-actions">
        <button class="btn btn-primary" onclick="showNewMLModel()">+ New Model</button>
      </div>
    </div>
    <div id="ml-form-area"></div>
    <div class="form-card">
      <div class="list-header"><span style="flex:2;">Name</span><span>Type</span><span>Metric</span><span>Device</span><span>R²</span><span>MAE</span><span>Status</span><span></span></div>
      ${mlModels.length ? mlModels.map(m => {
        const device = devices.find(d => d.id === m.deviceId);
        const typeLabels = { linear_regression: "Linear Regression", moving_average: "Moving Average", holt_exponential: "Holt's Exponential" };
        return `<div class="list-row">
          <span class="list-cell" style="flex:2;font-weight:500;">${esc(m.name)}</span>
          <span class="list-cell" style="font-size:11px;">${typeLabels[m.modelType] || m.modelType}</span>
          <span class="list-cell mono">${esc(m.metric)}</span>
          <span class="list-cell">${device ? esc(device.name) : "All"}</span>
          <span class="list-cell mono">${m.r2 > 0 ? (m.r2 * 100).toFixed(1) + "%" : "—"}</span>
          <span class="list-cell mono">${m.mae > 0 ? m.mae.toFixed(3) : "—"}</span>
          <span class="list-cell"><span class="status-badge ${m.status === "trained" ? "active" : ""}">${m.status}</span></span>
          <span class="list-cell sm">
            <button class="btn btn-sm" onclick="trainMLModel('${m.id}')">Train</button>
            <button class="btn btn-sm" onclick="predictMLModel('${m.id}')">Predict</button>
            <button class="btn btn-sm btn-danger" onclick="deleteMLModel('${m.id}')">✕</button>
          </span>
        </div>`;
      }).join("") : `<div class="empty">No ML models. Create one to start forecasting.</div>`}
    </div>`;
}

function showNewMLModel() {
  document.getElementById("ml-form-area").innerHTML = `
    <div class="form-card" style="margin-bottom:16px;">
      <div class="section-label mono" style="margin-bottom:10px;">New ML Model</div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr 1fr auto;">
        <div><label>Name</label><input id="ml-name" placeholder="Weight Forecaster" /></div>
        <div><label>Metric</label><select id="ml-metric"><option value="weight">Weight</option><option value="temperature">Temperature</option><option value="flow">Flow</option><option value="pressure">Pressure</option></select></div>
        <div><label>Device (optional)</label><select id="ml-device"><option value="">All devices</option>${devices.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}</select></div>
        <div><label>Type</label><select id="ml-type"><option value="linear_regression">Linear Regression</option><option value="moving_average">Moving Average</option><option value="holt_exponential">Holt's Exponential</option></select></div>
        <div style="display:flex;align-items:end;"><button class="btn btn-primary" onclick="createMLModel()">Create</button></div>
      </div>
    </div>`;
}

async function createMLModel() {
  const name = document.getElementById("ml-name").value || "Model";
  const metric = document.getElementById("ml-metric").value;
  const deviceId = document.getElementById("ml-device").value || null;
  const modelType = document.getElementById("ml-type").value;
  await authFetch(`${API}/api/ml-models`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, metric, deviceId, modelType }) });
  toast("Model created", "success");
  await loadMLModels();
  render();
}

async function trainMLModel(id) {
  toast("Training model...", "info");
  const res = await authFetch(`${API}/api/ml-models/${id}/train`, { method: "POST" });
  const data = await res.json();
  if (data.error) { toast(data.error, "error"); return; }
  toast(`Model trained — R²: ${(data.r2 * 100).toFixed(1)}%, MAE: ${data.mae.toFixed(3)}`, "success");
  await loadMLModels();
  render();
}

async function predictMLModel(id) {
  const res = await authFetch(`${API}/api/ml-models/${id}/predict`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ horizonHours: 24 }) });
  const data = await res.json();
  if (data.error) { toast(data.error, "error"); return; }
  toast(`Prediction: ${data.predictedValue} (${(data.confidence * 100).toFixed(0)}% confidence)`, "success");
}

async function deleteMLModel(id) {
  if (!await showConfirm({ title: "Delete ML Model", message: "Delete this model?", danger: true })) return;
  await authFetch(`${API}/api/ml-models/${id}`, { method: "DELETE" });
  toast("Model deleted", "success");
  await loadMLModels();
  render();
}

async function loadMLModels() {
  try { const res = await authFetch(`${API}/api/ml-models`); mlModels = await res.json(); } catch (e) { mlModels = []; }
}

// --- Anomaly / Drift / Forecast Dashboard ---

function viewMLAnalysis() {
  return `
    <div class="top-bar">
      <div><h2>ML Analysis</h2><div class="subtitle">Anomaly detection, drift analysis, forecasting</div></div>
    </div>
    <div class="form-card" style="margin-bottom:16px;">
      <div class="form-grid" style="grid-template-columns:1fr 1fr auto auto auto;">
        <div><label>Device</label><select id="mla-device" onchange="mlDeviceId=this.value">${devices.map(d => `<option value="${d.id}" ${d.id === mlDeviceId ? "selected" : ""}>${esc(d.name)}</option>`).join("")}</select></div>
        <div><label>Metric</label><select id="mla-metric" onchange="mlMetric=this.value"><option value="weight">Weight</option><option value="temperature">Temperature</option><option value="flow">Flow</option><option value="pressure">Pressure</option></select></div>
        <button class="btn btn-primary" onclick="runAnomalyDetection()">Detect Anomalies</button>
        <button class="btn btn-primary" onclick="runDriftDetection()">Detect Drift</button>
        <button class="btn btn-primary" onclick="runForecast()">Forecast</button>
      </div>
    </div>
    <div id="mla-results">
      ${anomalyResult ? renderAnomalyResult() : ""}
      ${driftResult ? renderDriftResult() : ""}
      ${forecastResult ? renderForecastResult() : ""}
      ${!anomalyResult && !driftResult && !forecastResult ? '<div class="form-card" style="text-align:center;padding:30px;color:var(--muted);">Select a device and metric, then run an analysis.</div>' : ""}
    </div>`;
}

async function runAnomalyDetection() {
  const deviceId = document.getElementById("mla-device")?.value || mlDeviceId || devices[0]?.id;
  const metric = document.getElementById("mla-metric")?.value || mlMetric;
  if (!deviceId || !metric) return toast("Select device and metric", "error");
  const res = await authFetch(`${API}/api/devices/${deviceId}/anomalies?metric=${metric}`);
  anomalyResult = await res.json();
  driftResult = null;
  forecastResult = null;
  render();
}

function renderAnomalyResult() {
  if (!anomalyResult || anomalyResult.message) return `<div class="form-card" style="padding:16px;color:var(--muted);">${anomalyResult?.message || "No data"}</div>`;
  return `<div class="form-card">
    <div class="section-label mono" style="margin-bottom:12px;">Anomaly Detection — ${esc(anomalyResult.metric)}</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;">
      <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Mean</span><span class="kv-value mono">${anomalyResult.mean}</span></div>
      <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Std Dev</span><span class="kv-value mono">${anomalyResult.stdDev}</span></div>
      <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Anomalies</span><span class="kv-value mono" style="color:${anomalyResult.anomalies.length > 0 ? "#E5484D" : "#27ae60"};">${anomalyResult.anomalies.length}</span></div>
      <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Anomaly Rate</span><span class="kv-value mono">${anomalyResult.anomalyRate}%</span></div>
    </div>
    ${anomalyResult.anomalies.length ? `<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">Detected anomalies:</div>
    ${anomalyResult.anomalies.map(a => `<div class="list-row" style="border-left:3px solid ${a.type === "extreme" ? "#E5484D" : "#F2B705"};">
      <span class="list-cell mono">${a.value}</span>
      <span class="list-cell" style="font-size:11px;">Z-score: ${a.zScore} (${a.type})</span>
      <span class="list-cell" style="font-size:11px;color:var(--muted);">${new Date(a.timestamp).toLocaleString()}</span>
    </div>`).join("")}` : '<div style="font-size:12px;color:#27ae60;">No anomalies detected.</div>'}
    <div style="margin-top:12px;font-size:11px;color:var(--muted);">IQR: Q1=${anomalyResult.iqr.q1}, Q3=${anomalyResult.iqr.q3}, IQR=${anomalyResult.iqr.iqr}, Outliers=${anomalyResult.iqr.outlierCount}</div>
  </div>`;
}

async function runDriftDetection() {
  const deviceId = document.getElementById("mla-device")?.value || mlDeviceId || devices[0]?.id;
  const metric = document.getElementById("mla-metric")?.value || mlMetric;
  if (!deviceId || !metric) return toast("Select device and metric", "error");
  const res = await authFetch(`${API}/api/devices/${deviceId}/drift?metric=${metric}`);
  driftResult = await res.json();
  anomalyResult = null;
  forecastResult = null;
  render();
}

function renderDriftResult() {
  if (!driftResult || driftResult.message) return `<div class="form-card" style="padding:16px;color:var(--muted);">${driftResult?.message || "No data"}</div>`;
  const d = driftResult;
  return `<div class="form-card">
    <div class="section-label mono" style="margin-bottom:12px;">Drift Detection — ${esc(d.metric)}</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:16px;">
      <div class="form-card" style="text-align:center;padding:12px;">
        <div style="font-size:11px;color:var(--muted);">CUSUM</div>
        <div style="font-size:20px;font-weight:600;color:${d.cusum.detected ? "#E5484D" : "#27ae60"};">${d.cusum.detected ? "DRIFT" : "Stable"}</div>
        <div style="font-size:11px;color:var(--muted);">Max: ${d.cusum.maxCusumPos}</div>
      </div>
      <div class="form-card" style="text-align:center;padding:12px;">
        <div style="font-size:11px;color:var(--muted);">EWMA</div>
        <div style="font-size:20px;font-weight:600;color:${d.ewma.breaches > 0 ? "#F2B705" : "#27ae60"};">${d.ewma.breaches > 0 ? d.ewma.breaches + " breaches" : "In control"}</div>
        <div style="font-size:11px;color:var(--muted);">UCL: ${d.ewma.ucl}, LCL: ${d.ewma.lcl}</div>
      </div>
      <div class="form-card" style="text-align:center;padding:12px;">
        <div style="font-size:11px;color:var(--muted);">Trend</div>
        <div style="font-size:20px;font-weight:600;color:${d.trend.direction === "stable" ? "#27ae60" : "#F2B705"};">${d.trend.direction}</div>
        <div style="font-size:11px;color:var(--muted);">Slope: ${d.trend.slope}</div>
      </div>
    </div>
    <div class="kv-row"><span class="kv-label">Baseline Mean</span><span class="kv-value mono">${d.baseline.mean}</span></div>
    <div class="kv-row"><span class="kv-label">Old Mean</span><span class="kv-value mono">${d.comparison.oldMean}</span></div>
    <div class="kv-row"><span class="kv-label">Recent Mean</span><span class="kv-value mono">${d.comparison.recentMean}</span></div>
    <div class="kv-row"><span class="kv-label">Shift</span><span class="kv-value mono" style="color:${Math.abs(d.comparison.percentShift) > 2 ? "#E5484D" : "#F2B705"};">${d.comparison.percentShift > 0 ? "+" : ""}${d.comparison.percentShift}%</span></div>
  </div>`;
}

async function runForecast() {
  const deviceId = document.getElementById("mla-device")?.value || mlDeviceId || devices[0]?.id;
  const metric = document.getElementById("mla-metric")?.value || mlMetric;
  if (!deviceId || !metric) return toast("Select device and metric", "error");
  const res = await authFetch(`${API}/api/devices/${deviceId}/forecast?metric=${metric}&horizonHours=24`);
  forecastResult = await res.json();
  anomalyResult = null;
  driftResult = null;
  render();
}

function renderForecastResult() {
  if (!forecastResult || forecastResult.message) return `<div class="form-card" style="padding:16px;color:var(--muted);">${forecastResult?.message || "No data"}</div>`;
  const f = forecastResult;
  return `<div class="form-card">
    <div class="section-label mono" style="margin-bottom:12px;">Forecast — ${esc(f.metric)} (24h)</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px;">
      <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Current</span><span class="kv-value mono">${f.stats.mean}</span></div>
      <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Trend</span><span class="kv-value mono" style="color:${f.trend.direction === "up" ? "#F2B705" : f.trend.direction === "down" ? "#3B82F6" : "#27ae60"};">${f.trend.direction} (${f.trend.slope > 0 ? "+" : ""}${f.trend.slope})</span></div>
      <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Model R²</span><span class="kv-value mono">${(f.stats.r2 * 100).toFixed(1)}%</span></div>
    </div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">Predictions:</div>
    <div class="list" style="display:flex;flex-direction:column;gap:4px;">
      <div class="list-row header" style="font-size:11px;">
        <span class="list-cell">Time</span>
        <span class="list-cell">Hours</span>
        <span class="list-cell">MA</span>
        <span class="list-cell">Linear</span>
        <span class="list-cell">Holt</span>
        <span class="list-cell" style="font-weight:600;">Combined</span>
        <span class="list-cell">Range</span>
      </div>
      ${f.forecast.slice(0, 8).map(p => `<div class="list-row" style="font-size:12px;">
        <span class="list-cell" style="font-size:11px;">${new Date(p.timestamp).toLocaleTimeString()}</span>
        <span class="list-cell mono">+${p.hoursAhead}h</span>
        <span class="list-cell mono">${p.movingAverage}</span>
        <span class="list-cell mono">${p.linearTrend}</span>
        <span class="list-cell mono">${p.holtExponential}</span>
        <span class="list-cell mono" style="font-weight:600;">${p.combined}</span>
        <span class="list-cell" style="font-size:10px;color:var(--muted);">${p.lowerBound} – ${p.upperBound}</span>
      </div>`).join("")}
    </div>
  </div>`;
}

async function loadMLPredictions() {
  try { const res = await authFetch(`${API}/api/ml-predictions`); mlPredictions = await res.json(); } catch (e) { mlPredictions = []; }
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
  if (!await showConfirm({ title: "Delete Organization", message: `Delete organization "${name}"? Users and devices will be unlinked.`, danger: true })) return;
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
  if (!await showConfirm({ title: "Delete Report Template", message: `Delete template "${name}"?`, danger: true })) return;
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
  if (!await showConfirm({ title: "Delete Integration", message: `Delete integration "${name}"?`, danger: true })) return;
  try {
    await authFetch(`${API}/api/integrations/${id}`, { method: "DELETE" });
    integrations = await (await authFetch(`${API}/api/integrations`)).json();
    render();
    toast("Integration deleted", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

// ============================================================
// PHASE 7: Integrations + Enterprise — Frontend Views
// ============================================================

let integrationMappings = [];
let webhookConfigs = [];

async function loadIntegrationMappings() {
  try { const res = await authFetch(`${API}/api/integration-mappings`); integrationMappings = await res.json(); } catch (e) { integrationMappings = []; }
}

async function loadWebhookConfigs() {
  try { const res = await authFetch(`${API}/api/webhook-configs`); webhookConfigs = await res.json(); } catch (e) { webhookConfigs = []; }
}

function viewIntegrationMappings() {
  return `
    <div class="top-bar">
      <div><h2>Integration Mappings</h2><div class="subtitle">Map platform fields to external systems</div></div>
      <div class="top-bar-actions">
        <button class="btn" onclick="currentView='integrations';render();">Back</button>
        ${hasRole("admin") ? `<button class="btn btn-primary" onclick="showNewMapping()">+ New Mapping</button>` : ""}
      </div>
    </div>
    <div id="mapping-form-area"></div>
    <div class="form-card">
      <div class="list-header"><span style="flex:2;">Integration</span><span>Entity Type</span><span>Fields</span><span>Status</span><span></span></div>
      ${integrationMappings.length ? integrationMappings.map(m => {
        const intg = integrations.find(i => i.id === m.integrationId);
        const fields = Object.keys(m.fieldMapping || {}).length;
        return `<div class="list-row">
          <span class="list-cell" style="flex:2;">${intg ? esc(intg.name) : m.integrationId}</span>
          <span class="list-cell mono">${esc(m.entityType)}</span>
          <span class="list-cell">${fields} field${fields !== 1 ? "s" : ""}</span>
          <span class="list-cell"><span class="status-badge ${m.enabled ? "active" : "inactive"}">${m.enabled ? "Active" : "Disabled"}</span></span>
          <span class="list-cell sm">${hasRole("admin") ? `<button class="btn btn-sm btn-danger" onclick="deleteMapping('${m.id}')">✕</button>` : ""}</span>
        </div>`;
      }).join("") : `<div class="empty">No integration mappings configured.</div>`}
    </div>`;
}

function showNewMapping() {
  document.getElementById("mapping-form-area").innerHTML = `
    <div class="form-card" style="margin-bottom:16px;">
      <div class="section-label mono" style="margin-bottom:10px;">New Integration Mapping</div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr auto;">
        <div><label>Integration</label><select id="map-int">${integrations.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join("")}</select></div>
        <div><label>Entity Type</label><select id="map-entity"><option value="device">Device</option><option value="reading">Reading</option><option value="telemetry">Telemetry</option><option value="alert">Alert</option><option value="maintenance">Maintenance</option><option value="production_order">Production Order</option></select></div>
        <div><label>Field Mapping (JSON)</label><input id="map-fields" placeholder='{"name": "device_name", "value": "reading_value"}' /></div>
        <div style="display:flex;align-items:end;"><button class="btn btn-primary" onclick="createMapping()">Create</button></div>
      </div>
    </div>`;
}

async function createMapping() {
  const integrationId = document.getElementById("map-int").value;
  const entityType = document.getElementById("map-entity").value;
  let fieldMapping = {};
  try { fieldMapping = JSON.parse(document.getElementById("map-fields").value || "{}"); } catch (e) { toast("Invalid JSON", "error"); return; }
  await authFetch(`${API}/api/integration-mappings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ integrationId, entityType, fieldMapping }) });
  toast("Mapping created", "success");
  await loadIntegrationMappings();
  render();
}

async function deleteMapping(id) {
  if (!await showConfirm({ title: "Delete Mapping", message: "Delete this mapping?", danger: true })) return;
  await authFetch(`${API}/api/integration-mappings/${id}`, { method: "DELETE" });
  toast("Mapping deleted", "success");
  await loadIntegrationMappings();
  render();
}

function viewWebhookConfigs() {
  return `
    <div class="top-bar">
      <div><h2>Webhook Configurations</h2><div class="subtitle">Advanced webhook settings with retry and signing</div></div>
      <div class="top-bar-actions">
        <button class="btn" onclick="currentView='integrations';render();">Back</button>
        ${hasRole("admin") ? `<button class="btn btn-primary" onclick="showNewWebhook()">+ New Webhook</button>` : ""}
      </div>
    </div>
    <div id="wh-form-area"></div>
    <div class="form-card">
      <div class="list-header"><span style="flex:2;">URL</span><span>Events</span><span>Retries</span><span>Status</span><span></span></div>
      ${webhookConfigs.length ? webhookConfigs.map(w => `<div class="list-row">
        <span class="list-cell" style="flex:2;font-size:12px;word-break:break-all;">${esc(w.url)}</span>
        <span class="list-cell mono" style="font-size:11px;">${Array.isArray(w.events) ? w.events.join(", ") : w.events}</span>
        <span class="list-cell">${w.retryCount}x / ${w.retryDelayMs}ms</span>
        <span class="list-cell"><span class="status-badge ${w.enabled ? "active" : "inactive"}">${w.enabled ? "Active" : "Disabled"}</span></span>
        <span class="list-cell sm">
          <button class="btn btn-sm" onclick="testWebhook('${w.id}')">Test</button>
          ${hasRole("admin") ? `<button class="btn btn-sm btn-danger" onclick="deleteWebhook('${w.id}')">✕</button>` : ""}
        </span>
      </div>`).join("") : `<div class="empty">No webhook configurations.</div>`}
    </div>`;
}

function showNewWebhook() {
  document.getElementById("wh-form-area").innerHTML = `
    <div class="form-card" style="margin-bottom:16px;">
      <div class="section-label mono" style="margin-bottom:10px;">New Webhook</div>
      <div class="form-grid" style="grid-template-columns:2fr 1fr 1fr 1fr auto;">
        <div><label>URL *</label><input id="wh-url" placeholder="https://api.example.com/webhook" /></div>
        <div><label>Secret (for signing)</label><input id="wh-secret" type="password" placeholder="optional" /></div>
        <div><label>Events</label><input id="wh-events" placeholder="* or comma-separated" value="*" /></div>
        <div><label>Retries</label><input id="wh-retries" type="number" value="3" /></div>
        <div style="display:flex;align-items:end;"><button class="btn btn-primary" onclick="createWebhook()">Create</button></div>
      </div>
    </div>`;
}

async function createWebhook() {
  const url = document.getElementById("wh-url").value;
  const secret = document.getElementById("wh-secret").value || null;
  const events = document.getElementById("wh-events").value.split(",").map(e => e.trim());
  const retryCount = parseInt(document.getElementById("wh-retries").value) || 3;
  if (!url) { toast("URL required", "error"); return; }
  await authFetch(`${API}/api/webhook-configs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, secret, events, retryCount }) });
  toast("Webhook created", "success");
  await loadWebhookConfigs();
  render();
}

async function testWebhook(id) {
  toast("Testing webhook...", "info");
  const res = await authFetch(`${API}/api/webhook-configs/${id}/test`, { method: "POST" });
  const data = await res.json();
  toast(`Webhook ${data.success ? "succeeded" : "failed"}: ${data.error || data.statusCode || "OK"}`, data.success ? "success" : "error");
}

async function deleteWebhook(id) {
  if (!await showConfirm({ title: "Delete Webhook", message: "Delete this webhook?", danger: true })) return;
  await authFetch(`${API}/api/webhook-configs/${id}`, { method: "DELETE" });
  toast("Webhook deleted", "success");
  await loadWebhookConfigs();
  render();
}

// --- Data Export/Import Views ---

function viewDataExport() {
  const exportTypes = [
    { id: "readings", label: "Readings", desc: "Historical weight readings" },
    { id: "telemetry", label: "Telemetry", desc: "All telemetry data" },
    { id: "alerts", label: "Alerts", desc: "Alert history" },
    { id: "maintenance", label: "Maintenance", desc: "Maintenance records" },
    { id: "production", label: "Production", desc: "Production orders" },
    { id: "devices", label: "Devices", desc: "Device configurations" },
  ];
  return `
    <div class="top-bar">
      <div><h2>Data Export</h2><div class="subtitle">Export platform data as CSV or JSON</div></div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;">
      ${exportTypes.map(t => `<div class="form-card" style="cursor:pointer;" onclick="exportData('${t.id}')">
        <div style="font-weight:600;font-size:16px;margin-bottom:4px;">${t.label}</div>
        <div style="font-size:12px;color:var(--muted);">${t.desc}</div>
        <div style="margin-top:12px;display:flex;gap:8px;">
          <button class="btn btn-sm" onclick="event.stopPropagation();exportData('${t.id}','csv')">CSV</button>
          <button class="btn btn-sm" onclick="event.stopPropagation();exportData('${t.id}','json')">JSON</button>
        </div>
      </div>`).join("")}
    </div>`;
}

async function exportData(exportType, format = "csv") {
  toast(`Exporting ${exportType}...`, "info");
  try {
    const res = await authFetch(`${API}/api/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exportType, format: format || "csv" }) });
    if (format === "json") {
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `export_${exportType}.json`; a.click();
      toast(`Exported ${data.count} records`, "success");
    } else {
      const text = await res.text();
      const blob = new Blob([text], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `export_${exportType}.csv`; a.click();
      const count = text.split("\n").length - 1;
      toast(`Exported ${count} records`, "success");
    }
  } catch (e) { toast("Export failed: " + e.message, "error"); }
}

function viewDataImport() {
  return `
    <div class="top-bar">
      <div><h2>Data Import</h2><div class="subtitle">Import data from CSV/JSON</div></div>
    </div>
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">Import Data</div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr auto;">
        <div><label>Type</label><select id="imp-type"><option value="devices">Devices</option><option value="products">Products</option><option value="telemetry">Telemetry</option></select></div>
        <div><label>Data (JSON array)</label><input id="imp-data" placeholder='[{"name":"Scale-1","protocol":"tcp"}]' style="width:100%;" /></div>
        <div style="display:flex;align-items:end;gap:8px;">
          <button class="btn" onclick="validateImport()">Validate</button>
          <button class="btn btn-primary" onclick="executeImport()">Import</button>
        </div>
      </div>
      <div id="import-result" style="margin-top:12px;"></div>
    </div>`;
}

async function validateImport() {
  const importType = document.getElementById("imp-type").value;
  let data;
  try { data = JSON.parse(document.getElementById("imp-data").value); } catch (e) { toast("Invalid JSON", "error"); return; }
  if (!Array.isArray(data)) { toast("Data must be an array", "error"); return; }
  const res = await authFetch(`${API}/api/import/validate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ importType, data }) });
  const result = await res.json();
  document.getElementById("import-result").innerHTML = `<div style="padding:12px;background:#1B2129;border-radius:6px;font-size:12px;">
    <div>Total: ${result.total} | Valid: <span style="color:#27ae60;">${result.valid}</span> | Errors: <span style="color:#E5484D;">${result.errors}</span></div>
    ${result.validationErrors?.length ? `<div style="margin-top:8px;color:#E5484D;">${result.validationErrors.slice(0, 5).map(e => `Row ${e.row}: ${e.errors.join(", ")}`).join("<br/>")}</div>` : ""}
  </div>`;
}

async function executeImport() {
  const importType = document.getElementById("imp-type").value;
  let data;
  try { data = JSON.parse(document.getElementById("imp-data").value); } catch (e) { toast("Invalid JSON", "error"); return; }
  if (!Array.isArray(data)) { toast("Data must be an array", "error"); return; }
  // First validate
  const valRes = await authFetch(`${API}/api/import/validate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ importType, data }) });
  const val = await valRes.json();
  if (val.errors > 0 && !await showConfirm(`${val.errors} rows have errors. Continue with valid rows?`)) return;

  const res = await authFetch(`${API}/api/import/execute`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: val.jobId, data }) });
  const result = await res.json();
  document.getElementById("import-result").innerHTML = `<div style="padding:12px;background:#1B2129;border-radius:6px;font-size:12px;">
    <div>Processed: <span style="color:#27ae60;">${result.processed}</span> | Errors: <span style="color:#E5484D;">${result.errors}</span></div>
    ${result.errors?.length ? `<div style="margin-top:8px;color:#E5484D;">${result.errors.slice(0, 5).map(e => `Row ${e.row}: ${e.error}`).join("<br/>")}</div>` : ""}
  </div>`;
  toast(`Import complete: ${result.processed} processed`, "success");
}

// --- API Discovery View ---

async function viewAPIDiscovery() {
  const res = await authFetch(`${API}/api/discovery`);
  const api = await res.json();
  return `
    <div class="top-bar">
      <div><h2>API Discovery</h2><div class="subtitle">${api.name} v${api.version}</div></div>
    </div>
    <div class="form-card" style="margin-bottom:16px;">
      <div style="font-size:13px;color:var(--muted);margin-bottom:8px;">${esc(api.description)}</div>
      <div class="kv-row"><span class="kv-label">Base URL</span><span class="kv-value mono">${api.baseUrl}</span></div>
      <div class="kv-row"><span class="kv-label">Auth</span><span class="kv-value">${api.authentication.type}</span></div>
    </div>
    <div class="form-card">
      <div class="section-label mono" style="margin-bottom:10px;">Endpoints (${api.modules.length})</div>
      <div class="list" style="display:flex;flex-direction:column;gap:4px;">
        ${api.modules.map(m => `<div class="list-row">
          <span class="list-cell" style="flex:2;font-weight:500;">${esc(m.name)}</span>
          <span class="list-cell mono" style="font-size:11px;">${api.baseUrl}${m.path}</span>
          <span class="list-cell" style="font-size:11px;">${m.methods.join(", ")}</span>
          <span class="list-cell" style="font-size:11px;color:var(--muted);">${esc(m.description)}</span>
        </div>`).join("")}
      </div>
    </div>`;
}

// ============================================================
// PHASE 8: Advanced Analytics & Deployment
// ============================================================

let analyticsData = null;
let analyticsTimeRange = "24h";

function viewAdvancedAnalytics() {
  return `
    <div class="top-bar">
      <div><h2>Advanced Analytics</h2><div class="subtitle">Real-time insights and trends</div></div>
      <div class="top-bar-actions">
        <select onchange="analyticsTimeRange=this.value;loadAnalytics()" style="padding:6px 10px;border-radius:6px;background:#1B2129;color:#E8EAED;border:1px solid #2A333D;">
          <option value="1h">Last Hour</option>
          <option value="24h" selected>Last 24 Hours</option>
          <option value="7d">Last 7 Days</option>
          <option value="30d">Last 30 Days</option>
        </select>
        <button class="btn btn-primary" onclick="loadAnalytics()">Refresh</button>
      </div>
    </div>
    <div id="analytics-content">
      ${analyticsData ? renderAnalytics() : '<div style="text-align:center;padding:40px;color:var(--muted);">Click Refresh to load analytics.</div>'}
    </div>`;
}

function renderAnalytics() {
  if (!analyticsData) return "";
  const a = analyticsData;
  return `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:20px;">
      <div class="form-card" style="text-align:center;border-left:3px solid #3B82F6;">
        <div style="font-size:28px;font-weight:700;color:#3B82F6;">${a.totalDevices}</div>
        <div style="font-size:11px;color:var(--muted);">Total Devices</div>
      </div>
      <div class="form-card" style="text-align:center;border-left:3px solid #27ae60;">
        <div style="font-size:28px;font-weight:700;color:#27ae60;">${a.onlineDevices}</div>
        <div style="font-size:11px;color:var(--muted);">Online</div>
      </div>
      <div class="form-card" style="text-align:center;border-left:3px solid #E5484D;">
        <div style="font-size:28px;font-weight:700;color:#E5484D;">${a.criticalAlerts}</div>
        <div style="font-size:11px;color:var(--muted);">Critical Alerts</div>
      </div>
      <div class="form-card" style="text-align:center;border-left:3px solid #F2B705;">
        <div style="font-size:28px;font-weight:700;color:#F2B705;">${a.avgHealthScore}%</div>
        <div style="font-size:11px;color:var(--muted);">Avg Health</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:20px;">
      <div class="form-card">
        <div class="section-label mono" style="margin-bottom:12px;">Telemetry Volume</div>
        <canvas id="analytics-telemetry-chart" height="200"></canvas>
      </div>
      <div class="form-card">
        <div class="section-label mono" style="margin-bottom:12px;">Device Status Distribution</div>
        <canvas id="analytics-status-chart" height="200"></canvas>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;">
      <div class="form-card">
        <div class="section-label mono" style="margin-bottom:12px;">Top Alerts</div>
        ${a.topAlerts.length ? a.topAlerts.map(al => `<div class="list-row" style="font-size:12px;">
          <span class="list-cell" style="flex:1;">${esc(al.type)}</span>
          <span class="list-cell mono">${al.count}x</span>
        </div>`).join("") : '<div style="color:var(--muted);font-size:12px;">No alerts</div>'}
      </div>
      <div class="form-card">
        <div class="section-label mono" style="margin-bottom:12px;">Maintenance Summary</div>
        <div class="kv-row"><span class="kv-label">Scheduled</span><span class="kv-value">${a.maintenanceScheduled}</span></div>
        <div class="kv-row"><span class="kv-label">In Progress</span><span class="kv-value">${a.maintenanceInProgress}</span></div>
        <div class="kv-row"><span class="kv-label">Completed</span><span class="kv-value" style="color:#27ae60;">${a.maintenanceCompleted}</span></div>
        <div class="kv-row"><span class="kv-label">Total Cost</span><span class="kv-value" style="color:#F2B705;">$${a.totalMaintenanceCost.toFixed(2)}</span></div>
      </div>
      <div class="form-card">
        <div class="section-label mono" style="margin-bottom:12px;">Production Overview</div>
        <div class="kv-row"><span class="kv-label">Active Orders</span><span class="kv-value">${a.activeOrders}</span></div>
        <div class="kv-row"><span class="kv-label">Completed</span><span class="kv-value" style="color:#27ae60;">${a.completedOrders}</span></div>
        <div class="kv-row"><span class="kv-label">Total Output</span><span class="kv-value">${a.totalOutput} units</span></div>
        <div class="kv-row"><span class="kv-label">Quality Rate</span><span class="kv-value" style="color:${a.qualityRate >= 95 ? "#27ae60" : "#F2B705"};">${a.qualityRate.toFixed(1)}%</span></div>
      </div>
    </div>`;
}

async function loadAnalytics() {
  toast("Loading analytics...", "info");
  try {
    const from = analyticsTimeRange === "1h" ? new Date(Date.now() - 3600000).toISOString() :
                 analyticsTimeRange === "24h" ? new Date(Date.now() - 86400000).toISOString() :
                 analyticsTimeRange === "7d" ? new Date(Date.now() - 7 * 86400000).toISOString() :
                 new Date(Date.now() - 30 * 86400000).toISOString();

    const [healthRes, alertRes, maintRes, prodRes, telemRes] = await Promise.all([
      authFetch(`${API}/api/device-health`),
      authFetch(`${API}/api/alerts`),
      authFetch(`${API}/api/maintenance`),
      authFetch(`${API}/api/production-orders`),
      authFetch(`${API}/api/telemetry?from=${from}`),
    ]);

    const health = await healthRes.json();
    const alertData = await alertRes.json();
    const maintenance = await maintRes.json();
    const production = await prodRes.json();

    // Aggregate alert types
    const alertTypes = {};
    (alertData.active || []).forEach(a => { alertTypes[a.type] = (alertTypes[a.type] || 0) + 1; });
    const topAlerts = Object.entries(alertTypes).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([type, count]) => ({ type, count }));

    // Maintenance stats
    const maintScheduled = maintenance.filter(m => m.status === "SCHEDULED").length;
    const maintInProgress = maintenance.filter(m => m.status === "IN_PROGRESS").length;
    const maintCompleted = maintenance.filter(m => m.status === "COMPLETED").length;
    const totalMaintCost = maintenance.filter(m => m.status === "COMPLETED").reduce((s, m) => s + (m.totalCost || 0), 0);

    // Production stats
    const activeOrders = production.filter(o => o.status === "in_progress").length;
    const completedOrders = production.filter(o => o.status === "completed").length;
    const totalOutput = production.reduce((s, o) => s + (o.actualQuantity || 0), 0);
    const goodOutput = production.reduce((s, o) => s + (o.goodQuantity || 0), 0);
    const qualityRate = totalOutput > 0 ? (goodOutput / totalOutput) * 100 : 100;

    analyticsData = {
      totalDevices: health.length,
      onlineDevices: health.filter(h => h.status === "healthy").length,
      criticalAlerts: (alertData.active || []).filter(a => a.severity === "critical").length,
      avgHealthScore: health.length ? Math.round(health.reduce((s, h) => s + h.healthScore, 0) / health.length) : 0,
      topAlerts,
      maintenanceScheduled: maintScheduled,
      maintenanceInProgress: maintInProgress,
      maintenanceCompleted: maintCompleted,
      totalMaintenanceCost: totalMaintCost,
      activeOrders,
      completedOrders,
      totalOutput,
      qualityRate,
    };

    render();
    setTimeout(renderAnalyticsCharts, 100);
  } catch (e) { toast("Failed to load analytics: " + e.message, "error"); }
}

function renderAnalyticsCharts() {
  if (!analyticsData) return;

  // Telemetry volume chart (placeholder with mock hourly data)
  const telemEl = document.getElementById("analytics-telemetry-chart");
  if (telemEl && typeof Chart !== "undefined") {
    const hours = Array.from({ length: 24 }, (_, i) => `${i}:00`);
    const volumes = hours.map(() => Math.floor(Math.random() * 500 + 100));
    new Chart(telemEl, {
      type: "bar",
      data: {
        labels: hours,
        datasets: [{ label: "Data Points", data: volumes, backgroundColor: "rgba(59,130,246,0.5)", borderColor: "#3B82F6", borderWidth: 1 }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: "#5B6673", maxTicksLimit: 12 }, grid: { display: false } }, y: { ticks: { color: "#5B6673" }, grid: { color: "#1B2129" } } } },
    });
  }

  // Status distribution chart
  const statusEl = document.getElementById("analytics-status-chart");
  if (statusEl && typeof Chart !== "undefined") {
    const a = analyticsData;
    new Chart(statusEl, {
      type: "doughnut",
      data: {
        labels: ["Healthy", "Warning", "Critical", "Offline"],
        datasets: [{ data: [a.onlineDevices, Math.floor(a.totalDevices * 0.2), a.criticalAlerts, Math.max(0, a.totalDevices - a.onlineDevices - a.criticalAlerts - Math.floor(a.totalDevices * 0.2))], backgroundColor: ["#27ae60", "#F2B705", "#E5484D", "#5B6673"], borderWidth: 0 }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { color: "#8B95A1", font: { size: 11 } } } } },
    });
  }
}

// --- Session Management View ---

function viewSessions() {
  return `
    <div class="top-bar">
      <div><h2>Session Management</h2><div class="subtitle">Active user sessions</div></div>
      <div class="top-bar-actions">
        <button class="btn btn-danger" onclick="revokeAllSessions()">Revoke All Other Sessions</button>
      </div>
    </div>
    <div class="form-card">
      <div style="font-size:12px;color:var(--muted);margin-bottom:12px;">Your active sessions are managed automatically. Revoke all other sessions to force re-authentication.</div>
      <div class="kv-row"><span class="kv-label">Current Session</span><span class="kv-value" style="color:#27ae60;">Active</span></div>
      <div class="kv-row"><span class="kv-label">Last Login</span><span class="kv-value">${currentUser?.lastLogin ? new Date(currentUser.lastLogin).toLocaleString() : "Unknown"}</span></div>
      <div class="kv-row"><span class="kv-label">Role</span><span class="kv-value">${currentUser?.role || "Unknown"}</span></div>
    </div>`;
}

async function revokeAllSessions() {
  if (!await showConfirm({ title: "Revoke Sessions", message: "This will sign out all other sessions. Continue?", danger: true })) return;
  try {
    await authFetch(`${API}/api/auth/revoke-sessions`, { method: "POST" });
    toast("Other sessions revoked", "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

// --- System Health View ---

async function viewSystemHealth() {
  const res = await authFetch(`${API}/api/health`);
  const health = await res.json();
  return `
    <div class="top-bar">
      <div><h2>System Health</h2><div class="subtitle">Platform status and diagnostics</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div class="form-card">
        <div class="section-label mono" style="margin-bottom:12px;">Database</div>
        <div class="kv-row"><span class="kv-label">Status</span><span class="kv-value" style="color:${health.database === "connected" ? "#27ae60" : "#E5484D"};">${health.database}</span></div>
        <div class="kv-row"><span class="kv-label">Pool Total</span><span class="kv-value">${health.poolTotal || "N/A"}</span></div>
        <div class="kv-row"><span class="kv-label">Pool Idle</span><span class="kv-value">${health.poolIdle || "N/A"}</span></div>
      </div>
      <div class="form-card">
        <div class="section-label mono" style="margin-bottom:12px;">System</div>
        <div class="kv-row"><span class="kv-label">Uptime</span><span class="kv-value">${health.uptime ? Math.floor(health.uptime / 3600) + "h " + Math.floor((health.uptime % 3600) / 60) + "m" : "N/A"}</span></div>
        <div class="kv-row"><span class="kv-label">Memory Used</span><span class="kv-value">${health.memoryUsed || "N/A"}</span></div>
        <div class="kv-row"><span class="kv-label">Memory Total</span><span class="kv-value">${health.memoryTotal || "N/A"}</span></div>
        <div class="kv-row"><span class="kv-label">Node.js</span><span class="kv-value">${health.nodeVersion || "N/A"}</span></div>
      </div>
    </div>
    <div class="form-card" style="margin-top:16px;">
      <div class="section-label mono" style="margin-bottom:12px;">Platform Summary</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;">
        <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Devices</span><span class="kv-value">${health.deviceCount || 0}</span></div>
        <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Users</span><span class="kv-value">${health.userCount || 0}</span></div>
        <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Readings Today</span><span class="kv-value">${health.readingsToday || 0}</span></div>
        <div class="kv-row" style="flex-direction:column;"><span class="kv-label">Active Alerts</span><span class="kv-value">${health.activeAlerts || 0}</span></div>
      </div>
    </div>`;
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

// ---------- Hierarchy View ----------

let hierarchyData = [];

async function loadHierarchy() {
  try {
    const res = await fetch(`${API}/api/hierarchy`, { headers: authHeaders() });
    if (res.ok) hierarchyData = await res.json();
  } catch {}
}

function viewHierarchy() {
  loadHierarchy();
  const tree = hierarchyData.length > 0
    ? hierarchyData.map(site => `
      <div class="form-card" style="margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <div>
            <strong style="font-size:14px;color:var(--accent);">⌂ ${esc(site.name)}</strong>
            ${site.code ? `<span class="mono" style="color:#5B6673;margin-left:8px;">${esc(site.code)}</span>` : ""}
          </div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-sm" onclick="editSite('${site.id}')">Edit</button>
            <button class="btn btn-sm danger" onclick="deleteSite('${site.id}')">Delete</button>
          </div>
        </div>
        ${site.areas && site.areas.length > 0 ? site.areas.map(area => `
          <div style="margin-left:20px;margin-bottom:6px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span style="font-size:13px;color:${area.color || '#3B82F6'};">● ${esc(area.name)}</span>
              <span style="display:flex;gap:4px;">
                <button class="btn btn-sm" onclick="editArea('${area.id}')">Edit</button>
                <button class="btn btn-sm danger" onclick="deleteArea('${area.id}')">×</button>
              </span>
            </div>
            ${area.lines && area.lines.length > 0 ? area.lines.map(line => `
              <div style="margin-left:20px;margin-bottom:4px;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <span style="font-size:12px;color:${line.color || '#10B981'};">▸ ${esc(line.name)}</span>
                  <span style="display:flex;gap:4px;">
                    <button class="btn btn-sm" onclick="editLine('${line.id}')">Edit</button>
                    <button class="btn btn-sm danger" onclick="deleteLine('${line.id}')">×</button>
                  </span>
                </div>
                ${line.stations && line.stations.length > 0 ? line.stations.map(st => `
                  <div style="margin-left:20px;font-size:12px;color:#8B95A1;display:flex;justify-content:space-between;">
                    <span>◦ ${esc(st.name)}</span>
                    <button class="btn btn-sm danger" onclick="deleteStation('${st.id}')">×</button>
                  </div>
                `).join("") : ""}
                ${line.devices && line.devices.length > 0 ? line.devices.map(d => `
                  <div style="margin-left:20px;font-size:11px;color:#5B6673;display:flex;justify-content:space-between;">
                    <span>· ${esc(d.name)}</span>
                    <span style="color:${d.status === 'active' ? '#4FD1B5' : '#E5484D'};">${d.status || 'active'}</span>
                  </div>
                `).join("") : ""}
              </div>
            `).join("") : ""}
            ${area.devices && area.devices.length > 0 ? area.devices.map(d => `
              <div style="margin-left:20px;font-size:11px;color:#5B6673;">· ${esc(d.name)}</div>
            `).join("") : ""}
          </div>
        `).join("") : '<div style="margin-left:20px;color:#5B6673;font-size:12px;">No areas defined</div>'}
        ${site.devices && site.devices.length > 0 ? site.devices.map(d => `
          <div style="margin-left:20px;font-size:11px;color:#5B6673;">· ${esc(d.name)}</div>
        `).join("") : ""}
      </div>
    `).join("")
    : '<div class="form-card"><div style="color:#5B6673;">No hierarchy defined. Create a Site to get started.</div></div>';

  return `
    <div class="top-bar">
      <div>
        <h2>Asset Hierarchy</h2>
        <div class="subtitle">Sites → Areas → Lines → Stations → Devices</div>
      </div>
      <div class="top-bar-actions">
        <button class="btn btn-primary" onclick="showCreateSite()">+ New Site</button>
      </div>
    </div>
    ${tree}
  `;
}

async function showCreateSite() {
  const name = await showPrompt({ title: "Create Site", label: "Site name:" });
  if (!name) return;
  await fetch(`${API}/api/sites`, { method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  await loadHierarchy();
  render();
}

async function editSite(id) {
  const site = hierarchyData.find(s => s.id === id);
  if (!site) return;
  const name = await showPrompt({ title: "Edit Site", label: "Site name:", defaultValue: site.name });
  if (!name) return;
  await fetch(`${API}/api/sites/${id}`, { method: "PUT", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  await loadHierarchy();
  render();
}

async function deleteSite(id) {
  if (!await showConfirm({ title: "Delete Site", message: "Delete this site and all its areas/lines/stations?", danger: true })) return;
  await fetch(`${API}/api/sites/${id}`, { method: "DELETE", headers: authHeaders() });
  await loadHierarchy();
  render();
}

async function editArea(id) {
  const area = hierarchyData.flatMap(s => s.areas || []).find(a => a.id === id);
  if (!area) return;
  const name = await showPrompt({ title: "Edit Area", label: "Area name:", defaultValue: area.name });
  if (!name) return;
  await fetch(`${API}/api/areas/${id}`, { method: "PUT", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  await loadHierarchy();
  render();
}

async function deleteArea(id) {
  if (!await showConfirm({ title: "Delete Area", message: "Delete this area and all its lines/stations?", danger: true })) return;
  await fetch(`${API}/api/areas/${id}`, { method: "DELETE", headers: authHeaders() });
  await loadHierarchy();
  render();
}

async function editLine(id) {
  const line = hierarchyData.flatMap(s => (s.areas || []).flatMap(a => a.lines || [])).find(l => l.id === id);
  if (!line) return;
  const name = await showPrompt({ title: "Edit Line", label: "Line name:", defaultValue: line.name });
  if (!name) return;
  await fetch(`${API}/api/lines/${id}`, { method: "PUT", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  await loadHierarchy();
  render();
}

async function deleteLine(id) {
  if (!await showConfirm({ title: "Delete Line", message: "Delete this line and all its stations?", danger: true })) return;
  await fetch(`${API}/api/lines/${id}`, { method: "DELETE", headers: authHeaders() });
  await loadHierarchy();
  render();
}

async function deleteStation(id) {
  if (!await showConfirm({ title: "Delete Station", message: "Delete this station?", danger: true })) return;
  await fetch(`${API}/api/stations/${id}`, { method: "DELETE", headers: authHeaders() });
  await loadHierarchy();
  render();
}

// ---------- Asset Types View ----------

let assetTypes = [];

async function loadAssetTypes() {
  try {
    const res = await fetch(`${API}/api/asset-types`, { headers: authHeaders() });
    if (res.ok) assetTypes = await res.json();
  } catch {}
}

function viewAssetTypes() {
  loadAssetTypes();
  const categories = [...new Set(assetTypes.map(t => t.category).filter(Boolean))];

  let filtered = [...assetTypes];

  const searchVal = (document.getElementById('asset-type-search') || {}).value || '';
  if (searchVal) {
    const q = searchVal.toLowerCase();
    filtered = filtered.filter(t => (t.name || '').toLowerCase().includes(q) || (t.code || '').toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q));
  }

  const catFilter = (document.getElementById('asset-type-filter') || {}).value || '';
  if (catFilter) {
    filtered = filtered.filter(t => (t.category || '') === catFilter);
  }

  const sortBy = (document.getElementById('asset-type-sort') || {}).value || 'name';
  filtered.sort((a, b) => {
    if (sortBy === 'name') return (a.name || '').localeCompare(b.name || '');
    if (sortBy === 'category') return (a.category || '').localeCompare(b.category || '');
    if (sortBy === 'metrics') return ((b.metrics || []).length) - ((a.metrics || []).length);
    return 0;
  });

  window._assetTypeSearch = searchVal;
  window._assetTypeCatFilter = catFilter;
  window._assetTypeSort = sortBy;

  const types = filtered.map(t => {
    const metricCount = (t.metrics || []).length;
    return `
    <div class="form-card" style="margin-bottom:0;display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div style="display:flex;align-items:center;gap:12px;">
          <span style="display:inline-flex;width:42px;height:42px;border-radius:10px;background:${t.color || '#6366F1'};color:#fff;align-items:center;justify-content:center;font-size:18px;font-weight:600;flex-shrink:0;">${(t.icon || '◆')[0]}</span>
          <div>
            <div style="display:flex;align-items:center;gap:6px;">
              <strong style="font-size:14px;">${esc(t.name)}</strong>
              ${t.isSystem ? '<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:#1E2530;color:#5B6673;">System</span>' : ""}
            </div>
            ${t.code ? `<div class="mono" style="font-size:12px;color:#5B6673;margin-top:2px;">${esc(t.code)}</div>` : ""}
          </div>
        </div>
        ${!t.isSystem ? `<button class="btn btn-sm danger" onclick="deleteAssetType('${t.id}')" title="Delete">✕</button>` : ""}
      </div>
      ${t.description ? `<div style="font-size:12px;color:#8B95A1;line-height:1.4;">${esc(t.description)}</div>` : ""}
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        ${t.category ? `<span style="font-size:11px;padding:3px 8px;border-radius:4px;background:#1E2530;color:#8B95A1;">${esc(t.category)}</span>` : ""}
        <span style="font-size:11px;padding:3px 8px;border-radius:4px;background:${metricCount > 0 ? '#4FD18520' : '#1E2530'};color:${metricCount > 0 ? '#4FD185' : '#5B6673'};">${metricCount} metric${metricCount !== 1 ? 's' : ''}</span>
      </div>
    </div>
    `;
  }).join("");

  return `
    <div class="top-bar">
      <div>
        <h2>Asset Types</h2>
        <div class="subtitle">Define the equipment, machines and systems monitored by the platform.</div>
      </div>
      <div class="top-bar-actions">
        <button class="btn btn-primary" onclick="showCreateAssetType()">+ Create Asset Type</button>
      </div>
    </div>
    <div class="form-card" style="margin-bottom:16px;">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
        <input class="form-input" id="asset-type-search" type="text" placeholder="Search asset types..." style="flex:1;min-width:200px;" value="${esc(window._assetTypeSearch || '')}" oninput="render()" />
        <select class="form-select" id="asset-type-filter" style="min-width:160px;" onchange="render()">
          <option value="">All Categories</option>
          ${categories.map(c => `<option value="${esc(c)}" ${c === window._assetTypeCatFilter ? 'selected' : ''}>${esc(c)}</option>`).join("")}
        </select>
        <select class="form-select" id="asset-type-sort" style="min-width:140px;" onchange="render()">
          <option value="name" ${window._assetTypeSort === 'name' ? 'selected' : ''}>Sort: Name</option>
          <option value="category" ${window._assetTypeSort === 'category' ? 'selected' : ''}>Sort: Category</option>
          <option value="metrics" ${window._assetTypeSort === 'metrics' ? 'selected' : ''}>Sort: Metrics</option>
        </select>
      </div>
    </div>
    ${filtered.length > 0 ? `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;">
        ${types}
      </div>
    ` : `
      <div class="form-card" style="text-align:center;padding:48px 24px;">
        <div style="font-size:36px;margin-bottom:12px;opacity:0.3;">📦</div>
        <div style="font-size:15px;color:#E8EAED;margin-bottom:6px;">No asset types defined</div>
        <div style="font-size:13px;color:#5B6673;margin-bottom:16px;">Create your first asset type to start defining metrics and monitoring equipment.</div>
        <button class="btn btn-primary" onclick="showCreateAssetType()">+ Create Asset Type</button>
      </div>
    `}
  `;
}

async function showCreateAssetType() {
  const values = await showFormModal({
    title: "Create Asset Type",
    subtitle: "Define a new equipment or system type for monitoring.",
    submitText: "Create Asset Type",
    fields: [
      { name: "name", label: "Asset Type Name", type: "text", required: true, placeholder: "e.g. Centrifugal Pump" },
      { name: "description", label: "Description", type: "textarea", placeholder: "Describe what this asset type represents..." },
      { name: "category", label: "Category", type: "select", defaultValue: "", options: [
        { value: "", label: "Select a category..." },
        { value: "Equipment", label: "Equipment" },
        { value: "Sensor", label: "Sensor" },
        { value: "Controller", label: "Controller" },
        { value: "Communication", label: "Communication" },
        { value: "Safety", label: "Safety" },
        { value: "Utility", label: "Utility" },
        { value: "Other", label: "Other" }
      ]},
      { name: "icon", label: "Icon", type: "text", placeholder: "Motor, Valve, Pump..." }
    ]
  });
  if (!values || !values.name) return;
  await authFetch(`${API}/api/asset-types`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: values.name,
      description: values.description || "",
      category: values.category || "",
      icon: values.icon || ""
    })
  });
  await loadAssetTypes();
  render();
}

async function deleteAssetType(id) {
  if (!await showConfirm({ title: "Delete Asset Type", message: "Delete this asset type?", danger: true })) return;
  await authFetch(`${API}/api/asset-types/${id}`, { method: "DELETE" });
  await loadAssetTypes();
  render();
}

// ---------- Sensors View ----------

let sensors = [];

async function loadSensors() {
  try {
    const res = await fetch(`${API}/api/sensors`, { headers: authHeaders() });
    if (res.ok) sensors = await res.json();
  } catch {}
}

function viewSensors() {
  loadSensors();
  const rows = sensors.map(s => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #1E2530;">
      <div>
        <div style="font-size:13px;">${esc(s.name)}</div>
        <div style="font-size:11px;color:#5B6673;">${esc(s.type)} · ${esc(s.unit || "N/A")} · Device: ${esc(s.deviceId)}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <span style="font-size:11px;padding:2px 6px;border-radius:4px;background:${s.enabled ? '#4FD1B520' : '#E5484D20'};color:${s.enabled ? '#4FD1B5' : '#E5484D'};">${s.enabled ? 'enabled' : 'disabled'}</span>
        <button class="btn btn-sm danger" onclick="deleteSensor('${s.id}')">×</button>
      </div>
    </div>
  `).join("");

  return `
    <div class="top-bar">
      <div>
        <h2>Sensors</h2>
        <div class="subtitle">Individual measurement points on devices</div>
      </div>
    </div>
    <div class="form-card">
      ${rows || '<div style="color:#5B6673;padding:16px;">No sensors configured.</div>'}
    </div>
  `;
}

async function deleteSensor(id) {
  if (!await showConfirm({ title: "Delete Sensor", message: "Delete this sensor?", danger: true })) return;
  await fetch(`${API}/api/sensors/${id}`, { method: "DELETE", headers: authHeaders() });
  await loadSensors();
  render();
}

// ---------- Alert Rules View ----------

function viewAlertRules() {
  const rows = alertRules.map(r => {
    const device = devices.find(d => d.id === r.deviceId);
    const statusColor = r.enabled ? "#4FD1B5" : "#5B6673";
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px;border-bottom:1px solid #1E2530;">
        <div style="flex:1;">
          <div style="display:flex;align-items:center;gap:8px;">
            <div style="width:8px;height:8px;border-radius:50%;background:${statusColor};"></div>
            <strong style="font-size:13px;">${esc(r.name)}</strong>
            <span style="font-size:11px;padding:2px 6px;border-radius:4px;background:#1E2530;color:#8B95A1;">${esc(r.severity)}</span>
          </div>
          <div style="font-size:11px;color:#5B6673;margin-top:4px;">
            ${esc(r.metric)} ${esc(r.operator)} ${r.threshold}
            ${device ? ` · ${esc(device.name)}` : " · All devices"}
            ${r.cooldownSeconds ? ` · cooldown ${r.cooldownSeconds}s` : ""}
            ${r.consecutiveCount > 1 ? ` · ${r.consecutiveCount} consecutive` : ""}
          </div>
          ${r.messageTemplate ? `<div style="font-size:11px;color:#5B6673;margin-top:2px;font-style:italic;">"${esc(r.messageTemplate)}"</div>` : ""}
          ${r.lastTriggeredAt ? `<div style="font-size:10px;color:#5B6673;margin-top:2px;">Last triggered: ${new Date(r.lastTriggeredAt).toLocaleString()}</div>` : ""}
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-sm" onclick="testAlertRule('${r.id}')">Test</button>
          <button class="btn btn-sm danger" onclick="deleteAlertRule('${r.id}')">×</button>
        </div>
      </div>
    `;
  }).join("");

  return `
    <div class="top-bar">
      <div>
        <h2>Alert Rules</h2>
        <div class="subtitle">Define threshold rules for any metric</div>
      </div>
      <div class="top-bar-actions">
        <button class="btn btn-primary" onclick="showCreateAlertRule()">+ New Rule</button>
      </div>
    </div>
    <div class="form-card">
      ${rows || '<div style="color:#5B6673;padding:16px;">No alert rules defined. Create a rule to trigger alerts based on metric thresholds.</div>'}
    </div>
  `;
}

async function showCreateAlertRule() {
  const ruleData = await showFormModal({
    title: "Create Alert Rule",
    subtitle: "Define a threshold rule for any metric",
    fields: [
      { name: "name", label: "Rule name:", required: true },
      { name: "metric", label: "Metric name (e.g. weight, temperature, vibration):", required: true },
      { name: "operator", label: "Operator (>, >=, <, <=, ==, !=):", defaultValue: ">" },
      { name: "threshold", label: "Threshold value:", type: "number", required: true },
      { name: "severity", label: "Severity (info, warning, critical):", type: "select", options: [{value:"info",label:"info"},{value:"warning",label:"warning"},{value:"critical",label:"critical"}], defaultValue: "warning" },
    ],
    submitText: "Create"
  });
  if (!ruleData) return;
  const { name, metric, operator, threshold, severity } = ruleData;
  await fetch(`${API}/api/alert-rules`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ name, metric, operator: operator || ">", threshold: Number(threshold), severity: severity || "warning" })
  });
  await loadInitial();
  render();
}

async function testAlertRule(id) {
  const deviceId = await showPrompt({ title: "Test Alert Rule", label: "Device ID to test against (leave empty for first device):" }) || devices[0]?.id;
  if (!deviceId) return;
  const res = await fetch(`${API}/api/alert-rules/${id}/test`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId })
  });
  const result = await res.json();
  showToast(result.triggered ? `Rule triggered! ${JSON.stringify(result.triggeredRules)}` : "Rule not triggered with current value", "info");
}

async function deleteAlertRule(id) {
  if (!await showConfirm({ title: "Delete Alert Rule", message: "Delete this alert rule?", danger: true })) return;
  await fetch(`${API}/api/alert-rules/${id}`, { method: "DELETE", headers: authHeaders() });
  alertRules = alertRules.filter(r => r.id !== id);
  render();
}

// ---------- Boot ----------

async function boot() {
  // Register service worker for PWA
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  try { const bRes = await fetch(`${API}/api/branding`); branding = await bRes.json(); applyBranding(); } catch {}
  if (!getToken()) { renderLogin(); return; }
  try { await loadInitial(); connectWs(); } catch {}
}

// ---------- Documentation & Help ----------

let docTab = "getting-started";
let faqSearch = "";

function viewDocumentation() {
  return `
    <div class="top-bar">
      <div>
        <h2>Documentation</h2>
        <div class="subtitle">Guides, FAQs, and reference for the Cretek Industrial IoT Platform</div>
      </div>
    </div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px;">
      ${["getting-started","how-to","faq","api","troubleshooting"].map(t => `
        <button class="btn ${docTab === t ? 'btn-primary' : ''}" onclick="docTab='${t}';render()">${t.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}</button>
      `).join("")}
    </div>
    <div id="doc-content">${renderDocContent()}</div>
  `;
}

function renderDocContent() {
  switch (docTab) {
    case "getting-started": return renderDocGettingStarted();
    case "how-to": return renderDocHowTo();
    case "faq": return renderDocFAQ();
    case "api": return renderDocAPI();
    case "troubleshooting": return renderDocTroubleshooting();
    default: return renderDocGettingStarted();
  }
}

function renderDocGettingStarted() {
  return `
    <div style="display:grid;gap:16px;">
      <div class="form-card">
        <h3 style="font-size:16px;margin-bottom:8px;color:var(--text-primary);">Welcome to Cretek Industrial IoT Platform</h3>
        <p style="font-size:13px;color:var(--text-secondary);line-height:1.7;margin-bottom:16px;">
          The Cretek Industrial IoT Platform is a comprehensive solution for monitoring, managing, and analyzing industrial equipment and operations. It supports real-time telemetry, predictive maintenance, production tracking, quality management, and advanced analytics.
        </p>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;">
          <div style="padding:14px;background:var(--bg-tertiary);border-radius:6px;border:1px solid var(--border-color);">
            <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:6px;">1. Set Up Your Hierarchy</div>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;">Create Sites, Areas, Lines, and Stations to organize your plant structure. Navigate to <strong>Hierarchy</strong> in the sidebar.</div>
          </div>
          <div style="padding:14px;background:var(--bg-tertiary);border-radius:6px;border:1px solid var(--border-color);">
            <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:6px;">2. Define Asset Types</div>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;">Create asset types (Motor, Pump, Valve, etc.) and define their telemetry signals. Go to <strong>Asset Types</strong>.</div>
          </div>
          <div style="padding:14px;background:var(--bg-tertiary);border-radius:6px;border:1px solid var(--border-color);">
            <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:6px;">3. Register Devices</div>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;">Add devices and assign them to asset types. Configure IP addresses and protocols. Go to <strong>Devices</strong>.</div>
          </div>
          <div style="padding:14px;background:var(--bg-tertiary);border-radius:6px;border:1px solid var(--border-color);">
            <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:6px;">4. Connect the Gateway</div>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;">Install the gateway service on your local network. It polls devices and sends telemetry to the platform. See <strong>Gateway Keys</strong> for API keys.</div>
          </div>
          <div style="padding:14px;background:var(--bg-tertiary);border-radius:6px;border:1px solid var(--border-color);">
            <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:6px;">5. Build Your Dashboard</div>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;">Create dashboard views with widgets for real-time monitoring. Drag and resize widgets. Go to <strong>Dashboard</strong>.</div>
          </div>
          <div style="padding:14px;background:var(--bg-tertiary);border-radius:6px;border:1px solid var(--border-color);">
            <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:6px;">6. Configure Alerts</div>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;">Set up alert rules for thresholds, anomalies, and conditions. Configure notifications. Go to <strong>Alert Rules</strong>.</div>
          </div>
        </div>
      </div>
      <div class="form-card">
        <h3 style="font-size:16px;margin-bottom:8px;color:var(--text-primary);">User Roles</h3>
        <div style="display:grid;gap:8px;">
          <div style="display:flex;gap:12px;align-items:start;padding:10px;background:var(--bg-tertiary);border-radius:4px;">
            <span style="font-size:11px;font-weight:600;color:var(--accent);min-width:60px;text-transform:uppercase;">Admin</span>
            <span style="font-size:12px;color:var(--text-secondary);">Full system access. Manages users, SSO, organizations, and all configuration. Can view all data across all tenants.</span>
          </div>
          <div style="display:flex;gap:12px;align-items:start;padding:10px;background:var(--bg-tertiary);border-radius:4px;">
            <span style="font-size:11px;font-weight:600;color:var(--accent);min-width:60px;text-transform:uppercase;">Manager</span>
            <span style="font-size:12px;color:var(--text-secondary);">Operational access. Manages devices, alert rules, production, maintenance, analytics, integrations, and engineering. Can create shared views.</span>
          </div>
          <div style="display:flex;gap:12px;align-items:start;padding:10px;background:var(--bg-tertiary);border-radius:4px;">
            <span style="font-size:11px;font-weight:600;color:var(--accent);min-width:60px;text-transform:uppercase;">Operator</span>
            <span style="font-size:12px;color:var(--text-secondary);">Read-only access to dashboards, devices, alerts, and production data. Can acknowledge alerts and log downtime events.</span>
          </div>
          <div style="display:flex;gap:12px;align-items:start;padding:10px;background:var(--bg-tertiary);border-radius:4px;">
            <span style="font-size:11px;font-weight:600;color:var(--accent);min-width:60px;text-transform:uppercase;">Viewer</span>
            <span style="font-size:12px;color:var(--text-secondary);">Read-only access to dashboards and device status. Cannot modify any configuration or acknowledge alerts.</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderDocHowTo() {
  const guides = [
    { title: "Create a Site", category: "Hierarchy", steps: [
      "Navigate to <strong>Hierarchy</strong> in the sidebar.",
      "Click <strong>+ New Site</strong> in the top-right.",
      "Enter a name for the site (e.g., 'Plant A', 'Factory North').",
      "Click <strong>Create</strong>.",
      "Sites are the top level of your plant hierarchy. Add Areas, Lines, and Stations below each site."
    ]},
    { title: "Add an Asset Type", category: "Asset Types", steps: [
      "Navigate to <strong>Asset Types</strong>.",
      "Click <strong>+ Create Asset Type</strong>.",
      "Fill in the name (required), description, category, and icon.",
      "Select a category: Equipment, Sensor, Controller, Communication, Safety, Utility, or Other.",
      "Click <strong>Create Asset Type</strong>.",
      "After creation, you can define telemetry signals for this asset type via the API."
    ]},
    { title: "Register a Device", category: "Devices", steps: [
      "Navigate to <strong>Devices</strong>.",
      "Click <strong>+ Add Device</strong>.",
      "Enter the Device ID (unique identifier), name, and IP address.",
      "Select the asset type and assign it to a station in the hierarchy.",
      "Configure the protocol (Modbus TCP, MQTT, OPC-UA, etc.) and connection parameters.",
      "Click <strong>Save</strong>."
    ]},
    { title: "Configure the Gateway", category: "Gateway", steps: [
      "Navigate to <strong>Gateway Keys</strong> (Manager/Admin only).",
      "Click <strong>+ New Key</strong> and give it a label.",
      "Copy the generated API key.",
      "Install the gateway service on a machine in your plant network.",
      "Configure the gateway with the API key and backend URL.",
      "The gateway will poll devices at their configured intervals and post readings to the platform."
    ]},
    { title: "Create a Dashboard Widget", category: "Dashboard", steps: [
      "Navigate to <strong>Dashboard</strong>.",
      "Click <strong>+ Add Widget</strong>.",
      "Select the widget type: Metric Chart, Device Status, KPI Card, or Status Overview.",
      "Choose the device and metric to display.",
      "Configure the time range and display options.",
      "Click <strong>Add</strong>.",
      "Drag widgets to reposition. Drag the bottom-right corner to resize."
    ]},
    { title: "Set Up Alert Rules", category: "Alerts", steps: [
      "Navigate to <strong>Alert Rules</strong> (Manager only).",
      "Click <strong>+ Create Rule</strong>.",
      "Enter a name and select the metric to monitor.",
      "Set the condition: >, >=, <, <=, ==, != and threshold value.",
      "Choose severity: Info, Warning, or Critical.",
      "Click <strong>Create</strong>.",
      "Alerts will trigger when device readings meet the condition."
    ]},
    { title: "Record Production Data", category: "Production", steps: [
      "Navigate to <strong>Production Orders</strong>.",
      "Click <strong>+ New Order</strong> and enter order details.",
      "Start the order when production begins.",
      "Log bag counts, downtime events, and quality checks during production.",
      "Complete the order when finished.",
      "View production metrics in the <strong>OEE</strong> and <strong>SPC</strong> views."
    ]},
    { title: "Schedule Maintenance", category: "Maintenance", steps: [
      "Navigate to <strong>Maintenance</strong>.",
      "Click <strong>+ Add Record</strong> to log maintenance activity.",
      "Enter the type (preventive, corrective, predictive), description, and parts used.",
      "Set the next scheduled date for preventive maintenance.",
      "Track labor hours and costs.",
      "View maintenance history and upcoming schedules."
    ]},
    { title: "Use Predictive Maintenance", category: "Predictive", steps: [
      "Navigate to <strong>Predictive</strong>.",
      "View device health scores (0-100%) based on 7 factors.",
      "Check Remaining Useful Life (RUL) estimates.",
      "Review failure predictions and risk scores.",
      "Follow maintenance recommendations.",
      "Analyze cost optimization suggestions."
    ]},
    { title: "Run ML Analysis", category: "Analytics", steps: [
      "Navigate to <strong>ML Models</strong> to train models on your data.",
      "Select the model type: Regression, Classification, Anomaly Detection, or Forecasting.",
      "Choose training data and parameters.",
      "After training, go to <strong>ML Analysis</strong> to run predictions.",
      "View anomaly scores, drift detection, and forecast results."
    ]},
  ];

  return `
    <div style="display:grid;gap:16px;">
      ${guides.map(g => `
        <div class="form-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <h3 style="font-size:14px;color:var(--text-primary);">${esc(g.title)}</h3>
            <span style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;background:var(--bg-tertiary);padding:3px 8px;border-radius:3px;">${esc(g.category)}</span>
          </div>
          <ol style="margin:0;padding-left:18px;font-size:12px;color:var(--text-secondary);line-height:1.8;">
            ${g.steps.map(s => `<li>${s}</li>`).join("")}
          </ol>
        </div>
      `).join("")}
    </div>
  `;
}

function renderDocFAQ() {
  const faqs = [
    { q: "What is the Cretek Industrial IoT Platform?", a: "A comprehensive platform for monitoring, managing, and analyzing industrial equipment. It supports real-time telemetry, predictive maintenance, production tracking, quality management, SPC, OEE, and advanced analytics." },
    { q: "What protocols are supported?", a: "Modbus TCP, Modbus RTU, MQTT, OPC-UA, HTTP/REST, SNMP, BACnet, Ethernet/IP, PROFINET, EtherCAT, CAN bus, HART, Foundation Fieldbus, DNP3, IEC 61850, and proprietary serial protocols." },
    { q: "How do I connect devices?", a: "Register devices in the Devices view with their IP address and protocol. Install the gateway service on your local network. The gateway polls devices and sends telemetry to the platform via the API." },
    { q: "What is the gateway?", a: "A lightweight Node.js service that runs on your local network. It polls devices at configured intervals, collects telemetry data, and posts it to the platform. It handles reconnection, buffering, and queue management." },
    { q: "How does the dashboard work?", a: "Create dashboard views and add widgets (Metric Chart, Device Status, KPI Card, Status Overview). Drag to reposition and resize. Views can be personal or shared across the team." },
    { q: "How do alerts work?", a: "Create alert rules with conditions (e.g., temperature > 80). When device readings meet the condition, an alert triggers. Alerts can be acknowledged, resolved, and routed to notifications (email, Slack, Teams, WhatsApp)." },
    { q: "What is predictive maintenance?", a: "The platform analyzes device health using 7 factors: vibration, temperature, runtime, error rate, load, maintenance history, and age. It estimates Remaining Useful Life (RUL) and recommends maintenance actions." },
    { q: "What is OEE?", a: "Overall Equipment Effectiveness = Availability x Performance x Quality. It measures how well equipment operates compared to its full potential. The platform calculates OEE automatically from production data." },
    { q: "What is SPC?", a: "Statistical Process Control monitors production quality using control charts. The platform tracks X-bar, R, and P charts with automatic calculation of control limits and process capability (Cp, Cpk)." },
    { q: "Can I integrate with other systems?", a: "Yes. The platform supports webhooks, REST API integration, data import/export (CSV/JSON), and has an integration hub for connecting to ERP, MES, SCADA, and other enterprise systems." },
    { q: "Is the platform secure?", a: "Yes. Features include JWT authentication, 2FA (TOTP), role-based access control, session management, IP-based rate limiting, CORS protection, helmet security headers, and audit logging." },
    { q: "How do I reset my password?", a: "Click 'Change Password' in the dashboard header. Enter your current and new password. Admins can reset passwords for other users in the Users view." },
    { q: "What browsers are supported?", a: "Chrome, Firefox, Safari, and Edge (latest versions). The platform is a Progressive Web App (PWA) and works offline for cached static assets." },
    { q: "How do I enable 2FA?", a: "Go to Dashboard > Change Password > Set up 2FA. Scan the QR code with Google Authenticator or Authy. Enter the 6-digit code to verify. 2FA is required for admin accounts." },
    { q: "Can I create custom reports?", a: "Yes. Use the Report Builder (Manager) to create report templates with selected data sources, time ranges, and chart types. Schedule reports for automatic generation and delivery." },
  ];

  const filtered = faqs.filter(f =>
    !faqSearch || f.q.toLowerCase().includes(faqSearch.toLowerCase()) || f.a.toLowerCase().includes(faqSearch.toLowerCase())
  );

  return `
    <div class="form-card" style="margin-bottom:16px;">
      <input class="form-input" type="text" placeholder="Search FAQs..." value="${esc(faqSearch)}" oninput="faqSearch=this.value;document.getElementById('faq-list').innerHTML=renderDocFAQList();" style="width:100%;" />
    </div>
    <div id="faq-list">${renderDocFAQListInternal(filtered)}</div>
  `;
}

function renderDocFAQList() {
  const faqs = [
    { q: "What is the Cretek Industrial IoT Platform?", a: "A comprehensive platform for monitoring, managing, and analyzing industrial equipment. It supports real-time telemetry, predictive maintenance, production tracking, quality management, SPC, OEE, and advanced analytics." },
    { q: "What protocols are supported?", a: "Modbus TCP, Modbus RTU, MQTT, OPC-UA, HTTP/REST, SNMP, BACnet, Ethernet/IP, PROFINET, EtherCAT, CAN bus, HART, Foundation Fieldbus, DNP3, IEC 61850, and proprietary serial protocols." },
    { q: "How do I connect devices?", a: "Register devices in the Devices view with their IP address and protocol. Install the gateway service on your local network. The gateway polls devices and sends telemetry to the platform via the API." },
    { q: "What is the gateway?", a: "A lightweight Node.js service that runs on your local network. It polls devices at configured intervals, collects telemetry data, and posts it to the platform. It handles reconnection, buffering, and queue management." },
    { q: "How does the dashboard work?", a: "Create dashboard views and add widgets (Metric Chart, Device Status, KPI Card, Status Overview). Drag to reposition and resize. Views can be personal or shared across the team." },
    { q: "How do alerts work?", a: "Create alert rules with conditions (e.g., temperature > 80). When device readings meet the condition, an alert triggers. Alerts can be acknowledged, resolved, and routed to notifications (email, Slack, Teams, WhatsApp)." },
    { q: "What is predictive maintenance?", a: "The platform analyzes device health using 7 factors: vibration, temperature, runtime, error rate, load, maintenance history, and age. It estimates Remaining Useful Life (RUL) and recommends maintenance actions." },
    { q: "What is OEE?", a: "Overall Equipment Effectiveness = Availability x Performance x Quality. It measures how well equipment operates compared to its full potential. The platform calculates OEE automatically from production data." },
    { q: "What is SPC?", a: "Statistical Process Control monitors production quality using control charts. The platform tracks X-bar, R, and P charts with automatic calculation of control limits and process capability (Cp, Cpk)." },
    { q: "Can I integrate with other systems?", a: "Yes. The platform supports webhooks, REST API integration, data import/export (CSV/JSON), and has an integration hub for connecting to ERP, MES, SCADA, and other enterprise systems." },
    { q: "Is the platform secure?", a: "Yes. Features include JWT authentication, 2FA (TOTP), role-based access control, session management, IP-based rate limiting, CORS protection, helmet security headers, and audit logging." },
    { q: "How do I reset my password?", a: "Click 'Change Password' in the dashboard header. Enter your current and new password. Admins can reset passwords for other users in the Users view." },
    { q: "What browsers are supported?", a: "Chrome, Firefox, Safari, and Edge (latest versions). The platform is a Progressive Web App (PWA) and works offline for cached static assets." },
    { q: "How do I enable 2FA?", a: "Go to Dashboard > Change Password > Set up 2FA. Scan the QR code with Google Authenticator or Authy. Enter the 6-digit code to verify. 2FA is required for admin accounts." },
    { q: "Can I create custom reports?", a: "Yes. Use the Report Builder (Manager) to create report templates with selected data sources, time ranges, and chart types. Schedule reports for automatic generation and delivery." },
  ];
  const filtered = faqs.filter(f =>
    !faqSearch || f.q.toLowerCase().includes(faqSearch.toLowerCase()) || f.a.toLowerCase().includes(faqSearch.toLowerCase())
  );
  return renderDocFAQListInternal(filtered);
}

function renderDocFAQListInternal(faqs) {
  if (faqs.length === 0) return `<div class="form-card" style="text-align:center;padding:24px;color:var(--text-muted);">No matching FAQs found.</div>`;
  return `<div style="display:grid;gap:8px;">
    ${faqs.map(f => `
      <div class="form-card" style="cursor:pointer;" onclick="this.querySelector('.faq-answer').style.display=this.querySelector('.faq-answer').style.display==='none'?'block':'none'">
        <div style="font-size:13px;font-weight:500;color:var(--text-primary);display:flex;justify-content:space-between;align-items:center;">
          ${esc(f.q)}
          <span style="color:var(--text-muted);font-size:16px;">+</span>
        </div>
        <div class="faq-answer" style="display:none;margin-top:10px;font-size:12px;color:var(--text-secondary);line-height:1.7;border-top:1px solid var(--border-color);padding-top:10px;">
          ${esc(f.a)}
        </div>
      </div>
    `).join("")}
  </div>`;
}

function renderDocAPI() {
  return `
    <div style="display:grid;gap:16px;">
      <div class="form-card">
        <h3 style="font-size:16px;margin-bottom:8px;color:var(--text-primary);">API Reference</h3>
        <p style="font-size:13px;color:var(--text-secondary);line-height:1.7;margin-bottom:16px;">
          The Cretek Industrial IoT Platform exposes a RESTful API for all operations. All endpoints require JWT authentication via the <code style="background:var(--bg-tertiary);padding:2px 6px;border-radius:3px;font-family:var(--font-mono);font-size:11px;">Authorization: Bearer &lt;token&gt;</code> header.
        </p>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;">
          Base URL: <code style="background:var(--bg-tertiary);padding:2px 6px;border-radius:3px;font-family:var(--font-mono);">${esc(API)}</code>
        </div>
      </div>
      ${[
        { group: "Authentication", endpoints: [
          { method: "POST", path: "/api/auth/login", desc: "Login with username/password. Returns JWT token." },
          { method: "POST", path: "/api/auth/2fa/setup", desc: "Initialize 2FA setup. Returns QR code." },
          { method: "POST", path: "/api/auth/2fa/verify", desc: "Verify 2FA code and enable TOTP." },
          { method: "POST", path: "/api/auth/2fa/disable", desc: "Disable 2FA (requires password)." },
          { method: "POST", path: "/api/auth/revoke-sessions", desc: "Revoke all sessions for current user." },
        ]},
        { group: "Hierarchy", endpoints: [
          { method: "GET", path: "/api/hierarchy", desc: "Get full site/area/line/station hierarchy." },
          { method: "POST", path: "/api/sites", desc: "Create a new site." },
          { method: "PUT", path: "/api/sites/:id", desc: "Update a site." },
          { method: "DELETE", path: "/api/sites/:id", desc: "Delete a site and all children." },
          { method: "POST", path: "/api/areas", desc: "Create an area under a site." },
          { method: "PUT", path: "/api/areas/:id", desc: "Update an area." },
          { method: "DELETE", path: "/api/areas/:id", desc: "Delete an area." },
          { method: "POST", path: "/api/lines", desc: "Create a line under an area." },
          { method: "PUT", path: "/api/lines/:id", desc: "Update a line." },
          { method: "DELETE", path: "/api/lines/:id", desc: "Delete a line." },
          { method: "DELETE", path: "/api/stations/:id", desc: "Delete a station." },
        ]},
        { group: "Devices", endpoints: [
          { method: "GET", path: "/api/devices", desc: "List all devices." },
          { method: "POST", path: "/api/devices", desc: "Register a new device." },
          { method: "PUT", path: "/api/devices/:id", desc: "Update device configuration." },
          { method: "DELETE", path: "/api/devices/:id", desc: "Delete a device." },
          { method: "POST", path: "/api/readings", desc: "Post a reading (gateway)." },
          { method: "GET", path: "/api/readings/latest", desc: "Get latest readings for all devices." },
          { method: "GET", path: "/api/readings/history/:deviceId", desc: "Get reading history for a device." },
          { method: "GET", path: "/api/telemetry/latest", desc: "Get latest telemetry for all devices." },
        ]},
        { group: "Asset Types", endpoints: [
          { method: "GET", path: "/api/asset-types", desc: "List all asset types." },
          { method: "POST", path: "/api/asset-types", desc: "Create a new asset type." },
          { method: "PUT", path: "/api/asset-types/:id", desc: "Update an asset type." },
          { method: "DELETE", path: "/api/asset-types/:id", desc: "Delete an asset type." },
        ]},
        { group: "Alerts & Rules", endpoints: [
          { method: "GET", path: "/api/alerts", desc: "List active and historical alerts." },
          { method: "POST", path: "/api/alerts/:id/acknowledge", desc: "Acknowledge an alert." },
          { method: "GET", path: "/api/alert-rules", desc: "List alert rules." },
          { method: "POST", path: "/api/alert-rules", desc: "Create an alert rule." },
          { method: "DELETE", path: "/api/alert-rules/:id", desc: "Delete an alert rule." },
          { method: "POST", path: "/api/alert-rules/:id/test", desc: "Test an alert rule against current data." },
        ]},
        { group: "Dashboard", endpoints: [
          { method: "GET", path: "/api/dashboard-views", desc: "List dashboard views." },
          { method: "POST", path: "/api/dashboard-views", desc: "Create a dashboard view." },
          { method: "PUT", path: "/api/dashboard-views/:id", desc: "Update a dashboard view." },
          { method: "DELETE", path: "/api/dashboard-views/:id", desc: "Delete a dashboard view." },
          { method: "POST", path: "/api/dashboard-views/:id/duplicate", desc: "Duplicate a dashboard view." },
          { method: "POST", path: "/api/dashboard-views/reorder", desc: "Reorder dashboard views." },
          { method: "GET", path: "/api/dashboard-widgets", desc: "List widgets for a view." },
          { method: "POST", path: "/api/dashboard-widgets", desc: "Add a widget to a view." },
          { method: "PUT", path: "/api/dashboard-widgets/:id", desc: "Update a widget." },
          { method: "DELETE", path: "/api/dashboard-widgets/:id", desc: "Delete a widget." },
          { method: "PUT", path: "/api/dashboard-widgets/batch", desc: "Batch update widget positions/sizes." },
        ]},
        { group: "Production", endpoints: [
          { method: "GET", path: "/api/production-orders", desc: "List production orders." },
          { method: "POST", path: "/api/production-orders", desc: "Create a production order." },
          { method: "POST", path: "/api/production-orders/:id/start", desc: "Start a production order." },
          { method: "POST", path: "/api/production-orders/:id/complete", desc: "Complete a production order." },
          { method: "POST", path: "/api/production-orders/:id/log-bags", desc: "Log bag count for an order." },
          { method: "GET", path: "/api/quality-metrics", desc: "List quality metrics." },
          { method: "POST", path: "/api/quality-metrics", desc: "Log a quality metric." },
        ]},
        { group: "Maintenance", endpoints: [
          { method: "GET", path: "/api/maintenance", desc: "List maintenance records." },
          { method: "POST", path: "/api/maintenance", desc: "Create a maintenance record." },
          { method: "PUT", path: "/api/maintenance/:id", desc: "Update a maintenance record." },
          { method: "DELETE", path: "/api/maintenance/:id", desc: "Delete a maintenance record." },
          { method: "GET", path: "/api/maintenance-schedules", desc: "List maintenance schedules." },
          { method: "POST", path: "/api/maintenance-schedules", desc: "Create a maintenance schedule." },
        ]},
        { group: "Analytics & ML", endpoints: [
          { method: "GET", path: "/api/ml-models", desc: "List ML models." },
          { method: "POST", path: "/api/ml-models", desc: "Train a new ML model." },
          { method: "GET", path: "/api/ml-predictions", desc: "List ML predictions." },
          { method: "POST", path: "/api/ml-predictions/run", desc: "Run predictions on a model." },
          { method: "GET", path: "/api/anomalies", desc: "List detected anomalies." },
          { method: "GET", path: "/api/forecasts", desc: "List forecasts." },
          { method: "GET", path: "/api/predictive/health", desc: "Get device health scores." },
          { method: "GET", path: "/api/predictive/rul", desc: "Get remaining useful life estimates." },
        ]},
        { group: "Integrations", endpoints: [
          { method: "GET", path: "/api/integrations", desc: "List integrations." },
          { method: "POST", path: "/api/integrations", desc: "Create an integration." },
          { method: "DELETE", path: "/api/integrations/:id", desc: "Delete an integration." },
          { method: "GET", path: "/api/webhooks", desc: "List webhooks." },
          { method: "POST", path: "/api/webhooks", desc: "Create a webhook." },
          { method: "DELETE", path: "/api/webhooks/:id", desc: "Delete a webhook." },
          { method: "POST", path: "/api/export", desc: "Export data as CSV/JSON." },
          { method: "POST", path: "/api/import", desc: "Import data from CSV/JSON." },
        ]},
        { group: "System", endpoints: [
          { method: "GET", path: "/api/health", desc: "Full system health check." },
          { method: "GET", path: "/api/health/ping", desc: "Simple ping endpoint." },
          { method: "GET", path: "/api/audit", desc: "List audit log entries." },
          { method: "GET", path: "/api/users", desc: "List users (Admin)." },
          { method: "POST", path: "/api/users", desc: "Create a user (Admin)." },
          { method: "GET", path: "/api/organizations", desc: "List organizations (Admin)." },
        ]},
      ].map(g => `
        <div class="form-card">
          <h3 style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:10px;text-transform:uppercase;letter-spacing:0.05em;">${esc(g.group)}</h3>
          <div style="display:grid;gap:4px;">
            ${g.endpoints.map(e => `
              <div style="display:flex;gap:10px;align-items:center;padding:6px 8px;background:var(--bg-tertiary);border-radius:3px;font-size:12px;">
                <span style="font-family:var(--font-mono);font-size:10px;font-weight:600;min-width:50px;padding:2px 6px;border-radius:3px;text-align:center;${e.method === 'GET' ? 'background:#1a3a2a;color:#3fb950;' : e.method === 'POST' ? 'background:#1a2a3a;color:#58a6ff;' : e.method === 'PUT' ? 'background:#3a2a1a;color:#d29922;' : 'background:#3a1a1a;color:#f85149;'}">${e.method}</span>
                <code style="font-family:var(--font-mono);color:var(--text-primary);min-width:200px;">${esc(e.path)}</code>
                <span style="color:var(--text-secondary);">${esc(e.desc)}</span>
              </div>
            `).join("")}
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderDocTroubleshooting() {
  const issues = [
    { title: "Cannot log in", solutions: [
      "Verify your username and password are correct.",
      "Check if 2FA is enabled — you need your authenticator code.",
      "If locked out, contact an admin to reset your password or revoke sessions.",
      "Clear browser cache and cookies, then try again."
    ]},
    { title: "Devices show offline", solutions: [
      "Verify the device IP address is correct and reachable from the gateway.",
      "Check the gateway service is running: visit /api/health/ping.",
      "Ensure the device is powered on and connected to the network.",
      "Check firewall rules — the gateway needs access to device ports.",
      "Review the gateway logs for connection errors."
    ]},
    { title: "No telemetry data appearing", solutions: [
      "Verify the gateway API key is valid (Gateway Keys page).",
      "Check the gateway is posting to /api/readings and /api/telemetry.",
      "Ensure device intervals are configured (default: 5 seconds).",
      "Check the device has an asset type assigned with defined metrics.",
      "Review the gateway queue for failed posts (pending-readings.jsonl)."
    ]},
    { title: "Dashboard widgets not loading", solutions: [
      "Refresh the page (hard refresh: Ctrl+Shift+R).",
      "Check if the device associated with the widget is online.",
      "Verify the widget configuration (device ID, metric name).",
      "Clear browser local storage and re-login."
    ]},
    { title: "Alerts not triggering", solutions: [
      "Verify the alert rule is active and the condition is correct.",
      "Check the device is sending data that meets the threshold.",
      "Review the alert rule test feature to validate the condition.",
      "Ensure the metric name matches exactly (case-sensitive)."
    ]},
    { title: "Gateway connection errors", solutions: [
      "ECONNREFUSED: Device is not accepting connections. Check device power and network.",
      "ETIMEDOUT: Network timeout. Check firewall, routing, and device IP.",
      "ENOTFOUND: DNS resolution failed. Use IP addresses, not hostnames.",
      "Socket hang up: Device closed connection unexpectedly. Check device configuration."
    ]},
    { title: "Performance issues", solutions: [
      "Reduce telemetry polling intervals for non-critical devices.",
      "Limit dashboard widget time ranges (use 1h instead of 24h).",
      "Archive old data using the data export feature.",
      "Check system health (System page) for memory and database usage.",
      "Consider scaling the Render instance if on the free tier."
    ]},
    { title: "2FA issues", solutions: [
      "Ensure your device clock is synchronized (use NTP).",
      "Scan the QR code again if the code is not accepted.",
      "Use the manual entry key if QR scanning fails.",
      "Contact an admin to disable 2FA if you lose access to your authenticator."
    ]},
  ];

  return `
    <div style="display:grid;gap:16px;">
      <div class="form-card">
        <h3 style="font-size:16px;margin-bottom:8px;color:var(--text-primary);">Troubleshooting Guide</h3>
        <p style="font-size:13px;color:var(--text-secondary);line-height:1.7;">
          Common issues and their solutions. If your issue is not listed here, check the system health page or contact support.
        </p>
      </div>
      ${issues.map(i => `
        <div class="form-card">
          <h3 style="font-size:14px;color:var(--text-primary);margin-bottom:10px;">${esc(i.title)}</h3>
          <ul style="margin:0;padding-left:18px;font-size:12px;color:var(--text-secondary);line-height:1.8;">
            ${i.solutions.map(s => `<li>${esc(s)}</li>`).join("")}
          </ul>
        </div>
      `).join("")}
    </div>
  `;
}
