// UI wiring for the PWA remote — "Die Brücke" cockpit.
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
  windowChip: $('window-chip'),
  settingsBtn: $('settings-btn'),
  settings: $('settings'),
  master: $('master'),
  btnEmoji: $('btn-emoji'),
  btnLabel: $('btn-label'),
  btnSub: $('btn-sub'),
  runinfo: $('runinfo'),
  statusline: $('statusline'),
  wake: $('wake'),
  gWin: $('g-win'),
  gWinTxt: $('g-win-txt'),
  gTank: $('g-tank'),
  gTankTxt: $('g-tank-txt'),
  ledG: $('led-g'),
  ledR: $('led-r'),
  ledB: $('led-b'),
  log: $('log'),
  logcount: $('logcount'),
  hint: $('hint'),
  paramOneshot: $('param-oneshot'),
  paramVollvoraus: $('param-vollvoraus'),
  paramSalven: $('param-salven'),
  vvS: $('vv-s'),
  vvOut: $('vv-out'),
  svInt: $('sv-int'),
  svIntOut: $('sv-int-out'),
  svDur: $('sv-dur'),
  svDurOut: $('sv-dur-out'),
  svN: $('sv-n'),
  svNOut: $('sv-n-out'),
  svCalc: $('sv-calc'),
  setWindow: $('set-window'),
  setWindowOut: $('set-window-out'),
  setLedG: $('set-led-g'),
  setLedR: $('set-led-r'),
  setLedB: $('set-led-b'),
};

const model = createModel();
let ble = null;
let everConnected = false;
let disconnectHint = null; // 'lost' | 'closed' | null
let selectedMode = 'oneshot';
let maxOnFlashUntil = 0;

const MAX_TANK_S = 180;
const WINDOW_DURATION_MIN_S = 30;
const WINDOW_DURATION_MAX_S = 3600;

const MODE_LABELS = {
  oneshot: 'Einzelschuss 💨',
  vollvoraus: 'Voll voraus! ⚓',
  salven: 'Salvenfeuer 🎇',
};

const FOG_LABELS = {
  unknown: 'Unbekannt',
  idle: 'Bereit',
  oneshot: 'Einzelschuss läuft',
  continuous: 'Dauerbetrieb',
  timed: 'Voll voraus!',
  periodic: 'Salvenfeuer',
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

/* ---------- Logbuch ---------- */
const logLines = [];
function logLine(cls, text) {
  const t = new Date();
  const time = [t.getHours(), t.getMinutes(), t.getSeconds()]
    .map((n) => String(n).padStart(2, '0')).join(':');
  logLines.push({ cls, text, time });
  if (logLines.length > 400) logLines.shift();
  renderLog();
}

function renderLog() {
  const html = logLines.map((l) =>
    '<div class="ln ' + l.cls + '"><span class="lt">' + l.time + '</span> ' + l.text + '</div>').join('\n');
  el.log.innerHTML = html;
  el.log.scrollTop = el.log.scrollHeight;
  el.logcount.textContent = '(' + logLines.length + ')';
}

/* ---------- Rendering ---------- */
const fmt = (s) => {
  s = Math.max(0, Math.ceil(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0')
               : m + ':' + String(ss).padStart(2, '0');
};

function modeSummary() {
  if (selectedMode === 'oneshot') return '10s';
  if (selectedMode === 'vollvoraus') return el.vvS.value + 's';
  return el.svInt.value + 's/' + el.svDur.value + 's ×' + el.svN.value;
}

function effSalven() {
  const dur = Number(el.svDur.value);
  return Math.max(1, Math.min(Number(el.svN.value), Math.floor(MAX_TANK_S / dur)));
}

function runinfoText() {
  const s = model.state;
  if (s.fog === 'idle' || s.fog === 'unknown') {
    return 'Bereit — ' + MODE_LABELS[selectedMode] + ' (' + modeSummary() + ')';
  }
  const left = model.fogRemaining();
  if (s.fog === 'oneshot') return 'Einzelschuss läuft · noch ' + (left ?? '?') + 's';
  if (s.fog === 'timed') return 'Voll voraus! · noch ' + (left ?? '?') + 's';
  if (s.fog === 'continuous') return 'Dauerbetrieb läuft';
  if (s.fog === 'periodic' && s.periodic) {
    const p = s.periodic;
    return p.phase === 'fog'
      ? 'Salve ' + p.current + '/' + p.total + ' · NEBEL · noch ' + (left ?? '?') + 's'
      : 'Salve ' + p.current + '/' + p.total + ' beendet · nächste in ' + (left ?? '?') + 's';
  }
  return 'Läuft…';
}

function statusText() {
  const s = model.state;
  if (s.fog === 'unknown') return 'status: –';
  if (s.fog === 'idle') return 'status: idle';
  if (s.fog === 'oneshot') return 'status: oneshot ' + (model.fogRemaining() ?? '?') + 's';
  if (s.fog === 'timed') return 'status: on ' + (model.fogRemaining() ?? '?') + 's';
  if (s.fog === 'continuous') return 'status: continuous';
  if (s.fog === 'periodic' && s.periodic) {
    const p = s.periodic;
    return 'status: periodic ' + p.current + '/' + p.total + ' '
      + (p.intervalS ?? '?') + 's/' + (p.durationS ?? '?') + 's '
      + (p.phase === 'fog' ? 'fog' : 'wait') + ' ' + (model.fogRemaining() ?? '?') + 's';
  }
  return 'status: …';
}

function render() {
  const s = model.state;
  const running = s.fog !== 'idle' && s.fog !== 'unknown';
  const fogging = s.fog === 'oneshot' || s.fog === 'continuous' || s.fog === 'timed'
    || (s.fog === 'periodic' && s.periodic?.phase === 'fog');

  document.body.classList.toggle('fogging', fogging);
  document.body.classList.toggle('running', running);
  document.body.classList.toggle('window-closed', s.window === 'closed');

  // Master telegraph button
  el.master.classList.toggle('is-on', running);
  el.btnEmoji.textContent = running ? '🤯' : '💨';
  el.btnLabel.textContent = running ? 'STOPP' : 'NEBEL!';
  el.btnSub.textContent = running ? runinfoText() : MODE_LABELS[selectedMode] + ' · ' + modeSummary();

  // Window chip + gauge
  const winLeft = model.windowRemaining();
  el.windowChip.textContent = s.window === 'open'
    ? 'Fenster ' + fmt(winLeft)
    : (s.window === 'closed' ? 'RADIO AUS' : 'Fenster –');
  const winFrac = s.window === 'open' && model.state.windowDurationS
    ? Math.min(1, winLeft / model.state.windowDurationS) : 0;
  el.gWin.setAttribute('stroke-dashoffset', String(100 - winFrac * 100));
  el.gWinTxt.textContent = s.window === 'open' ? fmt(winLeft) : (s.window === 'closed' ? 'AUS' : '–');

  // Tank gauge
  const tankFrac = s.tankS == null ? 0 : Math.min(1, s.tankS / MAX_TANK_S);
  el.gTank.setAttribute('stroke-dashoffset', String(100 - tankFrac * 100));
  el.gTankTxt.textContent = s.tankS == null ? '–' : Math.ceil(s.tankS) + 's';

  // Lamps
  el.ledG.classList.toggle('on', fogging && (s.led?.g ?? true));
  el.ledB.classList.toggle('on', s.window === 'open' && (s.led?.b ?? true));
  if (Date.now() > maxOnFlashUntil) el.ledR.classList.remove('flash');

  // Mode params visibility + lock while running
  el.paramOneshot.classList.toggle('hidden', selectedMode !== 'oneshot');
  el.paramVollvoraus.classList.toggle('hidden', selectedMode !== 'vollvoraus');
  el.paramSalven.classList.toggle('hidden', selectedMode !== 'salven');
  const lock = running;
  document.querySelectorAll('input[name=mode]').forEach((i) => { i.disabled = lock; });
  el.vvS.disabled = lock;
  el.svInt.disabled = lock;
  el.svDur.disabled = lock;
  el.svN.disabled = lock;

  el.runinfo.textContent = runinfoText();
  el.statusline.textContent = statusText();

  el.wake.classList.toggle('hidden', s.window !== 'closed');

  // Keep the disconnect hint honest when the window runs out mid-retry.
  if (disconnectHint === 'lost' && !shouldReconnect()) showDisconnectHint('closed');
}

function renderParams() {
  el.vvOut.textContent = el.vvS.value + 's';
  el.svIntOut.textContent = el.svInt.value + 's';
  el.svDurOut.textContent = el.svDur.value + 's';
  el.svNOut.textContent = '×' + el.svN.value;
  el.svCalc.textContent = 'Vorrat (180s) reicht für ' + effSalven() + ' Salven';
}

function flashRed() {
  maxOnFlashUntil = Date.now() + 2600;
  el.ledR.classList.remove('flash');
  void el.ledR.offsetWidth;
  el.ledR.classList.add('flash');
}

function ingest(line) {
  const d = model.ingest(line);
  if (d) {
    if (d.type === 'event') {
      logLine('ev', 'event: ' + d.name);
      if (d.name === 'max-on') flashRed();
    } else if (d.type === 'err' && d.command !== null) {
      logLine('er', '< ' + d.line);
      showHint('Gerät lehnte ab: ' + d.line.slice(5));
    } else if (d.type === 'ok' && d.command !== null) {
      logLine('rx', '< ok');
    } else if (d.type === 'duration' && !durationDirty && document.activeElement !== el.setWindow) {
      el.setWindow.value = d.seconds;
      el.setWindowOut.textContent = d.seconds + 's';
    }
  }
  render();
}

/* ---------- Commands ---------- */
// Queries sync state without an ack expectation; every other command is
// a user action the firmware answers with ok/err:. After an action the
// app re-syncs with "status" so the local countdowns restart from fresh
// device values (remote shot/on/off produce no event line).
const QUERY_COMMANDS = new Set(['status', 'ble status']);

async function sendCommand(cmd) {
  logLine('tx', '> ' + cmd);
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

function masterPress() {
  const s = model.state;
  if (s.fog !== 'idle' && s.fog !== 'unknown') {
    sendCommand('off');
    return;
  }
  if (selectedMode === 'oneshot') sendCommand('shot');
  else if (selectedMode === 'vollvoraus') sendCommand('on ' + el.vvS.value);
  else sendCommand('periodic ' + el.svInt.value + ' ' + el.svDur.value + ' ' + el.svN.value);
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

/* ---------- Settings dialog ---------- */
let durationDirty = false;

function applyLedConfig() {
  const s = model.state;
  el.setLedG.checked = s.led?.g ?? true;
  el.setLedR.checked = s.led?.r ?? true;
  el.setLedB.checked = s.led?.b ?? true;
  render();
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

  el.master.addEventListener('click', masterPress);

  document.querySelectorAll('input[name=mode]').forEach((i) => {
    i.addEventListener('change', () => {
      selectedMode = i.value;
      render();
    });
  });

  [el.vvS, el.svInt, el.svDur, el.svN].forEach((i) => {
    i.addEventListener('input', renderParams);
  });

  el.wake.addEventListener('click', () => {
    // The window is closed — only the physical button can re-open it.
    showHint('Fenster ist zu. Am Gerät den Knopf drücken, dann „Gerät verbinden".');
  });

  el.settingsBtn.addEventListener('click', () => {
    applyLedConfig();
    el.settings.showModal();
  });

  el.setWindow.addEventListener('input', () => {
    durationDirty = true;
    el.setWindowOut.textContent = el.setWindow.value + 's';
  });

  el.setWindow.addEventListener('change', () => {
    const v = Number(el.setWindow.value);
    if (!Number.isInteger(v) || v < WINDOW_DURATION_MIN_S || v > WINDOW_DURATION_MAX_S) {
      showHint('Fensterdauer muss zwischen ' + WINDOW_DURATION_MIN_S
        + ' und ' + WINDOW_DURATION_MAX_S + ' liegen.');
      return;
    }
    sendCommand('ble window ' + v).then(() => { durationDirty = false; });
  });

  [el.setLedG, el.setLedR, el.setLedB].forEach((cb, idx) => {
    const channel = ['g', 'r', 'b'][idx];
    cb.addEventListener('change', () => {
      sendCommand('led ' + channel + '=' + (cb.checked ? '1' : '0'));
    });
  });

  // Live countdown, purely local — no traffic.
  setInterval(render, 1000);
  renderParams();
  render();
}

init();
