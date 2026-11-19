// supabase/functions/ace-submit-run/_shared/gameRules.ts
var STRIKE_POINTS = 500;
var GHOST_POINTS = 250;
var HOLD_STRIKE_S = 2;
var HOLD_GHOST_S = 0.5;
var GHOST_WINDOW_S = 3;
var HOSTILE_STAGGER_S = 1.5;
var HOSTILE_SPAWN_CLEARANCE = 170;
var MIN_PING_GAP_S = 1.5;
var MAX_FRIENDLIES = 6;
var MAX_HOSTILES = 10;
var WAVE_PAUSE_S = 1.8;
var FRIENDLY_BASE_SPEED = 40;
var FRIENDLY_MIN_SPEED = 25;
var FRIENDLY_MAX_SPEED = 90;
var STEER_ACCEL = 170;
var R_FRIENDLY_FRIENDLY = 32;
var R_HOSTILE_FRIENDLY = 28;
var STRIKE_PANEL_CLEARANCE = 170;
var PATH_MAX_POINTS = 300;
var PATH_MIN_POINTS = 20;
var PATH_SEP = 80;
var DRIFT_JITTER = 0.5;
var DRIFT_MAX_TURN = 0.3;
var DEST_REACH = 24;
var WRAP_M = 30;
var WAVE_TIME_LIMIT_S = 30;
var WAVE_TIME_LIMIT_MAX_LEVEL = 3;
function waveTimeLimit(level) {
  return level <= WAVE_TIME_LIMIT_MAX_LEVEL ? WAVE_TIME_LIMIT_S : Infinity;
}
var KEYMAP = {
  KeyW: "U",
  ArrowUp: "U",
  KeyA: "L",
  ArrowLeft: "L",
  KeyS: "D",
  ArrowDown: "D",
  KeyD: "R",
  ArrowRight: "R"
};
var GAME_END_REASONS = {
  hostileHit: "FRIENDLY HIT BY HOSTILE",
  friendlyCollision: "FRIENDLY COLLISION",
  pingTimeout: (seconds) => `PING NOT IDENTIFIED WITHIN ${seconds.toFixed(1)} SECONDS`
};
function hashStr(value) {
  let h = 1779033703 ^ value.length;
  for (let i = 0; i < value.length; i++) {
    h = Math.imul(h ^ value.charCodeAt(i), 3432918353);
    h = h << 13 | h >>> 19;
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed;
  return function() {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function dailyStreamSeed(dailySeed, stream) {
  return hashStr(`${dailySeed}|${stream}`);
}
function entityStreamSeed(dailySeed, stream, index) {
  return hashStr(`${dailySeed}|${stream}|${index}`);
}
function waveSpec(level, wave) {
  const extra = Math.max(0, wave - 3);
  const planes = Math.min(MAX_FRIENDLIES, Math.floor(level / 2) + 1);
  const hostiles = wave >= 2 ? Math.min(MAX_HOSTILES, Math.ceil(level / 2) + extra) : 0;
  const ping = wave >= 3 ? Math.max(MIN_PING_GAP_S, 6.5 - 0.5 * level) : 0;
  return {
    planes,
    hostiles,
    ping,
    speed: wave >= 2 ? Math.min(120, 35 + 5 * (level - 1) + 3 * extra) : 0,
    maxGhosts: wave >= 3 ? Math.min(6, 3 + Math.ceil(level / 2)) : 0,
    ghostR: Math.max(20, 28 - 0.6 * (level - 1) - 0.4 * extra),
    drift: Math.min(2, 1 + 0.05 * (level - 1) + 0.05 * extra)
  };
}
function nextWave(level, wave) {
  const wavesInLevel = level < 10 ? 3 : Infinity;
  return wave < wavesInLevel ? {
    level,
    wave: wave + 1
  } : {
    level: level + 1,
    wave: 1
  };
}
function destinationPoints(pathLen, age) {
  const fastT = pathLen / FRIENDLY_MAX_SPEED;
  const slowT = 3 * pathLen / FRIENDLY_BASE_SPEED;
  const k = Math.max(0, Math.min(1, 1 - (age - fastT) / (slowT - fastT)));
  return Math.round(PATH_MIN_POINTS + (PATH_MAX_POINTS - PATH_MIN_POINTS) * k);
}

// supabase/functions/ace-submit-run/replay/gameReplay.ts
var HOLD_GHOST_MICROS = HOLD_GHOST_S * 1e6;
var HOLD_STRIKE_MICROS = HOLD_STRIKE_S * 1e6;
function fail(message) {
  throw new Error(`Replay input invalid: ${message}`);
}
var Replay = class {
  log;
  fw;
  fh;
  rngBase;
  friendlyRng;
  hostileRng;
  ghostRng;
  pointers;
  keys;
  strike;
  state;
  endedReason;
  frameCount;
  constructor(log) {
    this.log = log;
    this.pointers = /* @__PURE__ */ new Map();
    this.keys = /* @__PURE__ */ new Set();
    this.strike = {
      state: "idle",
      hostileId: null,
      holding: false,
      holdT: 0,
      holdMicros: 0
    };
    this.endedReason = null;
    this.frameCount = 0;
    this.fw = log.metadata.width;
    this.fh = log.metadata.height;
    this.rngBase = log.metadata.seed;
    const legacyRules = log.metadata.version === 1;
    this.friendlyRng = mulberry32(dailyStreamSeed(this.rngBase, "friendly"));
    this.hostileRng = mulberry32(dailyStreamSeed(this.rngBase, legacyRules ? "enemy" : "hostile"));
    this.ghostRng = mulberry32(dailyStreamSeed(this.rngBase, legacyRules ? "ghost" : "ping"));
    this.state = {
      t: 0,
      level: 1,
      wave: 1,
      cleared: 0,
      points: 0,
      kills: 0,
      ghostIds: 0,
      wavePings: 0,
      friendlies: [],
      hostiles: [],
      ghosts: [],
      selected: null,
      drag: null,
      nextId: 1,
      hostileCounter: 1,
      friendlyCounter: 0,
      inter: 0,
      waveT: 0,
      hostileQueue: 0,
      hostileTimer: 0,
      gateNotified: false,
      ghostTimer: Infinity,
      pingGap: 0,
      maxGhosts: 0,
      hostileSpeed: 40,
      ghostR: 28,
      drift: 1
    };
    this.queueWave({
      level: 1,
      wave: 1
    });
  }
  run() {
    this.validateLog();
    let endReason = null;
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
    const result = terminal ? {
      points: this.state.points,
      timeMs: Math.round(this.state.t * 1e3),
      waves: this.state.cleared,
      reason: endReason
    } : null;
    return {
      terminal,
      result,
      snapshot: this.snapshot()
    };
  }
  validateLog() {
    const { metadata, events } = this.log;
    if (this.log.overflow) fail("recorder overflowed; log is truncated");
    if (!metadata || ![
      1,
      2
    ].includes(metadata.version)) fail("unsupported metadata version");
    if (!Number.isFinite(metadata.day) || !Number.isFinite(metadata.width) || metadata.width <= 0 || !Number.isFinite(metadata.height) || metadata.height <= 0) fail("invalid run metadata");
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
  applyEvent(type, a) {
    switch (type) {
      case "FRAME": {
        const micros = a[0];
        if (!Number.isInteger(micros) || micros < 0 || micros > 5e4) {
          fail("FRAME delta must be an integer from 0 to 50000 microseconds");
        }
        this.frame(micros);
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
        this.pointers.set(pointerId, {
          type: "FRIENDLY",
          id
        });
        if (this.log.metadata.controls !== "keyboard") {
          this.state.drag = {
            friendlyId: id,
            pointerId,
            x,
            y
          };
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
      case "HOSTILE_DOWN":
      case "ENEMY_DOWN": {
        const id = this.number(a[0], "hostile id");
        const x = this.number(a[1], "hostile pointer x");
        const y = this.number(a[2], "hostile pointer y");
        this.number(a[3], "pointer id");
        const hostile = this.state.hostiles.find((item) => item.id === id);
        if (!hostile) fail(`HOSTILE_DOWN references absent hostile ${id}`);
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
        if (Math.hypot(this.number(a[1], "ping pointer x") - ping.x, this.number(a[2], "ping pointer y") - ping.y) > this.state.ghostR) {
          fail(`PING_DOWN point misses ping ${id}`);
        }
        ping.holder = pointerId;
        ping.holdT = 0;
        ping.holdMicros = 0;
        this.pointers.set(pointerId, {
          type: "PING",
          id
        });
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
        this.pointers.set(pointerId, {
          type: "STRIKE"
        });
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
          if (ping?.holder === pointerId) {
            ping.holder = null;
            ping.holdT = 0;
            ping.holdMicros = 0;
          }
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
        for (const [pointerId, pointer] of this.pointers) {
          if (pointer.type === "FRIENDLY" && this.state.drag?.pointerId === pointerId) this.state.drag = null;
          if (pointer.type === "PING") {
            const ping = this.state.ghosts.find((item) => item.id === pointer.id);
            if (ping?.holder === pointerId) {
              ping.holder = null;
              ping.holdT = 0;
              ping.holdMicros = 0;
            }
          }
        }
        this.pointers.clear();
        this.keys.clear();
        this.endStrikeHold();
        return;
      default:
        fail(`unsupported event type ${type}`);
    }
  }
  number(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} is not finite`);
    return value;
  }
  resize(width, height) {
    if (width === this.fw && height === this.fh) return;
    const sx = width / this.fw;
    const sy = height / this.fh;
    const scale = (p) => {
      p.x *= sx;
      p.y *= sy;
    };
    for (const f of this.state.friendlies) {
      scale(f);
      f.path.x0 *= sx;
      f.path.x1 *= sx;
      f.path.y0 *= sy;
      f.path.y1 *= sy;
      f.px *= sx;
      f.py *= sy;
      f.pathLen = Math.hypot(f.path.x1 - f.path.x0, f.path.y1 - f.path.y0);
    }
    for (const e of this.state.hostiles) scale(e);
    for (const g of this.state.ghosts) scale(g);
    if (this.state.drag) {
      this.state.drag.x *= sx;
      this.state.drag.y *= sy;
    }
    this.fw = width;
    this.fh = height;
  }
  frame(micros) {
    if (this.endedReason) fail("FRAME follows simulated game over");
    this.frameCount++;
    this.update(micros / 1e6, micros);
  }
  update(dt, frameMicros) {
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
    for (const f of [
      ...g.friendlies
    ]) {
      const piloted = f === selected && steerActive;
      if (!piloted) {
        const speed2 = Math.hypot(f.vx, f.vy);
        if (speed2 < FRIENDLY_MIN_SPEED) {
          if (speed2 < 1e-3) {
            f.vx = FRIENDLY_MIN_SPEED;
            f.vy = 0;
          } else {
            f.vx = f.vx / speed2 * FRIENDLY_MIN_SPEED;
            f.vy = f.vy / speed2 * FRIENDLY_MIN_SPEED;
          }
        }
      }
      const speed = Math.hypot(f.vx, f.vy);
      if (speed > FRIENDLY_MAX_SPEED) {
        f.vx = f.vx / speed * FRIENDLY_MAX_SPEED;
        f.vy = f.vy / speed * FRIENDLY_MAX_SPEED;
      }
      const dragging = g.drag?.friendlyId === f.id || piloted;
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
      let target = null;
      let best = Infinity;
      let vector = null;
      for (const f of g.friendlies) {
        const v = this.wrapDelta(e.x, e.y, f.x, f.y);
        if (v.d < best) {
          best = v.d;
          target = f;
          vector = v;
        }
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
    for (const ping of [
      ...g.ghosts
    ]) {
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
  waveTick(dt) {
    const g = this.state;
    if (g.inter > 0) {
      g.inter -= dt;
      if (g.inter <= 0) {
        g.inter = 0;
        this.startWave();
      }
      return;
    }
    g.waveT += dt;
    if (g.friendlies.length === 0) {
      const allowed = g.wave === 2 ? g.hostileQueue === 0 && g.hostiles.length === 0 : g.wave >= 3 ? g.wavePings >= 1 : true;
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
  queueWave(pos) {
    this.resetStrike();
    this.state.hostiles = [];
    this.state.hostileQueue = 0;
    this.state.ghostTimer = Infinity;
    this.state.pingGap = 0;
    this.state.level = pos.level;
    this.state.wave = pos.wave;
    this.state.inter = WAVE_PAUSE_S;
  }
  startWave() {
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
    g.hostileTimer = 1;
    g.ghostTimer = spec.ping > 0 ? spec.ping : Infinity;
    for (let i = 0; i < spec.planes; i++) this.spawnFriendly();
  }
  spawnFriendly() {
    const g = this.state;
    const n = g.friendlyCounter++;
    const path = this.makePath(n);
    this.friendlyRng();
    const toDest = Math.atan2(path.y1 - path.y0, path.x1 - path.x0);
    const direction = this.friendlyRng() < 0.5 ? -1 : 1;
    const angle = toDest + direction * (0.7 + this.friendlyRng() * 0.9);
    const f = {
      id: g.nextId++,
      x: path.x0,
      y: path.y0,
      path,
      pathLen: Math.hypot(path.x1 - path.x0, path.y1 - path.y0),
      px: path.x0,
      py: path.y0,
      vx: Math.cos(angle) * FRIENDLY_BASE_SPEED,
      vy: Math.sin(angle) * FRIENDLY_BASE_SPEED,
      age: 0,
      turn: 0,
      drng: mulberry32(entityStreamSeed(this.rngBase, "drift", n))
    };
    f.turn = (f.drng() - 0.5) * 0.3;
    g.friendlies.push(f);
  }
  makePath(n) {
    const first = [
      this.friendlyRng(),
      this.friendlyRng(),
      this.friendlyRng()
    ];
    const retry = mulberry32(entityStreamSeed(this.rngBase, "path", n));
    let candidate = null;
    for (let tries = 0; tries < 300; tries++) {
      const strict = tries < 150;
      const r = tries === 0 ? first : [
        retry(),
        retry(),
        retry()
      ];
      const x = this.fw * (0.15 + r[0] * 0.7);
      const y = this.fh * (0.15 + r[1] * 0.7);
      const angle = r[2] * Math.PI * 2;
      const end = this.rayToEdge(x, y, Math.cos(angle), Math.sin(angle));
      const length = Math.hypot(end.x - x, end.y - y) || 1;
      const back = Math.min(80, length * 0.5);
      candidate = {
        x0: x,
        y0: y,
        x1: x + (end.x - x) * (length - back) / length,
        y1: y + (end.y - y) * (length - back) / length
      };
      if (strict && Math.hypot(end.x - x, end.y - y) < 250) continue;
      if (!this.farFromOthers(x, y, strict ? 140 : 60)) continue;
      const separation = strict ? PATH_SEP : 1;
      if (this.state.friendlies.every((f) => this.segmentDistance(candidate, {
        x0: f.px,
        y0: f.py,
        x1: f.path.x1,
        y1: f.path.y1
      }) > separation)) return candidate;
    }
    if (!candidate) fail("makePath produced no candidate");
    return candidate;
  }
  farFromOthers(x, y, minimum) {
    return [
      ...this.state.friendlies,
      ...this.state.hostiles
    ].every((entity) => Math.hypot(entity.x - x, entity.y - y) > minimum);
  }
  rayToEdge(x, y, dx, dy) {
    const margin = 30;
    let t = Infinity;
    if (dx > 0) t = Math.min(t, (this.fw + margin - x) / dx);
    else if (dx < 0) t = Math.min(t, (-margin - x) / dx);
    if (dy > 0) t = Math.min(t, (this.fh + margin - y) / dy);
    else if (dy < 0) t = Math.min(t, (-margin - y) / dy);
    return {
      x: x + dx * t,
      y: y + dy * t
    };
  }
  segmentDistance(a, b) {
    const cross = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const nearest = (px, py, s) => {
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
    return Math.min(nearest(a.x0, a.y0, b), nearest(a.x1, a.y1, b), nearest(b.x0, b.y0, a), nearest(b.x1, b.y1, a));
  }
  spawnHostile() {
    const g = this.state;
    const number = g.hostileCounter++;
    const edgePos = (a, b) => {
      const side = Math.floor(a * 4);
      const t = 0.1 + b * 0.8;
      if (side === 0) return {
        x: this.fw * t,
        y: 0
      };
      if (side === 1) return {
        x: this.fw,
        y: this.fh * t
      };
      if (side === 2) return {
        x: this.fw * t,
        y: this.fh
      };
      return {
        x: 0,
        y: this.fh * t
      };
    };
    const score = (p) => {
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
        if (candidate > best) {
          best = candidate;
          pos = p;
        }
        if (best >= HOSTILE_SPAWN_CLEARANCE) break;
      }
    }
    g.hostiles.push({
      id: g.nextId++,
      x: pos.x,
      y: pos.y,
      name: `HOSTILE ${String(number).padStart(3, "0")}`
    });
  }
  spawnPing() {
    const g = this.state;
    const radius = g.ghostR;
    const x = radius + 20 + this.ghostRng() * Math.max(10, this.fw - 2 * radius - 40);
    const y = radius + 20 + this.ghostRng() * Math.max(10, this.fh - 2 * radius - 40 - STRIKE_PANEL_CLEARANCE);
    g.ghosts.push({
      id: g.nextId++,
      x,
      y,
      age: 0,
      holdT: 0,
      holdMicros: 0,
      holder: null
    });
  }
  selectStrike(id) {
    if (this.strike.holding) return;
    if (this.log.metadata.controls === "touch" && this.strike.hostileId === id) {
      this.resetStrike();
      return;
    }
    this.strike.hostileId = id;
    this.strike.state = "hold";
  }
  resetStrike() {
    this.strike.state = "idle";
    this.strike.hostileId = null;
    this.strike.holding = false;
    this.strike.holdT = 0;
    this.strike.holdMicros = 0;
  }
  endStrikeHold() {
    if (!this.strike.holding) return;
    this.strike.holding = false;
    this.strike.holdT = 0;
    this.strike.holdMicros = 0;
  }
  completeStrike() {
    const id = this.strike.hostileId;
    this.resetStrike();
    if (id === null) return;
    const index = this.state.hostiles.findIndex((hostile) => hostile.id === id);
    if (index < 0) return;
    this.state.hostiles.splice(index, 1);
    this.state.kills++;
    this.state.points += STRIKE_POINTS;
  }
  end(reason) {
    this.endedReason = reason;
    this.resetStrike();
    this.keys.clear();
  }
  wrapPos(entity) {
    const width = this.fw + 2 * WRAP_M, height = this.fh + 2 * WRAP_M;
    if (entity.x < -WRAP_M) entity.x += width;
    else if (entity.x > this.fw + WRAP_M) entity.x -= width;
    if (entity.y < -WRAP_M) entity.y += height;
    else if (entity.y > this.fh + WRAP_M) entity.y -= height;
  }
  wrapDelta(ax, ay, bx, by) {
    const width = this.fw + 2 * WRAP_M, height = this.fh + 2 * WRAP_M;
    let dx = bx - ax, dy = by - ay;
    if (dx > width / 2) dx -= width;
    else if (dx < -width / 2) dx += width;
    if (dy > height / 2) dy -= height;
    else if (dy < -height / 2) dy += height;
    return {
      dx,
      dy,
      d: Math.hypot(dx, dy)
    };
  }
  snapshot() {
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
      friendlyPositions: this.state.friendlies.map(({ id, x, y }) => ({
        id,
        x,
        y
      }))
    };
  }
};
function replayInputLog(log) {
  return new Replay(log).run();
}

// supabase/functions/ace-submit-run/index.ts
var MAX_BODY_BYTES = 8e6;
var MAX_EVENTS = 1e5;
var MAX_EVENT_TIME_MS = 24 * 60 * 60 * 1e3;
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function response(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, apikey, content-type",
      "access-control-allow-methods": "POST, OPTIONS"
    }
  });
}
function invalid(message) {
  throw new Error(message);
}
function isPuzzleDay(value) {
  const text = String(value ?? "");
  if (!/^\d{8}$/.test(text)) return false;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6));
  const date = Number(text.slice(6, 8));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  return month >= 1 && month <= 12 && date >= 1 && date <= monthLengths[month - 1];
}
async function sha256Hex(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [
    ...new Uint8Array(bytes)
  ].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function validateLogShape(log, sessionId, day) {
  if (!log || typeof log !== "object" || Array.isArray(log)) {
    invalid("Replay input invalid: input_log must be an object");
  }
  const value = log;
  if (!value.metadata || !Array.isArray(value.events) || typeof value.overflow !== "boolean") invalid("Replay input invalid: metadata, events, or overflow is missing");
  if (value.events.length < 2 || value.events.length > MAX_EVENTS) {
    invalid(`Replay input invalid: event count ${value.events.length} is outside 2..${MAX_EVENTS}`);
  }
  if (value.metadata.sessionId !== sessionId || value.metadata.day !== day) {
    invalid("SESSION_MISMATCH");
  }
  if (!Number.isFinite(value.metadata.width) || !Number.isFinite(value.metadata.height) || value.metadata.width < 1 || value.metadata.height < 1 || value.metadata.width > 1e4 || value.metadata.height > 1e4) {
    invalid("Replay input invalid: recorded field dimensions are invalid");
  }
  let prior = -1;
  for (const event of value.events) {
    if (!Array.isArray(event) || event.length < 3 || !Number.isFinite(event[0]) || !Number.isSafeInteger(event[1]) || typeof event[2] !== "string") invalid(`Replay input invalid: malformed event at index ${value.events.indexOf(event)}`);
    if (event[0] < prior || event[0] > MAX_EVENT_TIME_MS) {
      invalid(`Replay input invalid: event time is invalid at sequence ${event[1]}`);
    }
    prior = event[0];
    if (event.some((field) => typeof field === "number" && (!Number.isFinite(field) || Math.abs(field) > 1e7))) {
      invalid(`Replay input invalid: numeric value is invalid at sequence ${event[1]}`);
    }
  }
  if (JSON.stringify(log).length > MAX_BODY_BYTES) {
    invalid("INPUT_LOG_TOO_LARGE");
  }
}
function createHandler(deps) {
  return async (request) => {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, apikey, content-type",
          "access-control-allow-methods": "POST, OPTIONS"
        }
      });
    }
    if (request.method !== "POST") {
      return response(405, {
        ok: false,
        error: "METHOD_NOT_ALLOWED"
      });
    }
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_BODY_BYTES) {
      return response(413, {
        ok: false,
        error: "REQUEST_TOO_LARGE"
      });
    }
    let input;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
        return response(413, {
          ok: false,
          error: "REQUEST_TOO_LARGE"
        });
      }
      input = JSON.parse(text);
    } catch {
      return response(400, {
        ok: false,
        error: "INVALID_JSON"
      });
    }
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.session_id !== "string" || !UUID.test(input.session_id) || typeof input.token !== "string" || input.token.length < 32 || input.token.length > 512 || typeof input.account_name !== "string" || input.account_name.length < 1 || input.account_name.length > 50) return response(400, {
      ok: false,
      error: "MISSING_FIELDS"
    });
    if (!Object.hasOwn(input, "input_log") || input.input_log == null) {
      return response(400, {
        ok: false,
        error: "MISSING_INPUT_LOG"
      });
    }
    try {
      const session = await deps.getSession(input.session_id);
      if (!session) {
        return response(403, {
          ok: false,
          error: "INVALID_SESSION"
        });
      }
      const expiry = Date.parse(String(session.expires_at ?? ""));
      const storedHash = String(session.token_hash ?? "").toLowerCase();
      const accountId = String(session.account_id ?? "");
      const day = Number(session.puzzle_day);
      if (!/^[1-9]\d*$/.test(accountId) || !isPuzzleDay(session.puzzle_day) || !Number.isSafeInteger(day) || !Number.isFinite(expiry)) return response(403, {
        ok: false,
        error: "INVALID_SESSION"
      });
      if (expiry <= deps.now()) {
        return response(403, {
          ok: false,
          error: "SESSION_EXPIRED"
        });
      }
      if (session.status === "completed") {
        return response(409, {
          ok: false,
          error: "SESSION_USED"
        });
      }
      if (session.status !== "active") {
        return response(403, {
          ok: false,
          error: "INVALID_SESSION"
        });
      }
      if (!storedHash || await sha256Hex(input.token) !== storedHash) {
        return response(403, {
          ok: false,
          error: "INVALID_SESSION"
        });
      }
      const account = await deps.getAccount(accountId);
      if (!account || account.id !== accountId) {
        return response(403, {
          ok: false,
          error: "INVALID_SESSION"
        });
      }
      if (input.account_name !== account.name) {
        return response(403, {
          ok: false,
          error: "WRONG_ACCOUNT"
        });
      }
      validateLogShape(input.input_log, input.session_id, day);
      if (input.input_log.metadata.seed !== `${day}|daily`) {
        return response(422, {
          ok: false,
          error: "SESSION_MISMATCH"
        });
      }
      const outcome = replayInputLog(input.input_log);
      const result = outcome.result;
      if (!outcome.terminal || !result || !Number.isSafeInteger(result.points) || !Number.isSafeInteger(result.timeMs) || !Number.isSafeInteger(result.waves) || result.points < 0 || result.timeMs < 0 || result.waves < 0 || ![
        "FRIENDLY HIT BY HOSTILE",
        "FRIENDLY COLLISION",
        "PING NOT IDENTIFIED WITHIN 3.0 SECONDS"
      ].includes(result.reason)) {
        return response(422, {
          ok: false,
          error: "INVALID_TERMINAL_RESULT"
        });
      }
      if (input.input_log.events.some((event) => event[2] === "DEBUG_WAVE_SKIP")) {
        return response(422, {
          ok: false,
          error: "DEBUG_RUN_NOT_RANKED"
        });
      }
      const scoreId = await deps.complete(input.session_id, storedHash, accountId, day, {
        points: result.points,
        time_ms: result.timeMs,
        waves: result.waves,
        ending_reason: result.reason
      });
      return response(200, {
        ok: true,
        score_id: scoreId
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Replay input invalid:") || message === "INVALID_INPUT_LOG" || message === "SESSION_MISMATCH") {
        const detail = message.startsWith("Replay input invalid:") ? message.slice("Replay input invalid: ".length).slice(0, 180) : message;
        return response(422, {
          ok: false,
          error: message === "SESSION_MISMATCH" ? "SESSION_MISMATCH" : "INVALID_INPUT_LOG",
          detail
        });
      }
      if (message === "INPUT_LOG_TOO_LARGE") {
        return response(413, {
          ok: false,
          error: message
        });
      }
      if (message === "SESSION_USED") {
        return response(409, {
          ok: false,
          error: message
        });
      }
      console.error("ace-submit-run failed", message);
      return response(500, {
        ok: false,
        error: "SUBMISSION_FAILED"
      });
    }
  };
}
function requiredEnv(key) {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}
if (import.meta.main) {
  const base = requiredEnv("SUPABASE_URL").replace(/\/+$/, "");
  const key = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json"
  };
  const handler = createHandler({
    async getSession(id) {
      const url = new URL(`${base}/rest/v1/ace_game_runs`);
      url.searchParams.set("id", `eq.${id}`);
      url.searchParams.set("select", "id,account_id,puzzle_day,token_hash,expires_at,status");
      const res = await fetch(url, {
        headers
      });
      if (!res.ok) throw new Error(`session lookup ${res.status}`);
      const rows = await res.json();
      return rows[0] ?? null;
    },
    async getAccount(id) {
      const url = new URL(`${base}/rest/v1/ace_accounts`);
      url.searchParams.set("id", `eq.${id}`);
      url.searchParams.set("select", "id,name");
      const res = await fetch(url, {
        headers
      });
      if (!res.ok) throw new Error(`account lookup ${res.status}`);
      const rows = await res.json();
      const account = rows[0];
      return account ? {
        id: String(account.id),
        name: String(account.name)
      } : null;
    },
    async complete(id, tokenHash, accountId, day, score) {
      const res = await fetch(`${base}/rest/v1/rpc/ace_complete_verified_run`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          p_session_id: id,
          p_token_hash: tokenHash,
          p_account_id: accountId,
          p_day: day,
          p_points: score.points,
          p_time_ms: score.time_ms,
          p_waves: score.waves,
          p_ending_reason: score.ending_reason
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (data?.message === "SESSION_USED") throw new Error("SESSION_USED");
        throw new Error(`atomic completion failed ${res.status}: ${data?.message ?? "unknown"}`);
      }
      return String(data);
    },
    now: () => Date.now()
  });
  Deno.serve(handler);
}
export {
  createHandler
};
