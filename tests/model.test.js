// Device model tests — the pre-agreed test seam for the PWA (ticket 04).
// The model parses firmware reply lines (see tests/fake_board.py and
// firmware/atomizer/atomizer.ino for the exact literals) into UI state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from '../js/model.js';

test('status: idle sets fog state to idle', () => {
  const model = createModel();
  model.ingest('status: idle');
  assert.equal(model.state.fog, 'idle');
});

test('status: oneshot <N>s sets fog state to oneshot with remaining seconds', () => {
  const model = createModel();
  model.ingest('status: oneshot 12s');
  assert.equal(model.state.fog, 'oneshot');
  assert.equal(model.state.fogRemainingS, 12);
});

test('status: continuous sets fog state to continuous', () => {
  const model = createModel();
  model.ingest('status: continuous');
  assert.equal(model.state.fog, 'continuous');
});

test('window: open <N>s sets window open with remaining seconds', () => {
  const model = createModel();
  model.ingest('window: open 600s');
  assert.equal(model.state.window, 'open');
  assert.equal(model.state.windowRemainingS, 600);
});

test('window: closed sets window closed', () => {
  const model = createModel();
  model.ingest('window: open 600s');
  model.ingest('window: closed');
  assert.equal(model.state.window, 'closed');
});

test('window: duration <N>s stores the configured duration', () => {
  const model = createModel();
  model.ingest('window: duration 600s');
  assert.equal(model.state.windowDurationS, 600);
});

test('event: <name> appends a timestamped entry to the event log', () => {
  const model = createModel();
  const before = Date.now();
  model.ingest('event: shot');
  const after = Date.now();
  assert.equal(model.state.events.length, 1);
  assert.equal(model.state.events[0].name, 'shot');
  assert.ok(model.state.events[0].at >= before && model.state.events[0].at <= after);
});

test('event log keeps insertion order across multiple events', () => {
  const model = createModel();
  model.ingest('event: shot');
  model.ingest('event: shot-done');
  model.ingest('event: off');
  assert.deepEqual(model.state.events.map((e) => e.name), ['shot', 'shot-done', 'off']);
});

test('ok acknowledges the pending command', () => {
  const model = createModel();
  model.expect('shot');
  const d = model.ingest('ok');
  assert.deepEqual(d, { type: 'ok', command: 'shot' });
  assert.equal(model.state.pendingCommand, null);
});

test('err: unknown command is reported as the pending command failure', () => {
  const model = createModel();
  model.expect('on');
  const d = model.ingest('err: unknown command');
  assert.deepEqual(d, { type: 'err', line: 'err: unknown command', command: 'on' });
  assert.equal(model.state.pendingCommand, null);
});

test('err: window 30-3600 is reported as the pending command failure', () => {
  const model = createModel();
  model.expect('ble window 9999');
  const d = model.ingest('err: window 30-3600');
  assert.deepEqual(d, { type: 'err', line: 'err: window 30-3600', command: 'ble window 9999' });
  assert.equal(model.state.pendingCommand, null);
});

test('windowRemaining() counts down from the last window: open sync', () => {
  let t = 1_000_000;
  const model = createModel({ now: () => t });
  model.ingest('window: open 600s');
  assert.equal(model.windowRemaining(), 600);
  t += 599_999;
  assert.equal(model.windowRemaining(), 1);
  t += 1;
  assert.equal(model.windowRemaining(), 0);
  t += 100_000;
  assert.equal(model.windowRemaining(), 0);
});

test('windowRemaining() returns 0 when the window is closed', () => {
  let t = 1_000_000;
  const model = createModel({ now: () => t });
  model.ingest('window: open 600s');
  model.ingest('window: closed');
  t += 5_000;
  assert.equal(model.windowRemaining(), 0);
});

test('windowRemaining() returns 0 before any window line was seen', () => {
  const model = createModel();
  assert.equal(model.windowRemaining(), 0);
});

test('event: shot puts the fog state oneshot', () => {
  const model = createModel();
  model.ingest('status: idle');
  model.ingest('event: shot');
  assert.equal(model.state.fog, 'oneshot');
});

test('event: shot-done, event: max-on and event: off put the fog state idle', () => {
  const model = createModel();
  model.ingest('status: continuous');
  model.ingest('event: shot-done');
  assert.equal(model.state.fog, 'idle');
  model.ingest('status: continuous');
  model.ingest('event: max-on');
  assert.equal(model.state.fog, 'idle');
  model.ingest('status: continuous');
  model.ingest('event: off');
  assert.equal(model.state.fog, 'idle');
});

test('unknown event names still land in the log without touching fog state', () => {
  const model = createModel();
  model.ingest('status: continuous');
  model.ingest('event: something-new');
  assert.equal(model.state.fog, 'continuous');
  assert.equal(model.state.events.length, 1);
});

test('fogRemaining() counts down from the last status: oneshot sync', () => {
  let t = 1_000_000;
  const model = createModel({ now: () => t });
  model.ingest('status: oneshot 12s');
  assert.equal(model.fogRemaining(), 12);
  t += 11_999;
  assert.equal(model.fogRemaining(), 1);
  t += 1;
  assert.equal(model.fogRemaining(), 0);
  t += 5_000;
  assert.equal(model.fogRemaining(), 0);
});

test('fogRemaining() is null without a oneshot baseline or when fog is off', () => {
  let t = 1_000_000;
  const model = createModel({ now: () => t });
  assert.equal(model.fogRemaining(), null);
  model.ingest('event: shot');
  assert.equal(model.fogRemaining(), null);
  model.ingest('status: oneshot 12s');
  assert.equal(model.fogRemaining(), 12);
  model.ingest('event: shot-done');
  assert.equal(model.fogRemaining(), null);
});

test('event: shot invalidates a stale oneshot baseline', () => {
  let t = 1_000_000;
  const model = createModel({ now: () => t });
  model.ingest('status: oneshot 12s');
  t += 60_000;
  model.ingest('event: shot-done');
  model.ingest('event: shot');
  assert.equal(model.fogRemaining(), null);
});

// ---- ingest() result descriptors (what the UI must react to) ----

test('fresh model: window unknown, no duration, zero remaining', () => {
  const model = createModel();
  assert.equal(model.state.window, 'unknown');
  assert.equal(model.state.windowDurationS, null);
  assert.equal(model.windowRemaining(), 0);
});

test('ingest returns an event descriptor with name and timestamp', () => {
  let t = 1_000_000;
  const model = createModel({ now: () => t });
  const d = model.ingest('event: shot');
  assert.deepEqual(d, { type: 'event', name: 'shot', at: t });
  assert.equal(model.state.events.length, 1);
});

test('ingest returns an ok descriptor with null command when nothing was pending', () => {
  const model = createModel();
  assert.deepEqual(model.ingest('ok'), { type: 'ok', command: null });
});

test('ingest returns a duration descriptor for window: duration lines', () => {
  const model = createModel();
  assert.deepEqual(model.ingest('window: duration 600s'), { type: 'duration', seconds: 600 });
});

test('ingest returns null for pure state-sync and unknown lines', () => {
  const model = createModel();
  assert.equal(model.ingest('status: idle'), null);
  assert.equal(model.ingest('window: open 600s'), null);
  assert.equal(model.ingest('window: closed'), null);
  assert.equal(model.ingest('commands: shot on off status help'), null);
  assert.equal(model.ingest('nonsense'), null);
});

// ---- window re-sync on physical button events (drift fix) ----
// Only pollButton() emits event: shot / event: off, and every button
// press re-opens the connection window for the full configured duration.

test('event: shot re-syncs the window to the full configured duration', () => {
  let t = 1_000_000;
  const model = createModel({ now: () => t });
  model.ingest('window: duration 600s');
  model.ingest('window: closed');
  model.ingest('event: shot');
  assert.equal(model.state.window, 'open');
  assert.equal(model.windowRemaining(), 600);
  t += 42_000;
  assert.equal(model.windowRemaining(), 558);
});

test('event: off re-syncs the window to the full configured duration', () => {
  let t = 1_000_000;
  const model = createModel({ now: () => t });
  model.ingest('window: duration 300s');
  model.ingest('event: off');
  assert.equal(model.state.window, 'open');
  assert.equal(model.windowRemaining(), 300);
});

test('event: shot replaces a stale open-window baseline', () => {
  let t = 1_000_000;
  const model = createModel({ now: () => t });
  model.ingest('window: duration 600s');
  model.ingest('window: open 600s');
  t += 590_000;
  assert.equal(model.windowRemaining(), 10);
  model.ingest('event: shot');  // the button just re-opened it
  assert.equal(model.windowRemaining(), 600);
});

test('timer events (shot-done, max-on) do not re-sync the window', () => {
  let t = 1_000_000;
  const model = createModel({ now: () => t });
  model.ingest('window: duration 600s');
  model.ingest('window: closed');
  model.ingest('event: shot-done');
  model.ingest('event: max-on');
  assert.equal(model.state.window, 'closed');
  assert.equal(model.windowRemaining(), 0);
});

test('button events without a known duration leave the window untouched', () => {
  const model = createModel();
  model.ingest('window: closed');
  model.ingest('event: shot');
  assert.equal(model.state.window, 'closed');
  assert.equal(model.windowRemaining(), 0);
});

// ---- window re-sync on command acknowledgements (drift fix) ----
// pollBleUart() re-opens the connection window before handling EVERY BLE
// command — so an ok/err: ack proves the window was just re-opened for the
// full duration. USB acks (no pending command) must not re-sync.

test('ok for a pending BLE command re-syncs the window to the full duration', () => {
  let t = 1_000_000;
  const model = createModel({ now: () => t });
  model.ingest('window: duration 600s');
  model.ingest('window: closed');
  model.expect('shot');
  model.ingest('ok');
  assert.equal(model.state.window, 'open');
  assert.equal(model.windowRemaining(), 600);
  t += 42_000;
  assert.equal(model.windowRemaining(), 558);
});

test('err: for a pending BLE command still re-syncs the window', () => {
  let t = 1_000_000;
  const model = createModel({ now: () => t });
  model.ingest('window: duration 600s');
  model.ingest('window: closed');
  model.expect('ble window 9999');
  model.ingest('err: window 30-3600');
  assert.equal(model.state.window, 'open');
  assert.equal(model.windowRemaining(), 600);
});

test('ok for a pending ble off command closes the window', () => {
  let t = 1_000_000;
  const model = createModel({ now: () => t });
  model.ingest('window: duration 600s');
  model.ingest('window: open 600s');
  model.expect('ble off');
  model.ingest('ok');
  assert.equal(model.state.window, 'closed');
  assert.equal(model.windowRemaining(), 0);
});

test('ok without a pending command does not re-sync the window', () => {
  let t = 1_000_000;
  const model = createModel({ now: () => t });
  model.ingest('window: duration 600s');
  model.ingest('window: open 600s');
  t += 500_000;
  model.ingest('ok');  // USB echo — no window restart on the device side
  assert.equal(model.windowRemaining(), 100);
});

test('ack without a known duration leaves the window untouched', () => {
  const model = createModel();
  model.ingest('window: closed');
  model.expect('shot');
  model.ingest('ok');
  assert.equal(model.state.window, 'closed');
  assert.equal(model.windowRemaining(), 0);
});

test('ok for a pending ble window command adopts the new duration', () => {
  let t = 1_000_000;
  const model = createModel({ now: () => t });
  model.ingest('window: duration 600s');
  model.ingest('window: closed');
  model.expect('ble window 300');
  model.ingest('ok');
  assert.equal(model.state.windowDurationS, 300);
  assert.equal(model.state.window, 'open');
  assert.equal(model.windowRemaining(), 300);
});
