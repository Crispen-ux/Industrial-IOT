const sim = require("./simulator");
const fetch = require("node-fetch");

// ============================================================
// Base Driver — default to simulator
// ============================================================
class BaseDriver {
  constructor(device) {
    this.device = device;
    this.state = sim.createSimState(device.target);
    this.connected = false;
  }
  async connect() { this.connected = true; }
  async read() {
    sim.step(this.state, this.device.target);
    return { ...this.state };
  }
  async disconnect() { this.connected = false; }
}

// ============================================================
// Modbus TCP / RTU Driver
// Supports: Mettler Toledo, A&D, Fairbanks, Rice Lake, Toledo
// ============================================================
class ModbusDriver extends BaseDriver {
  constructor(device) {
    super(device);
    this.client = null;
    this.regConfig = this._parseRegConfig(device);
  }

  _parseRegConfig(device) {
    // Default register maps for common scales
    const defaults = {
      weightReg: 0,
      weightLen: 2,
      statusReg: 4,
      statusLen: 1,
      unitId: device.modbusUnitId || 1,
      baudRate: device.baudRate || 9600,
      weightFormat: device.weightFormat || "float32", // float32, int32, int16, bcd
      scaleFactor: device.scaleFactor || 1,
      byteOrder: device.byteOrder || "littleEndian",
    };
    try {
      if (device.regConfig) return { ...defaults, ...JSON.parse(device.regConfig) };
    } catch (e) {}
    return defaults;
  }

  async connect() {
    try {
      const ModbusRTU = require("modbus-serial");
      this.client = new ModbusRTU();

      if (this.device.connectionType === "rtu") {
        // Serial Modbus RTU
        const SerialPort = require("serialport");
        const port = new SerialPort({
          path: this.device.serialPort || "/dev/ttyUSB0",
          baudRate: this.regConfig.baudRate,
          dataBits: 8,
          stopBits: 1,
          parity: "none",
        });
        await this.client.connectRTUBuffered(port.path, {
          baudRate: this.regConfig.baudRate,
        });
      } else {
        // Modbus TCP
        await this.client.connectTCP(this.device.ip, {
          port: this.device.port || 502,
        });
      }

      this.client.setID(this.regConfig.unitId);
      this.client.setTimeout(3000);
      this.connected = true;
      console.log(`[modbus] connected to ${this.device.ip || this.device.serialPort}`);
    } catch (e) {
      console.error(`[modbus] connect failed: ${e.message}`);
      this.connected = false;
    }
  }

  async read() {
    if (!this.client || !this.connected) {
      return { weight: 0, phase: "offline", bagCount: 0, connected: false };
    }
    try {
      const res = await this.client.readHoldingRegisters(
        this.regConfig.weightReg,
        this.regConfig.weightLen
      );
      let raw = res.data[0];
      if (this.regConfig.weightLen === 2) {
        raw = this._combineRegisters(res.data[0], res.data[1]);
      }
      const weight = this._decodeWeight(raw) * this.regConfig.scaleFactor;

      // Read status register
      let phase = "idle";
      try {
        const statusRes = await this.client.readHoldingRegisters(
          this.regConfig.statusReg,
          this.regConfig.statusLen
        );
        phase = this._decodePhase(statusRes.data[0]);
      } catch (e) {}

      // Read bag count (optional register)
      let bagCount = 0;
      try {
        const bagRes = await this.client.readHoldingRegisters(
          this.regConfig.weightReg + 10,
          1
        );
        bagCount = bagRes.data[0];
      } catch (e) {}

      return { weight, phase, bagCount, connected: true };
    } catch (e) {
      return { weight: 0, phase: "error", bagCount: 0, connected: false };
    }
  }

  _combineRegisters(high, low) {
    if (this.regConfig.byteOrder === "bigEndian") {
      return (high << 16) | low;
    }
    return (low << 16) | high;
  }

  _decodeWeight(raw) {
    switch (this.regConfig.weightFormat) {
      case "float32": {
        const buf = Buffer.alloc(4);
        buf.writeUInt16LE(raw & 0xffff, 0);
        buf.writeUInt16LE((raw >> 16) & 0xffff, 2);
        return buf.readFloatLE(0);
      }
      case "int32":
        return raw;
      case "int16":
        return raw & 0xffff;
      case "bcd":
        return this._bcdDecode(raw);
      default:
        return raw;
    }
  }

  _bcdDecode(val) {
    let result = 0;
    let multiplier = 1;
    while (val > 0) {
      result += (val % 10) * multiplier;
      multiplier *= 10;
      val = Math.floor(val / 16);
    }
    return result;
  }

  _decodePhase(code) {
    const phases = {
      0: "idle", 1: "filling", 2: "settling", 3: "complete",
      4: "dumping", 5: "error", 6: "overweight", 7: "underweight",
    };
    return phases[code] || "idle";
  }

  async disconnect() {
    if (this.client) {
      try { await this.client.close(); } catch (e) {}
    }
    this.connected = false;
  }
}

// ============================================================
// OPC-UA Driver
// Supports: Siemens, Rockwell, ABB, Schneider, any OPC-UA server
// ============================================================
class OpcUaDriver extends BaseDriver {
  constructor(device) {
    super(device);
    this.client = null;
    this.session = null;
    this.nodes = this._parseNodes(device);
  }

  _parseNodes(device) {
    const defaults = {
      weightNode: "ns=2;s= weight",
      statusNode: "ns=2;s= status",
      bagCountNode: "ns=2;s= bagCount",
      namespace: device.opcuaNamespace || 2,
    };
    try {
      if (device.opcuaNodes) return { ...defaults, ...JSON.parse(device.opcuaNodes) };
    } catch (e) {}
    return defaults;
  }

  async connect() {
    try {
      const { OPCUAClient } = require("node-opcua");
      const endpoint = `opc.tcp://${this.device.ip}:${this.device.port || 4840}`;
      this.client = OPCUAClient.create({ endpoint_must_exist: false });
      await this.client.connect(endpoint);
      this.session = await this.client.createSession();
      this.connected = true;
      console.log(`[opcua] connected to ${endpoint}`);
    } catch (e) {
      console.error(`[opcua] connect failed: ${e.message}`);
      this.connected = false;
    }
  }

  async read() {
    if (!this.session) {
      return { weight: 0, phase: "offline", bagCount: 0, connected: false };
    }
    try {
      const weightDataValue = await this.session.read({
        nodeId: this.nodes.weightNode,
      });
      const weight = weightDataValue.value.value;

      let phase = "idle";
      try {
        const statusDV = await this.session.read({
          nodeId: this.nodes.statusNode,
        });
        phase = this._mapPhase(statusDV.value.value);
      } catch (e) {}

      let bagCount = 0;
      try {
        const bagDV = await this.session.read({
          nodeId: this.nodes.bagCountNode,
        });
        bagCount = bagDV.value.value;
      } catch (e) {}

      return { weight, phase, bagCount, connected: true };
    } catch (e) {
      return { weight: 0, phase: "error", bagCount: 0, connected: false };
    }
  }

  _mapPhase(val) {
    if (typeof val === "number") {
      const phases = { 0: "idle", 1: "filling", 2: "settling", 3: "complete" };
      return phases[val] || "idle";
    }
    return String(val).toLowerCase();
  }

  async disconnect() {
    if (this.session) {
      try { await this.session.close(); } catch (e) {}
    }
    if (this.client) {
      try { await this.client.disconnect(); } catch (e) {}
    }
    this.connected = false;
  }
}

// ============================================================
// MQTT Driver
// Supports: AWS IoT, Azure IoT Hub, Mosquitto, HiveMQ, EMQX
// ============================================================
class MqttDriver extends BaseDriver {
  constructor(device) {
    super(device);
    this.client = null;
    this.latest = { weight: 0, phase: "idle", bagCount: 0, connected: false };
    this.config = this._parseConfig(device);
  }

  _parseConfig(device) {
    return {
      brokerUrl: device.mqttBroker || `mqtt://${device.ip}:${device.port || 1883}`,
      topic: device.mqttTopic || "scale/weight",
      username: device.mqttUsername || "",
      password: device.mqttPassword || "",
      clientId: device.mqttClientId || `scaleops-${device.id}`,
      qos: device.mqttQos || 0,
      weightField: device.mqttWeightField || "weight",
      phaseField: device.mqttPhaseField || "phase",
      bagCountField: device.mqttBagCountField || "bagCount",
      useTls: device.mqttTls || false,
    };
  }

  async connect() {
    try {
      const mqtt = require("mqtt");
      const opts = {
        clientId: this.config.clientId,
        clean: true,
        connectTimeout: 5000,
        reconnectPeriod: 3000,
      };
      if (this.config.username) opts.username = this.config.username;
      if (this.config.password) opts.password = this.config.password;

      this.client = mqtt.connect(this.config.brokerUrl, opts);

      this.client.on("connect", () => {
        console.log(`[mqtt] connected to ${this.config.brokerUrl}`);
        this.client.subscribe(this.config.topic, { qos: this.config.qos });
        this.connected = true;
      });

      this.client.on("message", (topic, message) => {
        try {
          const data = JSON.parse(message.toString());
          this.latest = {
            weight: Number(data[this.config.weightField]) || 0,
            phase: data[this.config.phaseField] || "idle",
            bagCount: Number(data[this.config.bagCountField]) || 0,
            connected: true,
          };
        } catch (e) {}
      });

      this.client.on("error", (err) => {
        console.error(`[mqtt] error: ${err.message}`);
        this.connected = false;
      });

      this.client.on("offline", () => {
        this.connected = false;
      });
    } catch (e) {
      console.error(`[mqtt] connect failed: ${e.message}`);
      this.connected = false;
    }
  }

  async read() {
    return { ...this.latest, connected: this.connected };
  }

  async disconnect() {
    if (this.client) {
      try { this.client.end(); } catch (e) {}
    }
    this.connected = false;
  }
}

// ============================================================
// EtherNet/IP Driver (Allen-Bradley / Rockwell)
// ============================================================
class EtherNetIPDriver extends BaseDriver {
  constructor(device) {
    super(device);
    this.client = null;
    this.tagConfig = this._parseTags(device);
  }

  _parseTags(device) {
    return {
      weightTag: device.enipWeightTag || "Weight",
      statusTag: device.enipStatusTag || "Status",
      bagCountTag: device.enipBagCountTag || "BagCount",
    };
  }

  async connect() {
    try {
      const { EtherNetIP } = require("ethernet-ip");
      this.client = new EtherNetIP();
      await this.client.connect(this.device.ip);
      this.connected = true;
      console.log(`[enip] connected to ${this.device.ip}`);
    } catch (e) {
      console.error(`[enip] connect failed: ${e.message}`);
      this.connected = false;
    }
  }

  async read() {
    if (!this.client || !this.connected) {
      return { weight: 0, phase: "offline", bagCount: 0, connected: false };
    }
    try {
      const weightTag = await this.client.readTag(this.tagConfig.weightTag);
      const weight = weightTag.value;

      let phase = "idle";
      try {
        const statusTag = await this.client.readTag(this.tagConfig.statusTag);
        phase = this._mapPhase(statusTag.value);
      } catch (e) {}

      let bagCount = 0;
      try {
        const bagTag = await this.client.readTag(this.tagConfig.bagCountTag);
        bagCount = bagTag.value;
      } catch (e) {}

      return { weight, phase, bagCount, connected: true };
    } catch (e) {
      return { weight: 0, phase: "error", bagCount: 0, connected: false };
    }
  }

  _mapPhase(val) {
    const phases = { 0: "idle", 1: "filling", 2: "settling", 3: "complete" };
    return phases[val] || "idle";
  }

  async disconnect() {
    if (this.client) {
      try { this.client.destroy(); } catch (e) {}
    }
    this.connected = false;
  }
}

// ============================================================
// PROFINET / S7 Driver (Siemens)
// ============================================================
class S7Driver extends BaseDriver {
  constructor(device) {
    super(device);
    this.client = null;
    this.config = this._parseConfig(device);
  }

  _parseConfig(device) {
    return {
      rack: device.s7Rack || 0,
      slot: device.s7Slot || 1,
      dbNumber: device.s7DbNumber || 1,
      weightStart: device.s7WeightStart || 0,
      weightSize: device.s7WeightSize || 4, // REAL = 4 bytes
      statusStart: device.s7StatusStart || 4,
      bagCountStart: device.s7BagCountStart || 6,
    };
  }

  async connect() {
    try {
      // Try nodes7 first, fall back to snap7
      try {
        const nodes7 = require("nodes7");
        this.client = new nodes7();
        this.client.initiateConnection({
          port: 102,
          host: this.device.ip,
          rack: this.config.rack,
          slot: this.config.slot,
        });
      } catch (e) {
        // nodes7 not available, use raw TCP
        const net = require("net");
        this.client = new net.Socket();
        await new Promise((resolve, reject) => {
          this.client.connect(102, this.device.ip, resolve);
          this.client.on("error", reject);
        });
      }
      this.connected = true;
      console.log(`[s7] connected to ${this.device.ip}`);
    } catch (e) {
      console.error(`[s7] connect failed: ${e.message}`);
      this.connected = false;
    }
  }

  async read() {
    if (!this.connected) {
      return { weight: 0, phase: "offline", bagCount: 0, connected: false };
    }
    try {
      // For real S7, use readArea to read DB block
      // Simplified: read raw bytes from the TCP socket
      if (this.client?.read) {
        const weight = await this.client.read(
          this.config.dbNumber,
          this.config.weightStart,
          this.config.weightSize
        );
        const status = await this.client.read(
          this.config.dbNumber,
          this.config.statusStart,
          2
        );
        const bagCount = await this.client.read(
          this.config.dbNumber,
          this.config.bagCountStart,
          2
        );
        return {
          weight: this._decodeFloat(weight),
          phase: this._mapPhase(status[0]),
          bagCount: bagCount[0] | (bagCount[1] << 8),
          connected: true,
        };
      }
      return { weight: 0, phase: "idle", bagCount: 0, connected: true };
    } catch (e) {
      return { weight: 0, phase: "error", bagCount: 0, connected: false };
    }
  }

  _decodeFloat(buf) {
    if (Buffer.isBuffer(buf) && buf.length >= 4) {
      return buf.readFloatBE(0);
    }
    return 0;
  }

  _mapPhase(val) {
    const phases = { 0: "idle", 1: "filling", 2: "settling", 3: "complete" };
    return phases[val] || "idle";
  }

  async disconnect() {
    if (this.client?.destroy) this.client.destroy();
    else if (this.client?.dropConnection) this.client.dropConnection();
    this.connected = false;
  }
}

// ============================================================
// SNMP Driver (network scales, printers, managed devices)
// ============================================================
class SNMPDriver extends BaseDriver {
  constructor(device) {
    super(device);
    this.session = null;
    this.oids = this._parseOids(device);
  }

  _parseOids(device) {
    return {
      weightOid: device.snmpWeightOid || "1.3.6.1.4.1.2020.1.1.1.0",
      statusOid: device.snmpStatusOid || "1.3.6.1.4.1.2020.1.1.2.0",
      bagCountOid: device.snmpBagCountOid || "1.3.6.1.4.1.2020.1.1.3.0",
      community: device.snmpCommunity || "public",
      version: device.snmpVersion || "2c",
    };
  }

  async connect() {
    try {
      const snmp = require("snmp-native");
      this.session = new snmp.Session({
        host: this.device.ip,
        port: this.device.port || 161,
        community: this.oids.community,
      });
      this.connected = true;
      console.log(`[snmp] connected to ${this.device.ip}`);
    } catch (e) {
      console.error(`[snmp] connect failed: ${e.message}`);
      this.connected = false;
    }
  }

  async read() {
    if (!this.session) {
      return { weight: 0, phase: "offline", bagCount: 0, connected: false };
    }
    try {
      const oids = [this.oids.weightOid, this.oids.statusOid, this.oids.bagCountOid];
      const varbinds = await new Promise((resolve, reject) => {
        this.session.get({ oids }, (err, varbinds) => {
          if (err) reject(err);
          else resolve(varbinds);
        });
      });

      const weight = varbinds[0]?.value || 0;
      const status = varbinds[1]?.value || 0;
      const bagCount = varbinds[2]?.value || 0;

      return {
        weight: Number(weight),
        phase: this._mapPhase(Number(status)),
        bagCount: Number(bagCount),
        connected: true,
      };
    } catch (e) {
      return { weight: 0, phase: "error", bagCount: 0, connected: false };
    }
  }

  _mapPhase(val) {
    const phases = { 0: "idle", 1: "filling", 2: "settling", 3: "complete" };
    return phases[val] || "idle";
  }

  async disconnect() {
    if (this.session) {
      try { this.session.close(); } catch (e) {}
    }
    this.connected = false;
  }
}

// ============================================================
// HTTP/REST API Driver (cloud scales, smart sensors)
// ============================================================
class RestDriver extends BaseDriver {
  constructor(device) {
    super(device);
    this.config = this._parseConfig(device);
    this.authHeader = null;
  }

  _parseConfig(device) {
    return {
      url: device.restUrl || `http://${device.ip}/api/weight`,
      method: device.restMethod || "GET",
      headers: device.restHeaders ? JSON.parse(device.restHeaders) : {},
      weightField: device.restWeightField || "weight",
      phaseField: device.restPhaseField || "phase",
      bagCountField: device.restBagCountField || "bagCount",
      authType: device.restAuthType || "none", // none, basic, bearer
      authUser: device.restAuthUser || "",
      authPass: device.restAuthPass || "",
      authToken: device.restAuthToken || "",
      interval: device.restInterval || 1000,
    };
  }

  async connect() {
    try {
      // Test connection
      const res = await fetch(this.config.url, {
        method: this.config.method,
        headers: this._getHeaders(),
        timeout: 5000,
      });
      this.connected = res.ok;
      console.log(`[rest] ${res.ok ? "connected" : "failed"} to ${this.config.url}`);
    } catch (e) {
      console.error(`[rest] connect failed: ${e.message}`);
      this.connected = false;
    }
  }

  _getHeaders() {
    const headers = { ...this.config.headers, "Content-Type": "application/json" };
    if (this.config.authType === "bearer" && this.config.authToken) {
      headers["Authorization"] = `Bearer ${this.config.authToken}`;
    } else if (this.config.authType === "basic") {
      const b64 = Buffer.from(`${this.config.authUser}:${this.config.authPass}`).toString("base64");
      headers["Authorization"] = `Basic ${b64}`;
    }
    return headers;
  }

  async read() {
    try {
      const res = await fetch(this.config.url, {
        method: this.config.method,
        headers: this._getHeaders(),
        timeout: 5000,
      });
      if (!res.ok) {
        return { weight: 0, phase: "error", bagCount: 0, connected: false };
      }
      const data = await res.json();
      return {
        weight: Number(data[this.config.weightField]) || 0,
        phase: data[this.config.phaseField] || "idle",
        bagCount: Number(data[this.config.bagCountField]) || 0,
        connected: true,
      };
    } catch (e) {
      return { weight: 0, phase: "error", bagCount: 0, connected: false };
    }
  }

  async disconnect() {
    this.connected = false;
  }
}

// ============================================================
// TCP Socket Driver (raw data from scales, barcode scanners)
// ============================================================
class TCPDriver extends BaseDriver {
  constructor(device) {
    super(device);
    this.socket = null;
    this.buffer = "";
    this.config = this._parseConfig(device);
  }

  _parseConfig(device) {
    return {
      port: device.tcpPort || 8080,
      delimiter: device.tcpDelimiter || "\\r\\n", // \r\n, \n, \0, or hex
      parseRegex: device.tcpParseRegex || "([\\d.]+)",
      encoding: device.tcpEncoding || "utf8",
      timeout: device.tcpTimeout || 3000,
    };
  }

  async connect() {
    try {
      const net = require("net");
      this.socket = new net.Socket();

      await new Promise((resolve, reject) => {
        this.socket.connect(this.config.port, this.device.ip, resolve);
        this.socket.on("error", reject);
        this.socket.setTimeout(this.config.timeout);
      });

      this.socket.on("data", (data) => {
        this.buffer += data.toString(this.config.encoding);
        const delim = this.config.delimiter.replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\0/g, "\0");
        while (this.buffer.includes(delim)) {
          const idx = this.buffer.indexOf(delim);
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + delim.length);
          this._parseLine(line);
        }
      });

      this.connected = true;
      console.log(`[tcp] connected to ${this.device.ip}:${this.config.port}`);
    } catch (e) {
      console.error(`[tcp] connect failed: ${e.message}`);
      this.connected = false;
    }
  }

  _parseLine(line) {
    try {
      if (this.config.parseRegex) {
        const match = line.match(new RegExp(this.config.parseRegex));
        if (match) {
          this.latest = {
            weight: Number(match[1]) || 0,
            phase: match[2] || "idle",
            bagCount: Number(match[3]) || 0,
            connected: true,
          };
        }
      } else {
        // Try JSON parse
        const data = JSON.parse(line);
        this.latest = {
          weight: Number(data.weight) || 0,
          phase: data.phase || "idle",
          bagCount: Number(data.bagCount) || 0,
          connected: true,
        };
      }
    } catch (e) {}
  }

  async read() {
    return this.latest || { weight: 0, phase: "offline", bagCount: 0, connected: this.connected };
  }

  async disconnect() {
    if (this.socket) {
      try { this.socket.destroy(); } catch (e) {}
    }
    this.connected = false;
  }
}

// ============================================================
// Serial / RS232/RS485 Driver (legacy scales, weigh terminals)
// ============================================================
class SerialDriver extends BaseDriver {
  constructor(device) {
    super(device);
    this.port = null;
    this.buffer = "";
    this.latest = { weight: 0, phase: "idle", bagCount: 0, connected: false };
    this.config = this._parseConfig(device);
  }

  _parseConfig(device) {
    return {
      serialPort: device.serialPort || "/dev/ttyUSB0",
      baudRate: device.baudRate || 9600,
      dataBits: device.serialDataBits || 8,
      stopBits: device.serialStopBits || 1,
      parity: device.serialParity || "none",
      parseRegex: device.serialParseRegex || "([\\d.]+)",
      encoding: device.serialEncoding || "utf8",
    };
  }

  async connect() {
    try {
      const { SerialPort } = require("serialport");
      const { ReadlineParser } = require("@serialport/parser-readline");

      this.port = new SerialPort({
        path: this.config.serialPort,
        baudRate: this.config.baudRate,
        dataBits: this.config.dataBits,
        stopBits: this.config.stopBits,
        parity: this.config.parity,
      });

      const parser = this.port.pipe(new ReadlineParser({ delimiter: "\r\n" }));
      parser.on("data", (line) => {
        this._parseLine(line.trim());
      });

      this.port.on("open", () => {
        this.connected = true;
        console.log(`[serial] connected to ${this.config.serialPort}`);
      });

      this.port.on("error", (err) => {
        console.error(`[serial] error: ${err.message}`);
        this.connected = false;
      });
    } catch (e) {
      console.error(`[serial] connect failed: ${e.message}`);
      this.connected = false;
    }
  }

  _parseLine(line) {
    try {
      if (this.config.parseRegex) {
        const match = line.match(new RegExp(this.config.parseRegex));
        if (match) {
          this.latest = {
            weight: Number(match[1]) || 0,
            phase: match[2] || "idle",
            bagCount: Number(match[3]) || 0,
            connected: true,
          };
        }
      }
    } catch (e) {}
  }

  async read() {
    return { ...this.latest, connected: this.connected };
  }

  async disconnect() {
    if (this.port) {
      try { await this.port.close(); } catch (e) {}
    }
    this.connected = false;
  }
}

// ============================================================
// Driver Registry
// ============================================================
const REGISTRY = {
  "Modbus TCP": ModbusDriver,
  "Modbus RTU": ModbusDriver,
  "OPC-UA": OpcUaDriver,
  MQTT: MqttDriver,
  "EtherNet/IP": EtherNetIPDriver,
  PROFINET: S7Driver,
  S7: S7Driver,
  SNMP: SNMPDriver,
  "REST API": RestDriver,
  HTTP: RestDriver,
  "TCP Socket": TCPDriver,
  "Raw TCP": TCPDriver,
  Serial: SerialDriver,
  RS232: SerialDriver,
  RS485: SerialDriver,
  Simulator: BaseDriver,
};

function createDriver(device) {
  const DriverClass = REGISTRY[device.protocol] || BaseDriver;
  return new DriverClass(device);
}

module.exports = {
  createDriver,
  REGISTRY,
  getSupportedProtocols: () => Object.keys(REGISTRY),
  BaseDriver,
  ModbusDriver,
  OpcUaDriver,
  MqttDriver,
  EtherNetIPDriver,
  S7Driver,
  SNMPDriver,
  RestDriver,
  TCPDriver,
  SerialDriver,
};
