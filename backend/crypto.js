const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString("hex");

function getKey() {
  return Buffer.from(KEY, "hex").length === 32 ? Buffer.from(KEY, "hex") : crypto.createHash("sha256").update(KEY).digest();
}

function encrypt(text) {
  if (!text) return text;
  const key = getKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${tag}:${encrypted}`;
}

function decrypt(encryptedText) {
  if (!encryptedText || !encryptedText.includes(":")) return encryptedText;
  try {
    const key = getKey();
    const [ivHex, tagHex, encrypted] = encryptedText.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (e) {
    return encryptedText;
  }
}

function isEncrypted(text) {
  return text && typeof text === "string" && text.split(":").length === 3;
}

module.exports = { encrypt, decrypt, isEncrypted };
