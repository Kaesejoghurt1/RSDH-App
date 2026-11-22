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
//                       via gatt.connect() on the held device (no chooser)
export function createBle({ onLine, onStatus, shouldReconnect = () => false }) {
  let device = null;
  let rxd = null;
  let lineBuf = '';
  let reconnectTimer = null;
  let lastStatus = 'disconnected';
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // Idempotent status reporting — handleDisconnected() can now be invoked
  // from send() as well as from the gattserverdisconnected event, and a
  // late duplicate event must not re-trigger side effects.
  function setStatus(s) {
    if (s === lastStatus) return;
    lastStatus = s;
    onStatus(s);
  }

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
    setStatus('connecting');
    // Chrome can hold a stale gatt.connected=true after the radio link died
    // (e.g. Android Bluetooth toggled off/on); connect() is then a no-op
    // served from cache. Force-drop the zombie first so connect() has to
    // establish a real link.
    if (device.gatt.connected) device.gatt.disconnect();
    const server = await device.gatt.connect();
    // GATT attributes are invalidated on every disconnect — re-get them all.
    const service = await server.getPrimaryService(NUS_SERVICE);
    rxd = await service.getCharacteristic(NUS_RXD);
    const txd = await service.getCharacteristic(NUS_TXD);
    await txd.startNotifications();
    txd.addEventListener('characteristicvaluechanged', handleNotify);
    lineBuf = '';
    setStatus('connected');
    // A reconnect timer scheduled before this success would fire 2 s later
    // and force-disconnect the fresh link — cancel it.
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
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
    // The force-disconnect in connectGatt() fires this event while a
    // connect attempt is in flight — that drop is self-inflicted, not a
    // lost link. Swallow it so it cannot schedule a reconnect that would
    // kill the fresh connection.
    if (lastStatus === 'connecting') return;
    rxd = null;
    setStatus('disconnected');
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
      // Reconnect directly on the held device object — no chooser, no
      // user gesture. Never consult getDevices(): Chrome can omit the
      // device there, which silently killed the retry loop.
      await connectGatt();
    } catch (e) {
      console.warn('[ble] reconnect failed, retrying', e);
      scheduleReconnect();  // out of range / window closed: keep retrying
    }
  }

  async function send(line) {
    if (!rxd) throw new Error('Nicht verbunden');
    try {
      await rxd.writeValue(encoder.encode(line + '\n'));
    } catch (e) {
      // Chrome does not reliably fire gattserverdisconnected when the link
      // dies silently (e.g. Android Bluetooth toggled off/on) — the failed
      // GATT write is the real signal. Route it through the disconnect path
      // so the reconnect loop engages instead of a zombie "connected".
      handleDisconnected();
      throw e;
    }
  }

  return {
    connect,
    send,
    get deviceName() {
      return device ? device.name : null;
    },
  };
}
