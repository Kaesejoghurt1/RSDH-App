// Device model for the PWA remote ("Die Brücke" UI).
// Parses firmware reply lines into UI state. Line literals match
// firmware/atomizer/atomizer.ino and tests/fake_board.py exactly:
//   status: idle | oneshot <N>s | on <N>s | continuous
//   status: periodic <i>/<n> <int>s/<dur>s <fog|wait> <N>s
//   tank: <N>s | tank: -<N>s (button-override overdraft)
//   led: <g><r><b>   window: open <N>s | closed | duration <N>s
//   event: shot | shot-done | on-done | off | max-on
//   event: salve <i>/<n> | salve-done <i> | program-done
// The tank counts down locally while fog runs (EN high); the firmware
// re-syncs it with a "tank:" line after every fog end and on refill.

export function createModel({ now = Date.now } = {}) {
  const state = {
    fog: 'unknown',          // unknown | idle | oneshot | continuous | timed | periodic
    fogRemainingS: null,     // countdown baseline for oneshot/timed/periodic phase
    periodic: null,          // { current, total, intervalS, durationS, phase }
    tankS: null,             // remaining activity budget (null = unknown)
    led: null,               // { g, r, b } booleans (null = unknown)
    events: [],
    pendingCommand: null,
    window: 'unknown',
    windowRemainingS: 0,
    windowDurationS: null,
  };

  let windowSyncAt = null;
  let fogSyncAt = null;
  // Tank countdown: baseline timestamp while fog is running (EN high),
  // null while paused. The firmware re-syncs with "tank:" lines at every
  // fog end; between those, the model counts down locally.
  let tankSyncAt = null;

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

  // Snapshot the counted-down tank into tankS and stop the countdown.
  // Called at every fog end; the firmware's authoritative "tank:" line
  // follows immediately and re-syncs.
  function freezeTank() {
    if (tankSyncAt !== null && state.tankS !== null) {
      state.tankS = remaining(tankSyncAt, state.tankS, state.tankS);
    }
    tankSyncAt = null;
  }

  function setFog(fog, remainingS) {
    state.fog = fog;
    state.fogRemainingS = remainingS ?? null;
    fogSyncAt = remainingS != null ? now() : null;
    // Tank baseline follows the fog state: ticking while fog runs
    // (EN high), frozen while idle or in a salvo wait phase.
    const fogRunning = fog === 'oneshot' || fog === 'timed'
      || fog === 'continuous'
      || (fog === 'periodic' && state.periodic?.phase !== 'wait');
    if (fogRunning && state.tankS !== null && state.tankS > 0) {
      tankSyncAt = now();
    } else {
      freezeTank();
    }
  }

  function ingestEvent(name, at) {
    state.events.push({ name, at });
    if (name === 'shot') {
      setFog('oneshot', null);  // no baseline until the next status sync
    } else if (name === 'shot-done' || name === 'on-done' || name === 'max-on' || name === 'off') {
      setFog('idle', null);
      state.periodic = null;
    } else if (name.startsWith('salve ')) {
      // event: salve <i>/<n> — a new salvo is fogging
      const m = name.match(/^salve (\d+)\/(\d+)$/);
      if (m) {
        state.fog = 'periodic';
        state.periodic = state.periodic
          ?? { current: 0, total: 0, intervalS: null, durationS: null, phase: 'fog' };
        state.periodic.current = Number(m[1]);
        state.periodic.total = Number(m[2]);
        state.periodic.phase = 'fog';
        fogSyncAt = null;  // phase length comes from the next status sync
        if (state.tankS !== null && state.tankS > 0) tankSyncAt = now();
      }
    } else if (name.startsWith('salve-done')) {
      // event: salve-done <i> — this salvo finished; wait phase follows
      if (state.periodic) state.periodic.phase = 'wait';
      freezeTank();  // EN low during the pause: tank frozen
    } else if (name === 'program-done') {
      setFog('idle', null);
      state.periodic = null;
    }
    // Only the physical button emits shot/off — and every button
    // press re-opens the window. Timer events never do.
    if (name === 'shot' || name === 'off') resyncWindowOpen();
    return { type: 'event', name, at };
  }

  return {
    state,
    expect(command) {
      state.pendingCommand = command;
    },
    ingest(line) {
      if (line.startsWith('status: ')) {
        const body = line.slice(8);
        if (body === 'idle') {
          setFog('idle', null);
          state.periodic = null;
        } else if (body.startsWith('oneshot ')) {
          const m = body.match(/^oneshot (\d+)s$/);
          if (m) setFog('oneshot', Number(m[1]));
        } else if (body.startsWith('on ')) {
          const m = body.match(/^on (\d+)s$/);
          if (m) {
            setFog('timed', Number(m[1]));
            state.periodic = null;
          }
        } else if (body === 'continuous') {
          setFog('continuous', null);
          state.periodic = null;
        } else if (body.startsWith('periodic ')) {
          const m = body.match(/^periodic (\d+)\/(\d+) (\d+)s\/(\d+)s (fog|wait) (\d+)s$/);
          if (m) {
            state.periodic = {
              current: Number(m[1]),
              total: Number(m[2]),
              intervalS: Number(m[3]),
              durationS: Number(m[4]),
              phase: m[5],
            };
            setFog('periodic', Number(m[6]));
          }
        }
      } else if (line.startsWith('tank: ')) {
        const m = line.match(/^tank: (-?\d+)s$/);
        if (m) {
          state.tankS = Number(m[1]);
          // Fresh baseline from the device: ticking only while fog runs.
          // Negative (button override overdraft) freezes — it only
          // changes at fog ends, never mid-run.
          tankSyncAt = state.tankS > 0
            && (state.fog === 'oneshot' || state.fog === 'timed'
              || state.fog === 'continuous' || state.fog === 'periodic')
            ? now() : null;
        }
      } else if (line.startsWith('led: ')) {
        const m = line.match(/^led: ([01])([01])([01])$/);
        if (m) state.led = { g: m[1] === '1', r: m[2] === '1', b: m[3] === '1' };
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
        return ingestEvent(line.slice(7), now());
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
      if (state.fog !== 'oneshot' && state.fog !== 'timed' && state.fog !== 'periodic') return null;
      return remaining(fogSyncAt, state.fogRemainingS, null);
    },
    tankRemaining() {
      if (state.tankS === null) return null;
      // Negative = overdraft after a button override: frozen, not ticking.
      if (state.tankS < 0) return state.tankS;
      return remaining(tankSyncAt, state.tankS, state.tankS);
    },
  };
}
