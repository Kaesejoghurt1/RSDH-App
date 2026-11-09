// Device model for the PWA remote (ticket 04).
// Parses firmware reply lines into UI state. Line literals match
// firmware/atomizer/atomizer.ino and tests/fake_board.py exactly.

export function createModel({ now = Date.now } = {}) {
  const state = {
    fog: 'unknown',
    events: [],
    pendingCommand: null,
    window: 'unknown',
    windowRemainingS: 0,
    windowDurationS: null,
  };

  let windowSyncAt = null;
  let fogSyncAt = null;

  // Seconds left on a countdown that started at `syncAt` with `totalS`
  // seconds; `expired` is returned when there is no baseline.
  function remaining(syncAt, totalS, expired) {
    if (syncAt === null) return expired;
    const elapsedMs = now() - syncAt;
    return Math.max(0, Math.ceil((totalS * 1000 - elapsedMs) / 1000));
  }

  // Every button press and every BLE command re-opens the connection
  // window on the device for the full configured duration.
  function resyncWindowOpen() {
    if (state.windowDurationS === null) return;
    state.window = 'open';
    state.windowRemainingS = state.windowDurationS;
    windowSyncAt = now();
  }

  return {
    state,
    expect(command) {
      state.pendingCommand = command;
    },
    ingest(line) {
      if (line.startsWith('status: oneshot ')) {
        const m = line.match(/^status: oneshot (\d+)s$/);
        if (m) {
          state.fog = 'oneshot';
          state.fogRemainingS = Number(m[1]);
          fogSyncAt = now();
        }
      } else if (line === 'status: idle') {
        state.fog = 'idle';
        fogSyncAt = null;
      } else if (line === 'status: continuous') {
        state.fog = 'continuous';
        fogSyncAt = null;
      } else if (line === 'window: closed') {
        state.window = 'closed';
        state.windowRemainingS = 0;
        windowSyncAt = null;
      } else if (line.startsWith('window: open ')) {
        const m = line.match(/^window: open (\d+)s$/);
        if (m) {
          state.window = 'open';
          state.windowRemainingS = Number(m[1]);
          windowSyncAt = now();
        }
      } else if (line.startsWith('window: duration ')) {
        const m = line.match(/^window: duration (\d+)s$/);
        if (m) {
          state.windowDurationS = Number(m[1]);
          return { type: 'duration', seconds: Number(m[1]) };
        }
      } else if (line.startsWith('event: ')) {
        const name = line.slice(7);
        const at = now();
        state.events.push({ name, at });
        if (name === 'shot') {
          state.fog = 'oneshot';
          fogSyncAt = null;
        } else if (name === 'shot-done' || name === 'max-on' || name === 'off') {
          state.fog = 'idle';
          fogSyncAt = null;
        }
        // Only the physical button emits shot/off — and every button
        // press re-opens the window. Timer events never do.
        if (name === 'shot' || name === 'off') resyncWindowOpen();
        return { type: 'event', name, at };
      } else if (line === 'ok' || line.startsWith('err: ')) {
        const command = state.pendingCommand;
        state.pendingCommand = null;
        if (command !== null) {
          if (command === 'ble off') {
            // closeWindow() runs before the ack is emitted.
            state.window = 'closed';
            state.windowRemainingS = 0;
            windowSyncAt = null;
          } else {
            if (line === 'ok') {
              const m = command.match(/^ble window (\d+)$/);
              if (m) state.windowDurationS = Number(m[1]);
            }
            // pollBleUart() re-opens the window before handling every
            // BLE command — the ack proves it just happened.
            resyncWindowOpen();
          }
        }
        return line === 'ok'
          ? { type: 'ok', command }
          : { type: 'err', line, command };
      }
      return null;
    },
    windowRemaining() {
      if (state.window !== 'open') return 0;
      return remaining(windowSyncAt, state.windowRemainingS, 0);
    },
    fogRemaining() {
      if (state.fog !== 'oneshot') return null;
      return remaining(fogSyncAt, state.fogRemainingS, null);
    },
  };
}
