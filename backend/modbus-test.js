// Lightweight Modbus TCP test — used by the onboarding wizard's connection
// test and datapoint read steps. Only handles TCP (not RTU) since the wizard
// doesn't collect serial port settings.

let ModbusRTU;
try {
  ModbusRTU = require("modbus-serial");
} catch {
  // modbus-serial not installed — tests will fail gracefully
}

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Test a TCP connection to a Modbus device.
 * Returns { success, latencyMs, message, unitId, deviceInfo }
 */
async function testConnection({ ip, port = 502, unitId = 1, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!ModbusRTU) return { success: false, latencyMs: 0, message: "modbus-serial not installed on server" };
  if (!ip) return { success: false, latencyMs: 0, message: "No IP address provided" };

  const client = new ModbusRTU();
  const start = Date.now();
  try {
    client.setTimeout(timeoutMs);
    await client.connectTCP(ip, { port });
    client.setID(unitId);

    // Read a single register to verify the device actually responds
    // (connectTCP alone can succeed even if no device is listening on some OSes)
    await client.readHoldingRegisters(0, 1);
    const latencyMs = Date.now() - start;

    await client.close();
    return { success: true, latencyMs, message: `Connected and read register 0 from ${ip}:${port} (unit ${unitId})`, unitId };
  } catch (err) {
    const latencyMs = Date.now() - start;
    try { await client.close(); } catch {}
    // Classify the error for the user
    const msg = err.message || String(err);
    if (msg.includes("ECONNREFUSED")) {
      return { success: false, latencyMs, message: `Connection refused — is a Modbus server running on ${ip}:${port}?` };
    }
    if (msg.includes("ETIMEDOUT") || msg.includes("Timeout")) {
      return { success: false, latencyMs, message: `Timed out after ${latencyMs}ms — check IP/port and firewall` };
    }
    if (msg.includes("ENOTFOUND")) {
      return { success: false, latencyMs, message: `DNS resolution failed for ${ip}` };
    }
    return { success: false, latencyMs, message: `Modbus error: ${msg}` };
  }
}

/**
 * Read a holding register from a Modbus TCP device.
 * Returns { success, latencyMs, rawValue, parsedValue, unit, message }
 */
async function testDatapoint({ ip, port = 502, unitId = 1, register = 0, registerLen = 2, scaleFactor = 1, byteOrder = "littleEndian", weightFormat = "float32", timeoutMs = DEFAULT_TIMEOUT_MS, unit = "kg" }) {
  if (!ModbusRTU) return { success: false, latencyMs: 0, rawValue: null, parsedValue: null, unit, message: "modbus-serial not installed on server" };
  if (!ip) return { success: false, latencyMs: 0, rawValue: null, parsedValue: null, unit, message: "No IP address provided" };

  const client = new ModbusRTU();
  const start = Date.now();
  try {
    client.setTimeout(timeoutMs);
    await client.connectTCP(ip, { port });
    client.setID(unitId);

    const res = await client.readHoldingRegisters(Number(register), Number(registerLen));
    const latencyMs = Date.now() - start;

    let raw = res.data[0];
    if (registerLen === 2) {
      raw = byteOrder === "bigEndian"
        ? (res.data[0] << 16) | res.data[1]
        : (res.data[1] << 16) | res.data[0];
    }

    let parsed;
    switch (weightFormat) {
      case "float32": {
        const buf = Buffer.alloc(4);
        buf.writeUInt16LE(raw & 0xffff, 0);
        buf.writeUInt16LE((raw >> 16) & 0xffff, 2);
        parsed = buf.readFloatLE(0);
        break;
      }
      case "int32":
        parsed = raw;
        break;
      case "int16":
        parsed = raw & 0xffff;
        break;
      default:
        parsed = raw;
    }
    parsed = parsed * Number(scaleFactor);

    await client.close();
    return {
      success: true,
      latencyMs,
      rawValue: raw,
      parsedValue: Math.round(parsed * 1000) / 1000,
      unit,
      message: `Read register ${register} (${registerLen} regs) — raw ${raw}, scaled ${parsed.toFixed(3)} ${unit}`,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    try { await client.close(); } catch {}
    const msg = err.message || String(err);
    return { success: false, latencyMs, rawValue: null, parsedValue: null, unit, message: `Read failed: ${msg}` };
  }
}

module.exports = { testConnection, testDatapoint };
