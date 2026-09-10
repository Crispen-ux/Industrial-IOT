// A simple durable queue: unsent readings are appended to a JSON-lines file so
// they survive a gateway restart, not just a backend outage. Flushed in order
// once the backend is reachable again.
//
// This is intentionally simple (flat file, not a real database) — good enough
// for the reading volumes a fill line produces. If you outgrow it, swap for
// SQLite with the same three functions and nothing else needs to change.

const fs = require("fs");
const path = require("path");

// QUEUE_DIR lets a Docker/systemd deployment point the buffer file at a
// persistent volume/directory instead of the gateway's own folder — see
// docker-compose.yml. Defaults to this folder for a plain `npm start`.
const QUEUE_DIR = process.env.QUEUE_DIR || __dirname;
const QUEUE_FILE = path.join(QUEUE_DIR, "pending-readings.jsonl");

// How many readings to buffer before the oldest ones start getting dropped.
// Default covers several hours even with a handful of devices at a 500ms
// poll interval — see EDGE_DEPLOYMENT.md for the exact formula and how to
// size this for your site's device count and expected outage length. Entries
// are small (roughly 100 bytes each), so a generous cap costs little disk —
// 500,000 entries is around 50MB.
const MAX_QUEUED = Number(process.env.MAX_QUEUED_READINGS) || 500000;

// Re-reading and re-parsing the whole file on every single append would get
// slow at a cap this size. Instead, track the line count in memory (cheap
// byte-scan on first use, O(1) after) and only do the expensive read+rewrite
// trim once every TRIM_BATCH entries past the cap — amortizes the cost
// instead of paying it on every write.
const TRIM_BATCH = Math.max(100, Math.floor(MAX_QUEUED * 0.01));
let cachedCount = null;

function countLines() {
  if (!fs.existsSync(QUEUE_FILE)) return 0;
  const data = fs.readFileSync(QUEUE_FILE, "utf8");
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === "\n") count++;
  }
  return count;
}

function enqueue(entry) {
  fs.appendFileSync(QUEUE_FILE, JSON.stringify(entry) + "\n");
  if (cachedCount === null) cachedCount = countLines();
  else cachedCount += 1;

  if (cachedCount > MAX_QUEUED + TRIM_BATCH) {
    const all = readAll();
    const trimmed = all.slice(all.length - MAX_QUEUED);
    writeAll(trimmed);
  }
}

function readAll() {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  return fs
    .readFileSync(QUEUE_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeAll(entries) {
  if (entries.length === 0) {
    if (fs.existsSync(QUEUE_FILE)) fs.unlinkSync(QUEUE_FILE);
  } else {
    fs.writeFileSync(QUEUE_FILE, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  cachedCount = entries.length;
}

function size() {
  if (cachedCount !== null) return cachedCount;
  return countLines();
}

module.exports = { enqueue, readAll, writeAll, size };

