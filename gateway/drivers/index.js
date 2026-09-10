// Every driver implements the same tiny interface:
//   connect()  -> establishes the protocol-specific connection
//   read()     -> returns { weight, phase, bagCount, connected }
//   disconnect() -> tears the connection down
//
// This is the seam where real hardware plugs in. Right now every driver
// delegates to the shared simulator (drivers/simulator.js) so the whole stack
// runs end-to-end without hardware. Swap the body of read() for a real
// register/tag read when you're ready — the rest of the app never needs to change.

const sim = require("./simulator");

class BaseDriver {
  constructor(device) {
    this.device = device;
    this.state = sim.createSimState(device.target);
  }
  async connect() {
    // e.g. open a TCP socket, log in, subscribe to a topic — protocol specific
  }
  async read() {
    sim.step(this.state, this.device.target);
    return { ...this.state };
  }
  async disconnect() {}
}

class ModbusDriver extends BaseDriver {
  // Real version: `const ModbusRTU = require("modbus-serial"); const client = new ModbusRTU();`
  // await client.connectTCP(device.ip, { port: 502 }); client.setID(1);
  // const res = await client.readHoldingRegisters(WEIGHT_REGISTER, 2);
  // decode the 32-bit float/int per the scale's register map.
}

class OpcUaDriver extends BaseDriver {
  // Real version: `const { OPCUAClient } = require("node-opcua");`
  // connect to opc.tcp://<ip>:4840, create a session, browse or directly
  // read the configured NodeId for weight (and any other exposed tags).
}

class RestDriver extends BaseDriver {
  // Real version: periodic `fetch(`http://${device.ip}/api/weight`)` against
  // whatever the scale controller's vendor REST API exposes, then map its
  // JSON response fields into { weight, phase, bagCount, connected }.
}

class MqttDriver extends BaseDriver {
  // Real version: `const mqtt = require("mqtt"); const client = mqtt.connect(...)`
  // subscribe to the device's topic once in connect(), keep the latest
  // message in `this.state`, and have read() just return it (push, not poll).
}

const REGISTRY = {
  "Modbus TCP": ModbusDriver,
  "OPC-UA": OpcUaDriver,
  "REST API": RestDriver,
  MQTT: MqttDriver,
};

function createDriver(device) {
  const DriverClass = REGISTRY[device.protocol] || BaseDriver;
  return new DriverClass(device);
}

module.exports = { createDriver };
