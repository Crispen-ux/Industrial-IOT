// Two separate credential types, deliberately not unified:
//  - Dashboard users log in with username/password and get a short-lived JWT.
//  - Gateways authenticate with a static API key (no login flow — they're a
//    service, not a person) sent as the X-Gateway-Key header.
// Keeping them distinct means revoking a gateway's access never touches user
// accounts, and a leaked dashboard password can't be used to post fake readings.

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function randomReadablePassword() {
  // base64url, trimmed to something easy to read off a terminal
  return crypto.randomBytes(9).toString("base64url");
}

function randomApiKey(prefix = "gw") {
  return `${prefix}_` + crypto.randomBytes(24).toString("hex");
}

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signToken(payload, secret) {
  return jwt.sign(payload, secret, { expiresIn: "12h" });
}

function verifyToken(token, secret) {
  try {
    return jwt.verify(token, secret);
  } catch {
    return null;
  }
}

module.exports = {
  randomSecret,
  randomReadablePassword,
  randomApiKey,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
};
