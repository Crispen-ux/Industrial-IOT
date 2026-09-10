const nodemailer = require("nodemailer");
const https = require("https");
const http = require("http");

let transporter = null;

// ---- Email (Gmail SMTP — free) ----

function initEmailTransporter(cfg) {
  if (!cfg.smtpUser || !cfg.smtpPass) { transporter = null; return; }
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: cfg.smtpUser, pass: cfg.smtpPass },
  });
}

async function sendEmail(to, subject, html) {
  if (!transporter || !to) return;
  try {
    await transporter.sendMail({ from: `"Scale Ops" <${transporter.options.auth.user}>`, to, subject, html });
    console.log(`[notify] Email sent to ${to}`);
  } catch (e) {
    console.error("[notify] Email failed:", e.message);
  }
}

// ---- WhatsApp (Ultrammsg — free tier: 1000 msgs/month) ----

async function sendWhatsApp(cfg, to, message) {
  if (!cfg.ultramsgUrl || !cfg.ultramsgToken || !cfg.ultrammsgInstanceId || !to) return;
  const url = new URL(cfg.ultrammsgUrl);
  const payload = JSON.stringify({
    token: cfg.ultrammsgToken,
    instanceId: cfg.ultrammsgInstanceId,
    to,
    body: message,
  });

  return new Promise((resolve) => {
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => { console.log(`[notify] WhatsApp response: ${res.statusCode}`); resolve(); });
    });
    req.on("error", (e) => { console.error("[notify] WhatsApp failed:", e.message); resolve(); });
    req.write(payload);
    req.end();
  });
}

// ---- Slack / Microsoft Teams (Incoming Webhook — free) ----

async function sendWebhook(url, payload) {
  if (!url) return;
  const u = new URL(url);
  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    const transport = u.protocol === "https:" ? https : http;
    const req = transport.request({
      hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = ""; res.on("data", (c) => d += c);
      res.on("end", () => { console.log(`[notify] Webhook response: ${res.statusCode}`); resolve(); });
    });
    req.on("error", (e) => { console.error("[notify] Webhook failed:", e.message); resolve(); });
    req.write(body); req.end();
  });
}

async function sendSlack(cfg, text) {
  if (!cfg.slackWebhookUrl) return;
  await sendWebhook(cfg.slackWebhookUrl, { text, unfurl_links: false });
}

async function sendTeams(cfg, text) {
  if (!cfg.teamsWebhookUrl) return;
  // Teams incoming webhook uses Adaptive Card format
  await sendWebhook(cfg.teamsWebhookUrl, {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    themeColor: "F2B705",
    summary: "Scale Ops Notification",
    sections: [{ activityTitle: text }],
  });
}

// ---- Public API ----

async function sendDowntimeAlert(cfg, deviceName, downtimeSec) {
  const subject = `⚠ Downtime Alert: ${deviceName}`;
  const text = `No data received from "${deviceName}" for over ${downtimeSec}s. The device may be offline.`;
  const html = `<div style="font-family:sans-serif;padding:20px;">
    <h2 style="color:#c0392b;">⚠ Downtime Alert</h2>
    <p><strong>${deviceName}</strong> has stopped sending data.</p>
    <p>Silence duration: <strong>${downtimeSec} seconds</strong></p>
    <p style="color:#666;font-size:13px;">Scale Ops IoT Dashboard</p>
  </div>`;

  if (cfg.emailEnabled) await sendEmail(cfg.emailRecipients, subject, html);
  if (cfg.whatsappEnabled) await sendWhatsApp(cfg, cfg.whatsappRecipients, text);
  if (cfg.slackEnabled) await sendSlack(cfg, `⚠ *Downtime Alert:* ${deviceName} — no data for ${downtimeSec}s`);
  if (cfg.teamsEnabled) await sendTeams(cfg, `⚠ **Downtime Alert:** ${deviceName} — no data for ${downtimeSec}s`);
}

async function sendDowntimeResolved(cfg, deviceName) {
  const subject = `✓ Resolved: ${deviceName}`;
  const text = `"${deviceName}" is back online and sending data.`;
  const html = `<div style="font-family:sans-serif;padding:20px;">
    <h2 style="color:#27ae60;">✓ Device Recovered</h2>
    <p><strong>${deviceName}</strong> is back online.</p>
    <p style="color:#666;font-size:13px;">Scale Ops IoT Dashboard</p>
  </div>`;

  if (cfg.emailEnabled) await sendEmail(cfg.emailRecipients, subject, html);
  if (cfg.whatsappEnabled) await sendWhatsApp(cfg, cfg.whatsappRecipients, text);
  if (cfg.slackEnabled) await sendSlack(cfg, `✓ *Resolved:* ${deviceName} is back online`);
  if (cfg.teamsEnabled) await sendTeams(cfg, `✓ **Resolved:** ${deviceName} is back online`);
}

module.exports = { initEmailTransporter, sendDowntimeAlert, sendDowntimeResolved, sendEmail };
