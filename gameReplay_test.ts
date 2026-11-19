import {
  destinationPoints,
  hashStr,
  mulberry32,
  replayInputLog,
  waveSpec,
  type RecordedEvent,
  type RunInputLog,
} from "./supabase/functions/ace-submit-run/replay/gameReplay.ts";
import genuineLog from "./fixtures/genuine-run.json" with { type: "json" };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\nexpected ${JSON.stringify(expected)}\nactual   ${JSON.stringify(actual)}`);
  }
}

function assertThrows(action: () => unknown, includes: string): void {
  try {
    action();
  } catch (error) {
    assert(String(error).includes(includes), `expected error containing ${includes}, got ${error}`);
    return;
  }
  throw new Error(`expected replay to reject: ${includes}`);
}

function recordedLog(controls: "touch" | "keyboard" = "touch"): RunInputLog {
  const events: RecordedEvent[] = [[0, 0, "START"]];
  let sequence = 1;
  const add = (time: number, type: string, ...args: unknown[]) => {
    events.push([time, sequence++, type, ...args]);
  };

  // A version-1 recorder tape: FRAME deltas are in integer microseconds.
  // Forty 50ms frames pass the initial intermission and create wave 1's plane.
  for (let frame = 1; frame <= 40; frame++) add(frame * 50, "FRAME", 50_000);
  const base: RunInputLog = {
    metadata: {
      version: 1,
      day: 20260101,
      seed: "20260101|daily",
      width: 430,
      height: 700,
      controls,
      sessionId: "fixture-session",
    },
    events,
    overflow: false,
  };
  return base;
}

Deno.test("Mulberry32 matches the browser game's seeded stream", () => {
  // The browser builds RNG.base as `${getDaily()}|daily`, then hashes the
  // stream name onto it before initializing Mulberry32.
  const seed = hashStr("20260101|daily|friendly");
  const random = mulberry32(seed);
  assertEqual(
    [random(), random(), random()],
    [0.522027252940461, 0.3304689817596227, 0.8786575742997229],
    "seeded stream differs from browser implementation",
  );
});

Deno.test("wave composition and arrival scoring preserve current formulas", () => {
  assertEqual(waveSpec(1, 1), {
    planes: 1, enemies: 0, ping: 0, speed: 0,
    maxGhosts: 0, ghostR: 28, drift: 1,
  }, "wave 1 composition differs");
  const level10Wave4 = waveSpec(10, 4);
  assertEqual({ ...level10Wave4, ghostR: undefined }, {
    planes: 6, enemies: 6, ping: 1.5, speed: 83,
    maxGhosts: 6, ghostR: undefined, drift: 1.5,
  }, "level 10 wave composition differs");
  assert(Math.abs(level10Wave4.ghostR - 22.2) < 1e-12, "level 10 ghost radius differs");
  assertEqual(
    [destinationPoints(180, 180 / 90), destinationPoints(180, 13.5), destinationPoints(180, 7.75)],
    [300, 20, 160],
    "arrival reward interpolation differs",
  );
});

Deno.test("incomplete frame and input tape is rejected", () => {
  const log = recordedLog();
  assertThrows(() => replayInputLog(log), "incomplete run: final END event is required");
});

Deno.test("exported input-log JSON parses and is accepted by the replay entry point", () => {
  const log = recordedLog();
  // Export the clean START/FRAME prefix and final END, excluding unrelated
  // pointer inputs. Replay should reach END validation after JSON parsing.
  log.events = log.events.slice(0, 41);
  log.events.push([log.events.at(-1)![0] + 1, log.events.length, "END", "PING NOT IDENTIFIED WITHIN 3.0 SECONDS"]);
  const exportedJson = JSON.stringify(log, null, 2);
  const parsed = JSON.parse(exportedJson);
  assertEqual(parsed, log, "exported JSON changed the input log");
  assertThrows(
    () => replayInputLog(parsed),
    "END arrived before a simulated game-over condition",
  );
});

Deno.test("overflowed recorder tapes are rejected", () => {
  const log = recordedLog();
  log.overflow = true;
  assertThrows(() => replayInputLog(log), "recorder overflowed");
});

Deno.test("genuine captured run replays through threshold-length holds to its recorded terminal state", () => {
  const outcome = replayInputLog(genuineLog as RunInputLog);
  assertEqual(outcome.terminal, true, "captured run did not reach terminal state");
  assertEqual(outcome.result, {
    points: 1558,
    timeMs: 36316,
    waves: 2,
    reason: "FRIENDLY HIT BY HOSTILE",
  }, "captured terminal result differs");
});
