// UI wiring for the PWA remote (ticket 04).
// Glues the BLE transport (ble.js) to the device model (model.js).
// Sync rule: the app sends "status" and "ble status" on connect and
// "status" after every user action — never on a timer (every received
// command restarts the firmware's window countdown; polling would keep
// the window alive).

import { createModel } from './model.js';
import { createBle, isWebBluetoothSupported } from './ble.js';

const $ = (id) => document.getElementById(id);

const el = {
  status: $('status'),
  unsupported: $('unsupported'),
  connect: $('connect'),
  controls: $('controls'),
  fogState: $('fog-state'),
  fogRemaining: $('fog-remaining'),
  windowState: $('window-state'),
  shot: $('shot'),
  continuous: $('continuous'),
  duration: $('duration'),
  setDuration: $('set-duration'),
  hint: $('hint'),
  log: $('log'),
};

const model = createModel();
let ble = null;
let everConnected = false;
let durationDirty = false; // user typed in the duration field — don't overwrite
let disconnectHint = null; // 'lost' | 'closed' | null

const WINDOW_DURATION_MIN_S = 30;
const WINDOW_DURATION_MAX_S = 3600;

const FOG_LABELS = {
  unknown: 'Unbekannt',
  idle: 'Bereit',
  oneshot: 'Einmal-Nebel läuft',
  continuous: 'Dauerbetrieb',
};

function setStatus(text, cls) {
  el.status.textContent = text;
  el.status.className = 'status' + (cls ? ' ' + cls : '');
}

function showHint(text) {
  el.hint.textContent = text;
  el.hint.classList.remove('hidden');
}

function clearHint() {
  disconnectHint = null;
  el.hint.classList.add('hidden');
}

function showDisconnectHint(kind) {
  disconnectHint = kind;
  showHint(kind === 'lost'
    ? 'Verbindung verloren – verbinde neu, solange das Fenster offen ist…'
    : 'Fenster ist zu. Am Gerät den Knopf drücken, dann „Gerät verbinden".');
}

function logEvent(name, at) {
  const li = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = new Date(at).toLocaleTimeString('de-DE');
  const text = document.createElement('span');
  text.textContent = name;
  li.append(time, text);
  el.log.prepend(li);
  while (el.log.children.length > 100) el.log.lastChild.remove();
}

function renderFog() {
  el.fogState.textContent = FOG_LABELS[model.state.fog] ?? model.state.fog;
  el.fogState.className = 'pill ' + model.state.fog;
  const left = model.fogRemaining();
  if (left === null) {
    el.fogRemaining.classList.add('hidden');
  } else {
    el.fogRemaining.textContent = left + ' s';
    el.fogRemaining.classList.remove('hidden');
  }
  const running = model.state.fog === 'continuous';
  el.continuous.textContent = running ? 'Dauerbetrieb stoppen' : 'Dauerbetrieb starten';
  el.continuous.classList.toggle('stop', running);
}

function renderWindow() {
  if (model.state.window === 'unknown') {
    el.windowState.textContent = 'Fenster: –';
    return;
  }
  const left = model.windowRemaining();
  el.windowState.textContent = left > 0 ? 'Fenster: ' + left + ' s offen' : 'Fenster: zu';
}

function render() {
  renderFog();
  renderWindow();
  // Keep the disconnect hint honest when the window runs out mid-retry.
  if (disconnectHint === 'lost' && !shouldReconnect()) showDisconnectHint('closed');
}

function ingest(line) {
  const d = model.ingest(line);
  if (d) {
    if (d.type === 'event') {
      logEvent(d.name, d.at);
    } else if (d.type === 'err' && d.command !== null) {
      showHint('Gerät lehnte ab: ' + d.line.slice(5));
    } else if (d.type === 'ok' && d.command !== null && d.command.startsWith('ble window ')) {
      showHint('Fensterdauer gespeichert.');
    } else if (d.type === 'duration' && !durationDirty && document.activeElement !== el.duration) {
      el.duration.value = d.seconds;
    }
  }
  render();
}

// Queries sync state without an ack expectation; every other command is
// a user action the firmware answers with ok/err:. After an action the
// app re-syncs with "status" so the local countdowns restart from fresh
// device values (remote shot/on/off produce no event line).
const QUERY_COMMANDS = new Set(['status', 'ble status']);

async function sendCommand(cmd) {
  const isQuery = QUERY_COMMANDS.has(cmd);
  if (!isQuery) model.expect(cmd);
  try {
    await ble.send(cmd);
    if (!isQuery) await ble.send('status');
  } catch (e) {
    model.expect(null);  // the command never left — no ack will arrive
    showHint('Senden fehlgeschlagen: ' + e.message);
  }
}

// Reconnect only while the model still believes the window is open.
function shouldReconnect() {
  return model.windowRemaining() > 0;
}

function onBleStatus(s) {
  if (s === 'connecting') {
    setStatus('Verbinde…', 'connecting');
  } else if (s === 'connected') {
    everConnected = true;
    clearHint();
    setStatus('Verbunden (' + (ble.deviceName ?? 'RSDoktorhut') + ')', 'connected');
    el.controls.classList.remove('hidden');
    el.connect.classList.add('hidden');
    // Initial sync: fog state, then window state + configured duration.
    sendCommand('status').then(() => sendCommand('ble status'));
  } else {
    setStatus('Getrennt', '');
    el.connect.classList.remove('hidden');
    if (everConnected) showDisconnectHint(shouldReconnect() ? 'lost' : 'closed');
  }
}

function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url));
  }

  if (!isWebBluetoothSupported()) {
    el.unsupported.classList.remove('hidden');
    el.connect.disabled = true;
    return;
  }

  ble = createBle({ onLine: ingest, onStatus: onBleStatus, shouldReconnect });

  el.connect.addEventListener('click', async () => {
    try {
      await ble.connect();
    } catch (e) {
      if (e.name === 'NotFoundError') return;  // chooser dismissed
      showHint('Verbinden fehlgeschlagen. Ist das Fenster offen? Am Gerät den Knopf drücken.');
    }
  });

  el.shot.addEventListener('click', () => sendCommand('shot'));
  el.continuous.addEventListener('click', () => {
    sendCommand(model.state.fog === 'continuous' ? 'off' : 'on');
  });
  el.setDuration.addEventListener('click', () => {
    const v = Number(el.duration.value);
    if (!Number.isInteger(v) || v < WINDOW_DURATION_MIN_S || v > WINDOW_DURATION_MAX_S) {
      showHint('Fensterdauer muss eine ganze Zahl zwischen '
        + WINDOW_DURATION_MIN_S + ' und ' + WINDOW_DURATION_MAX_S + ' sein.');
      return;
    }
    sendCommand('ble window ' + v);
  });
  el.duration.addEventListener('input', () => { durationDirty = true; });

  // Live countdown, purely local — no traffic.
  setInterval(render, 1000);
}

init();
