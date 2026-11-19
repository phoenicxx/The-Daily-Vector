/**
 * Pure server-side replay of The Daily Vector's ranked simulation.
 *
 * This module intentionally has no DOM, browser globals, Supabase calls, or
 * score-submission behavior. It consumes the version-1 runInputRecorder log
 * emitted by index.html and derives a result from that input stream.
 */

export type RecordedEvent = [number, number, string, ...unknown[]];

export interface RunInputLog {
  metadata: {
    version: number;
    day: number;
    seed: string;
    width: number;
    height: number;
    controls: "touch" | "keyboard";
    sessionId: string | null;
  };
  events: RecordedEvent[];
  overflow: boolean;
}

export interface ReplayOutcome {
  terminal: boolean;
  result: { points: number; timeMs: number; waves: number; reason: string } | null;
  snapshot: {
    points: number;
    time: number;
    waves: number;
    level: number;
    wave: number;
    friendlies: number;
    hostiles: number;
    pings: number;
    selectedFriendlyId: number | null;
    dragPointerId: number | null;
    frameCount: number;
    friendlyPositions: Array<{ id: number; x: number; y: number }>;
  };
}

import {
  DEST_REACH, DRIFT_JITTER, DRIFT_MAX_TURN, HOSTILE_SPAWN_CLEARANCE,
  HOSTILE_STAGGER_S, FRIENDLY_BASE_SPEED, FRIENDLY_MAX_SPEED, FRIENDLY_MIN_SPEED,
  GAME_END_REASONS, GHOST_POINTS, GHOST_WINDOW_S, HOLD_GHOST_S, HOLD_STRIKE_S,
  KEYMAP, PATH_SEP, R_HOSTILE_FRIENDLY, R_FRIENDLY_FRIENDLY,
  STEER_ACCEL, STRIKE_PANEL_CLEARANCE, STRIKE_POINTS, WAVE_PAUSE_S, WRAP_M,
  dailyStreamSeed, destinationPoints, entityStreamSeed, mulberry32, nextWave, waveSpec,
  waveTimeLimit,
} from "../_shared/gameRules.ts";

export { destinationPoints, hashStr, mulberry32, waveSpec, waveTimeLimit } from "../_shared/gameRules.ts";

interface Point { x: number; y: number }
interface Path { x0: number; y0: number; x1: number; y1: number }
interface Friendly extends Point {
  id: number;
  path: Path;
  pathLen: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  age: number;
  turn: number;
  drng: () => number;
}
interface hostile extends Point { id: number; name: string }
interface Ping extends Point {
  id: number;
  age: number;
  holdT: number;
  holdMicros: number;
  holder: number | null;
}
interface Drag { friendlyId: number; pointerId: number; x: number; y: number }
interface PointerState { type: "FRIENDLY" | "PING" | "STRIKE"; id?: number }

interface State {
  t: number;
  level: number;
  wave: number;
  cleared: number;
  points: number;
  kills: number;
  ghostIds: number;
  wavePings: number;
  friendlies: Friendly[];
  hostiles: hostile[];
  ghosts: Ping[];
  selected: Friendly | null;
  drag: Drag | null;
  nextId: number;
  hostileCounter: number;
  friendlyCounter: number;
  inter: number;
  waveT: number;
  hostileQueue: number;
  hostileTimer: number;
  gateNotified: boolean;
  ghostTimer: number;
  pingGap: number;
  maxGhosts: number;
  hostileSpeed: number;
  Speed: number;
  ghostR: number;
  drift: number;
}

interface StrikeState {
  state: "idle" | "confirm" | "hold";
  hostileId: number | null;
  holding: boolean;
  holdT: number;
  holdMicros: number;
}

const HOLD_GHOST_MICROS = HOLD_GHOST_S * 1_000_000;
const HOLD_STRIKE_MICROS = HOLD_STRIKE_S * 1_000_000;

function fail(message: string): never {
  throw new Error(`Replay input invalid: ${message}`);
}


class Replay {
  private fw: number;
  private fh: number;
  private readonly rngBase: string;
  private readonly friendlyRng: () => number;
  private readonly hostileRng: () => number;
  private readonly ghostRng: () => number;
  private readonly pointers = new Map<number, PointerState>();
  private readonly keys = new Set<string>();
  private readonly strike: StrikeState = { state: "idle", hostileId: null, holding: false, holdT: 0, holdMicros: 0 };
  private state: State;
  private endedReason: string | null = null;
  private frameCount = 0;

  constructor(private readonly log: RunInputLog) {
    this.fw = log.metadata.width;
    this.fh = log.metadata.height;
    this.rngBase = log.metadata.seed;
    this.friendlyRng = mulberry32(dailyStreamSeed(this.rngBase, "friendly"));
    this.hostileRng = mulberry32(dailyStreamSeed(this.rngBase, "hostile"));
    this.ghostRng = mulberry32(dailyStreamSeed(this.rngBase, "ping"));
    this.state = {
      t: 0, level: 1, wave: 1, cleared: 0, points: 0, kills: 0, ghostIds: 0,
      wavePings: 0, friendlies: [], hostiles: [], ghosts: [], selected: null,
      drag: null, nextId: 1, hostileCounter: 1, friendlyCounter: 0, inter: 0, waveT: 0,
      hostileQueue: 0, hostileTimer: 0, gateNotified: false, ghostTimer: Infinity,
      pingGap: 0, maxGhosts: 0, hostileSpeed: 40, ghostR: 28, drift: 1, Speed: 40
    };
    this.queueWave({ level: 1, wave: 1 });
  }

  run(): ReplayOutcome {
    this.validateLog();
    let endReason: string | null = null;
    for (const event of this.log.events) {
      const [, , type, ...args] = event;
      if (type === "START") continue;
      if (this.endedReason && type !== "END") fail(`event ${type} follows game over`);
      if (type === "END") {
        if (endReason !== null) fail("duplicate END event");
        endReason = String(args[0] ?? "UNKNOWN");
        if (!this.endedReason) fail("END arrived before a simulated game-over condition");
        if (endReason !== this.endedReason) fail(`END reason ${endReason} differs from simulation ${this.endedReason}`);
        continue;
      }
      this.applyEvent(type, args);
    }

    const terminal = endReason !== null && this.endedReason === endReason;
    if (this.log.events.at(-1)?.[2] === "END" && !terminal) fail("terminal result was not reproduced");
    const result = terminal
      ? { points: this.state.points, timeMs: Math.round(this.state.t * 1000), waves: this.state.cleared, reason: endReason! }
      : null;
    return { terminal, result, snapshot: this.snapshot() };
  }

  private validateLog(): void {
    const { metadata, events } = this.log;
    if (this.log.overflow) fail("recorder overflowed; log is truncated");
    if (!metadata || metadata.version !== 1) fail("unsupported metadata version");
    if (!Number.isFinite(metadata.day) || !Number.isFinite(metadata.width) || metadata.width <= 0 ||
        !Number.isFinite(metadata.height) || metadata.height <= 0) fail("invalid run metadata");
    if (metadata.controls !== "touch" && metadata.controls !== "keyboard") fail("unknown controls mode");
    if (metadata.seed !== `${metadata.day}|daily`) fail("seed does not match the recorded daily puzzle day");
    if (!Array.isArray(events) || events.length === 0) fail("missing event list");
    if (events.at(-1)?.[2] !== "END") fail("incomplete run: final END event is required");

    let previousTime = -Infinity;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (!Array.isArray(event) || event.length < 3) fail(`malformed event at index ${i}`);
      const [time, sequence, type] = event;
      if (!Number.isFinite(time) || time < previousTime) fail(`non-monotonic event time at index ${i}`);
      if (sequence !== i) fail(`unexpected event sequence at index ${i}`);
      if (typeof type !== "string") fail(`missing event type at index ${i}`);
      previousTime = time;
    }
    if (events[0][2] !== "START" || events[0][1] !== 0) fail("first event must be START sequence 0");
    if (events.filter((event) => event[2] === "START").length !== 1) fail("expected exactly one START event");
    if (events.some((event) => event[2] === "END") && events.at(-1)?.[2] !== "END") fail("END must be the final event");
  }

  private applyEvent(type: string, a: unknown[]): void {
    switch (type) {
      case "FRAME": {
        const micros = a[0];
        if (!Number.isInteger(micros) || (micros as number) < 0 || (micros as number) > 50_000) {
          fail("FRAME delta must be an integer from 0 to 50000 microseconds");
        }
        this.frame(micros as number);
        return;
      }
      case "FRIENDLY_DOWN": {
        const id = this.number(a[0], "friendly id");
        const x = this.number(a[1], "friendly pointer x");
        const y = this.number(a[2], "friendly pointer y");
        const pointerId = this.number(a[3], "pointer id");
        const f = this.state.friendlies.find((item) => item.id === id);
        if (!f) fail(`FRIENDLY_DOWN references absent friendly ${id}`);
        if (this.pointers.has(pointerId)) fail(`pointer ${pointerId} is already active`);
        if (Math.abs(x - f.x) > 27 || Math.abs(y - f.y) > 27) {
          fail(`FRIENDLY_DOWN point misses friendly ${id}`);
        }
        this.state.selected = f;
        this.pointers.set(pointerId, { type: "FRIENDLY", id });
        if (this.log.metadata.controls !== "keyboard") {
          this.state.drag = { friendlyId: id, pointerId, x, y };
        }
        return;
      }
      case "FRIENDLY_MOVE": {
        const id = this.number(a[0], "friendly id");
        const x = this.number(a[1], "friendly pointer x");
        const y = this.number(a[2], "friendly pointer y");
        const pointerId = this.number(a[3], "pointer id");
        const pointer = this.pointers.get(pointerId);
        if (!pointer || pointer.type !== "FRIENDLY" || pointer.id !== id) fail("FRIENDLY_MOVE has no matching down event");
        if (this.log.metadata.controls !== "keyboard" && this.state.drag?.pointerId === pointerId) {
          this.state.drag.x = Math.max(12, Math.min(this.fw - 12, x));
          this.state.drag.y = Math.max(12, Math.min(this.fh - 12, y));
        }
        return;
      }
      case "HOSTILE_DOWN": {
        const id = this.number(a[0], "hostile id");
        const x = this.number(a[1], "hostile pointer x");
        const y = this.number(a[2], "hostile pointer y");
        this.number(a[3], "pointer id");
        const hostile = this.state.hostiles.find((item) => item.id === id);
        if (!hostile) fail(`HOSTILE_DOWN references absent hostile ${id}`);
        // Hostile labels extend beyond the 46x46 element, but the current log
        // does not distinguish a label hit from an element hit. Fail closed
        // for points that cannot be proven to hit the element itself.
        if (Math.abs(x - hostile.x) > 23 || Math.abs(y - hostile.y) > 23) {
          fail(`HOSTILE_DOWN point is outside hostile ${id}'s element; label hit testing is unsupported`);
        }
        this.selectStrike(id);
        return;
      }
      case "PING_DOWN": {
        const id = this.number(a[0], "ping id");
        const pointerId = this.number(a[3], "pointer id");
        const ping = this.state.ghosts.find((item) => item.id === id);
        if (!ping || ping.holder !== null) fail(`PING_DOWN references absent or held ping ${id}`);
        if (this.pointers.has(pointerId)) fail(`pointer ${pointerId} is already active`);
        if (Math.hypot(this.number(a[1], "ping pointer x") - ping.x,
          this.number(a[2], "ping pointer y") - ping.y) > this.state.ghostR) {
          fail(`PING_DOWN point misses ping ${id}`);
        }
        ping.holder = pointerId;
        ping.holdT = 0;
        ping.holdMicros = 0;
        this.pointers.set(pointerId, { type: "PING", id });
        return;
      }
      case "STRIKE_HOLD_DOWN": {
        const pointerId = this.number(a[0], "pointer id");
        if (this.pointers.has(pointerId)) fail(`pointer ${pointerId} is already active`);
        if (this.strike.state === "hold" && !this.strike.holding) {
          this.strike.holding = true;
          this.strike.holdT = 0;
          this.strike.holdMicros = 0;
        }
        this.pointers.set(pointerId, { type: "STRIKE" });
        return;
      }
      case "POINTER_END": {
        const pointerType = String(a[0]);
        const pointerId = this.number(a[2], "pointer id");
        const tracked = this.pointers.get(pointerId);
        if (!tracked || tracked.type !== pointerType) fail("POINTER_END has no matching active pointer");
        if (tracked.type === "FRIENDLY" && this.state.drag?.pointerId === pointerId) this.state.drag = null;
        if (tracked.type === "PING") {
          const ping = this.state.ghosts.find((item) => item.id === tracked.id);
          if (ping?.holder === pointerId) { ping.holder = null; ping.holdT = 0; ping.holdMicros = 0; }
        }
        if (tracked.type === "STRIKE") this.endStrikeHold();
        this.pointers.delete(pointerId);
        return;
      }
      case "STRIKE_CONFIRM":
        if (this.strike.state === "confirm") this.strike.state = "hold";
        return;
      case "STRIKE_CANCEL":
        this.resetStrike();
        return;
      case "KEY_DOWN": {
        const code = String(a[0]);
        if (code === "Escape") this.resetStrike();
        if (this.log.metadata.controls !== "keyboard") return;
        if (code === "Space") {
          if (this.strike.state === "hold" && !this.strike.holding) {
            this.strike.holding = true;
            this.strike.holdT = 0;
            this.strike.holdMicros = 0;
          }
        } else if (KEYMAP[code]) this.keys.add(KEYMAP[code]);
        return;
      }
      case "KEY_UP": {
        const code = String(a[0]);
        if (code === "Space" && this.log.metadata.controls === "keyboard") this.endStrikeHold();
        const direction = KEYMAP[code];
        if (direction) this.keys.delete(direction);
        return;
      }
      case "RESIZE": {
        const width = this.number(a[0], "resized width");
        const height = this.number(a[1], "resized height");
        if (width <= 0 || height <= 0) fail("resize dimensions must be positive");
        this.resize(width, height);
        return;
      }
      case "BLUR":
        if (this.pointers.size > 0) fail("BLUR during an active pointer hold cannot be replayed reliably");
        this.keys.clear();
        this.endStrikeHold();
        return;
      default:
        fail(`unsupported event type ${type}`);
    }
  }

  private number(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} is not finite`);
    return value;
  }

  private resize(width: number, height: number): void {
    if (width === this.fw && height === this.fh) return;
    const sx = width / this.fw;
    const sy = height / this.fh;
    const scale = (p: Point) => { p.x *= sx; p.y *= sy; };
    for (const f of this.state.friendlies) {
      scale(f);
      f.path.x0 *= sx; f.path.x1 *= sx;
      f.path.y0 *= sy; f.path.y1 *= sy;
      f.px *= sx; f.py *= sy;
      f.pathLen = Math.hypot(f.path.x1 - f.path.x0, f.path.y1 - f.path.y0);
    }
    for (const e of this.state.hostiles) scale(e);
    for (const g of this.state.ghosts) scale(g);
    if (this.state.drag) { this.state.drag.x *= sx; this.state.drag.y *= sy; }
    this.fw = width;
    this.fh = height;
  }

  private frame(micros: number): void {
    if (this.endedReason) fail("FRAME follows simulated game over");
    this.frameCount++;
    this.update(micros / 1_000_000, micros);
  }

  private update(dt: number, frameMicros: number): void {
    const g = this.state;
    if (!(g.inter > 0)) g.t += dt;

    let steerActive = false;
    const selected = g.selected;
    if (selected) {
      if (this.log.metadata.controls === "keyboard") {
        const ix = (this.keys.has("R") ? 1 : 0) - (this.keys.has("L") ? 1 : 0);
        const iy = (this.keys.has("D") ? 1 : 0) - (this.keys.has("U") ? 1 : 0);
        if (ix || iy) {
          const length = Math.hypot(ix, iy);
          selected.vx += ix / length * STEER_ACCEL * dt;
          selected.vy += iy / length * STEER_ACCEL * dt;
          steerActive = true;
        }
      } else if (g.drag && g.drag.friendlyId === selected.id) {
        const dx = g.drag.x - selected.x;
        const dy = g.drag.y - selected.y;
        const distance = Math.hypot(dx, dy);
        if (distance > 12) {
          selected.vx += dx / distance * STEER_ACCEL * dt;
          selected.vy += dy / distance * STEER_ACCEL * dt;
          steerActive = true;
        }
      }
    }

    for (const f of [...g.friendlies]) {
      const piloted = f === selected && steerActive;
      if (!piloted) {
        const speed = Math.hypot(f.vx, f.vy);
        if (speed < FRIENDLY_MIN_SPEED) {
          if (speed < 0.001) { f.vx = FRIENDLY_MIN_SPEED; f.vy = 0; }
          else { f.vx = f.vx / speed * FRIENDLY_MIN_SPEED; f.vy = f.vy / speed * FRIENDLY_MIN_SPEED; }
        }
      }
      const speed = Math.hypot(f.vx, f.vy);
      if (speed > FRIENDLY_MAX_SPEED) {
        f.vx = f.vx / speed * FRIENDLY_MAX_SPEED;
        f.vy = f.vy / speed * FRIENDLY_MAX_SPEED;
      }

      const dragging = (g.drag?.friendlyId === f.id) || piloted;
      if (!dragging) {
        f.turn += (f.drng() - 0.5) * 2 * DRIFT_JITTER * Math.sqrt(dt);
        f.turn *= 1 - 0.3 * dt;
        f.turn = Math.max(-DRIFT_MAX_TURN, Math.min(DRIFT_MAX_TURN, f.turn));
        const w = f.turn * (0.6 + 0.4 * g.drift) * dt;
        const c = Math.cos(w), sn = Math.sin(w);
        const nvx = f.vx * c - f.vy * sn;
        f.vy = f.vx * sn + f.vy * c;
        f.vx = nvx;
      }
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.age += dt;
      this.wrapPos(f);
      if (Math.hypot(f.x - f.path.x1, f.y - f.path.y1) < DEST_REACH) {
        g.points += destinationPoints(f.pathLen, f.age);
        g.friendlies.splice(g.friendlies.indexOf(f), 1);
        if (g.selected === f) g.selected = null;
        if (g.drag?.friendlyId === f.id) g.drag = null;
      } else {
        f.px = f.x;
        f.py = f.y;
      }
    }

    for (const e of g.hostiles) {
      if (!g.friendlies.length) break;
      let target: Friendly | null = null;
      let best = Infinity;
      let vector: { dx: number; dy: number; d: number } | null = null;
      for (const f of g.friendlies) {
        const v = this.wrapDelta(e.x, e.y, f.x, f.y);
        if (v.d < best) { best = v.d; target = f; vector = v; }
      }
      if (target && vector && best > 0) {
        e.x += vector.dx / best * g.hostileSpeed * dt;
        e.y += vector.dy / best * g.hostileSpeed * dt;
        this.wrapPos(e);
      }
      if (target && this.wrapDelta(e.x, e.y, target.x, target.y).d < R_HOSTILE_FRIENDLY) {
        this.end(GAME_END_REASONS.hostileHit);
        return;
      }
    }

    for (let i = 0; i < g.friendlies.length; i++) {
      for (let j = i + 1; j < g.friendlies.length; j++) {
        const a = g.friendlies[i], b = g.friendlies[j];
        if (Math.hypot(a.x - b.x, a.y - b.y) < R_FRIENDLY_FRIENDLY) {
          this.end(GAME_END_REASONS.friendlyCollision);
          return;
        }
      }
    }

    for (const ping of [...g.ghosts]) {
      ping.age += dt;
      if (ping.holder !== null) {
        ping.holdT += dt;
        ping.holdMicros += frameMicros;
        if (ping.holdMicros >= HOLD_GHOST_MICROS) {
          g.ghosts.splice(g.ghosts.indexOf(ping), 1);
          g.ghostIds++;
          g.wavePings++;
          g.points += GHOST_POINTS;
          continue;
        }
      }
      if (ping.age >= GHOST_WINDOW_S) {
        this.end(GAME_END_REASONS.pingTimeout(GHOST_WINDOW_S));
        return;
      }
    }

    if (this.strike.holding) {
      this.strike.holdT += dt;
      this.strike.holdMicros += frameMicros;
      if (this.strike.holdMicros >= HOLD_STRIKE_MICROS) this.completeStrike();
    }
    this.waveTick(dt);
  }

  private waveTick(dt: number): void {
    const g = this.state;
    if (g.inter > 0) {
      g.inter -= dt;
      if (g.inter <= 0) { g.inter = 0; this.startWave(); }
      return;
    }
    g.waveT += dt;
    if (g.friendlies.length === 0) {
      const allowed = g.wave === 2
        ? g.hostileQueue === 0 && g.hostiles.length === 0
        : g.wave >= 3 ? g.wavePings >= 1 : true;
      if (allowed) {
        g.cleared++;
        this.queueWave(nextWave(g.level, g.wave));
        return;
      }
      g.gateNotified = true;
    }
    if (g.waveT >= waveTimeLimit(g.level)) {
      g.friendlies = [];
      g.ghosts = [];
      g.selected = null;
      g.drag = null;
      this.queueWave(nextWave(g.level, g.wave));
      return;
    }
    if (g.hostileQueue > 0) {
      g.hostileTimer -= dt;
      if (g.hostileTimer <= 0) {
        this.spawnHostile();
        g.hostileQueue--;
        g.hostileTimer = HOSTILE_STAGGER_S;
      }
    }
    if (g.pingGap > 0) {
      g.ghostTimer -= dt;
      if (g.ghostTimer <= 0) {
        if (g.ghosts.length < g.maxGhosts) {
          this.spawnPing();
          g.ghostTimer = g.pingGap * (0.9 + this.ghostRng() * 0.2);
        } else g.ghostTimer = 0.3;
      }
    }
  }

  private queueWave(pos: { level: number; wave: number }): void {
    this.resetStrike();
    this.state.hostiles = [];
    this.state.hostileQueue = 0;
    this.state.ghostTimer = Infinity;
    this.state.pingGap = 0;
    this.state.level = pos.level;
    this.state.wave = pos.wave;
    this.state.inter = WAVE_PAUSE_S;
  }

  private startWave(): void {
    const g = this.state;
    g.waveT = 0;
    g.gateNotified = false;
    g.wavePings = 0;
    const spec = waveSpec(g.level, g.wave);
    g.hostileSpeed = spec.speed;
    g.drift = spec.drift;
    g.ghostR = spec.ghostR;
    g.maxGhosts = spec.maxGhosts;
    g.pingGap = spec.ping;
    g.hostileQueue = spec.hostiles;
    g.hostileTimer = 1.0;
    g.ghostTimer = spec.ping > 0 ? spec.ping : Infinity;
    for (let i = 0; i < spec.planes; i++) this.spawnFriendly();
  }

  private spawnFriendly(): void {
    const g = this.state;
    const n = g.friendlyCounter++;
    const path = this.makePath(n);
    // life is drawn by the browser build even though it is not currently used.
    this.friendlyRng();
    const toDest = Math.atan2(path.y1 - path.y0, path.x1 - path.x0);
    const direction = this.friendlyRng() < 0.5 ? -1 : 1;
    const angle = toDest + direction * (0.7 + this.friendlyRng() * 0.9);
    const f: Friendly = {
      id: g.nextId++, x: path.x0, y: path.y0, path,
      pathLen: Math.hypot(path.x1 - path.x0, path.y1 - path.y0),
      px: path.x0, py: path.y0,
      vx: Math.cos(angle) * FRIENDLY_BASE_SPEED,
      vy: Math.sin(angle) * FRIENDLY_BASE_SPEED,
      age: 0,
      turn: 0,
      drng: mulberry32(entityStreamSeed(this.rngBase, "drift", n)),
    };
    f.turn = (f.drng() - 0.5) * 0.3;
    g.friendlies.push(f);
  }

  private makePath(n: number): Path {
    const first = [this.friendlyRng(), this.friendlyRng(), this.friendlyRng()];
    const retry = mulberry32(entityStreamSeed(this.rngBase, "path", n));
    let candidate: Path | null = null;
    for (let tries = 0; tries < 300; tries++) {
      const strict = tries < 150;
      const r = tries === 0 ? first : [retry(), retry(), retry()];
      const x = this.fw * (0.15 + r[0] * 0.7);
      const y = this.fh * (0.15 + r[1] * 0.7);
      const angle = r[2] * Math.PI * 2;
      const end = this.rayToEdge(x, y, Math.cos(angle), Math.sin(angle));
      const length = Math.hypot(end.x - x, end.y - y) || 1;
      const back = Math.min(80, length * 0.5);
      candidate = {
        x0: x, y0: y,
        x1: x + (end.x - x) * (length - back) / length,
        y1: y + (end.y - y) * (length - back) / length,
      };
      if (strict && Math.hypot(end.x - x, end.y - y) < 250) continue;
      if (!this.farFromOthers(x, y, strict ? 140 : 60)) continue;
      const separation = strict ? PATH_SEP : 1;
      if (this.state.friendlies.every((f) => this.segmentDistance(candidate!, {
        x0: f.px, y0: f.py, x1: f.path.x1, y1: f.path.y1,
      }) > separation)) return candidate;
    }
    if (!candidate) fail("makePath produced no candidate");
    return candidate;
  }

  private farFromOthers(x: number, y: number, minimum: number): boolean {
    return [...this.state.friendlies, ...this.state.hostiles]
      .every((entity) => Math.hypot(entity.x - x, entity.y - y) > minimum);
  }

  private rayToEdge(x: number, y: number, dx: number, dy: number): Point {
    const margin = 30;
    let t = Infinity;
    if (dx > 0) t = Math.min(t, (this.fw + margin - x) / dx);
    else if (dx < 0) t = Math.min(t, (-margin - x) / dx);
    if (dy > 0) t = Math.min(t, (this.fh + margin - y) / dy);
    else if (dy < 0) t = Math.min(t, (-margin - y) / dy);
    return { x: x + dx * t, y: y + dy * t };
  }

  private segmentDistance(a: Path, b: Path): number {
    const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
      (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const nearest = (px: number, py: number, s: Path) => {
      const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
      const l2 = dx * dx + dy * dy;
      let t = l2 ? ((px - s.x0) * dx + (py - s.y0) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (s.x0 + dx * t), py - (s.y0 + dy * t));
    };
    const d1 = cross(a.x0, a.y0, a.x1, a.y1, b.x0, b.y0);
    const d2 = cross(a.x0, a.y0, a.x1, a.y1, b.x1, b.y1);
    const d3 = cross(b.x0, b.y0, b.x1, b.y1, a.x0, a.y0);
    const d4 = cross(b.x0, b.y0, b.x1, b.y1, a.x1, a.y1);
    if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
    return Math.min(
      nearest(a.x0, a.y0, b), nearest(a.x1, a.y1, b),
      nearest(b.x0, b.y0, a), nearest(b.x1, b.y1, a),
    );
  }

  private spawnHostile(): void {
    const g = this.state;
    const number = g.hostileCounter++;
    const edgePos = (a: number, b: number): Point => {
      const side = Math.floor(a * 4);
      const t = 0.1 + b * 0.8;
      if (side === 0) return { x: this.fw * t, y: 0 };
      if (side === 1) return { x: this.fw, y: this.fh * t };
      if (side === 2) return { x: this.fw * t, y: this.fh };
      return { x: 0, y: this.fh * t };
    };
    const score = (p: Point) => {
      let distance = Infinity;
      for (const f of g.friendlies) distance = Math.min(distance, this.wrapDelta(p.x, p.y, f.x, f.y).d);
      return distance;
    };
    let pos = edgePos(this.hostileRng(), this.hostileRng());
    let best = score(pos);
    if (best < HOSTILE_SPAWN_CLEARANCE) {
      const retry = mulberry32(entityStreamSeed(this.rngBase, "espawn", number));
      for (let i = 0; i < 60; i++) {
        const p = edgePos(retry(), retry());
        const candidate = score(p);
        if (candidate > best) { best = candidate; pos = p; }
        if (best >= HOSTILE_SPAWN_CLEARANCE) break;
      }
    }
    g.hostiles.push({ id: g.nextId++, x: pos.x, y: pos.y, name: `HOSTILE ${String(number).padStart(3, "0")}` });
  }

  private spawnPing(): void {
    const g = this.state;
    const radius = g.ghostR;
    const x = radius + 20 + this.ghostRng() * Math.max(10, this.fw - 2 * radius - 40);
    const y = radius + 20 + this.ghostRng() * Math.max(10, this.fh - 2 * radius - 40 - STRIKE_PANEL_CLEARANCE);
    g.ghosts.push({ id: g.nextId++, x, y, age: 0, holdT: 0, holdMicros: 0, holder: null });
  }

  private selectStrike(id: number): void {
    if (this.strike.holding) return;
    if (
      this.log.metadata.controls === "touch" &&
      this.strike.hostileId === id
    ) {
      this.resetStrike();
      return;
    }
    this.strike.hostileId = id;
    // The browser starts the hold directly for both touch and keyboard.
    this.strike.state = "hold";
  }

  private resetStrike(): void {
    this.strike.state = "idle";
    this.strike.hostileId = null;
    this.strike.holding = false;
    this.strike.holdT = 0;
    this.strike.holdMicros = 0;
  }

  private endStrikeHold(): void {
    if (!this.strike.holding) return;
    this.strike.holding = false;
    this.strike.holdT = 0;
    this.strike.holdMicros = 0;
  }

  private completeStrike(): void {
    const id = this.strike.hostileId;
    this.resetStrike();
    if (id === null) return;
    const index = this.state.hostiles.findIndex((hostile) => hostile.id === id);
    if (index < 0) return;
    this.state.hostiles.splice(index, 1);
    this.state.kills++;
    this.state.points += STRIKE_POINTS;
  }

  private end(reason: string): void {
    this.endedReason = reason;
    this.resetStrike();
    this.keys.clear();
  }

  private wrapPos(entity: Point): void {
    const width = this.fw + 2 * WRAP_M, height = this.fh + 2 * WRAP_M;
    if (entity.x < -WRAP_M) entity.x += width;
    else if (entity.x > this.fw + WRAP_M) entity.x -= width;
    if (entity.y < -WRAP_M) entity.y += height;
    else if (entity.y > this.fh + WRAP_M) entity.y -= height;
  }

  private wrapDelta(ax: number, ay: number, bx: number, by: number) {
    const width = this.fw + 2 * WRAP_M, height = this.fh + 2 * WRAP_M;
    let dx = bx - ax, dy = by - ay;
    if (dx > width / 2) dx -= width;
    else if (dx < -width / 2) dx += width;
    if (dy > height / 2) dy -= height;
    else if (dy < -height / 2) dy += height;
    return { dx, dy, d: Math.hypot(dx, dy) };
  }

  private snapshot(): ReplayOutcome["snapshot"] {
    return {
      points: this.state.points,
      time: this.state.t,
      waves: this.state.cleared,
      level: this.state.level,
      wave: this.state.wave,
      friendlies: this.state.friendlies.length,
      hostiles: this.state.hostiles.length,
      pings: this.state.ghosts.length,
      selectedFriendlyId: this.state.selected?.id ?? null,
      dragPointerId: this.state.drag?.pointerId ?? null,
      frameCount: this.frameCount,
      friendlyPositions: this.state.friendlies.map(({ id, x, y }) => ({ id, x, y })),
    };
  }
}

/** Replay a complete run only if simulation independently reaches game over
 * and matches the final recorded END reason. Incomplete logs are rejected.
 */
export function replayInputLog(log: RunInputLog): ReplayOutcome {
  return new Replay(log).run();
}
