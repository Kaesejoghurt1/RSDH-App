// BLE transport for the PWA remote (ticket 04).
// Web Bluetooth over the Nordic UART Service (NUS). Not covered by unit
// tests by agreement — model.js is the tested seam; this module is thin
// plumbing around the browser API and is exercised by the local verify run.

const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RXD = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';  // app -> device
const NUS_TXD = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';  // device -> app

const RECONNECT_DELAY_MS = 2000;

export function isWebBluetoothSupported() {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

// createBle({ onLine, onStatus, shouldReconnect })
//   onLine(line)        fired for every complete line from the device
//   onStatus(s)         'connecting' | 'connected' | 'disconnected'
//   shouldReconnect()   polled after a disconnect; true -> keep retrying
//                       via getDevices() (no chooser, no user gesture)
export function createBle({ onLine, onStatus, shouldReconnect = () => false }) {
  let device = null;
  let rxd = null;
  let lineBuf = '';
  let reconnectTimer = null;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  async function connect() {
    // Must be called from a user gesture (pointerup/click/touchend).
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS_SERVICE] }],
    });
    device = dev;
    device.addEventListener('gattserverdisconnected', handleDisconnected);
    await connectGatt();
  }

  async function connectGatt() {
    onStatus('connecting');
    const server = await device.gatt.connect();
    // GATT attributes are invalidated on every disconnect — re-get them all.
    const service = await server.getPrimaryService(NUS_SERVICE);
    rxd = await service.getCharacteristic(NUS_RXD);
    const txd = await service.getCharacteristic(NUS_TXD);
    await txd.startNotifications();
    txd.addEventListener('characteristicvaluechanged', handleNotify);
    lineBuf = '';
    onStatus('connected');
  }

  function handleNotify(event) {
    // The device writes one notification per line, but the BLE stack may
    // split a notification across packets — reassemble into lines.
    lineBuf += decoder.decode(event.target.value, { stream: true });
    let nl = lineBuf.indexOf('\n');
    while (nl >= 0) {
      const line = lineBuf.slice(0, nl).replace(/\r+$/, '').trim();
      lineBuf = lineBuf.slice(nl + 1);
      if (line) onLine(line);
      nl = lineBuf.indexOf('\n');
    }
  }

  function handleDisconnected() {
    rxd = null;
    onStatus('disconnected');
    if (shouldReconnect()) scheduleReconnect();
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(tryReconnect, RECONNECT_DELAY_MS);
  }

  async function tryReconnect() {
    reconnectTimer = null;
    if (!device || !shouldReconnect()) return;
    try {
      const devices = await navigator.bluetooth.getDevices();
      const known = devices.find((d) => d.id === device.id);
      if (!known) return;
      await connectGatt();
    } catch {
      scheduleReconnect();  // out of range / window closed: keep retrying
    }
  }

  async function send(line) {
    if (!rxd) throw new Error('Nicht verbunden');
    await rxd.writeValue(encoder.encode(line + '\n'));
  }

  return {
    connect,
    send,
    get deviceName() {
      return device ? device.name : null;
    },
  };
}
