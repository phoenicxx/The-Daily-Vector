/** Authoritative deterministic gameplay rules shared by server-side code. */
export const STRIKE_POINTS = 500;
export const GHOST_POINTS = 250;
export const HOLD_STRIKE_S = 2.0;
export const HOLD_GHOST_S = 0.5;
export const GHOST_WINDOW_S = 3.0;
export const ENEMY_STAGGER_S = 1.5;
export const ENEMY_SPAWN_CLEARANCE = 170;
export const MIN_PING_GAP_S = 1.5;
export const MAX_FRIENDLIES = 6;
export const MAX_HOSTILES = 10;
export const WAVE_PAUSE_S = 1.8;
export const FRIENDLY_BASE_SPEED = 40;
export const FRIENDLY_MIN_SPEED = 25;
export const FRIENDLY_MAX_SPEED = 90;
export const STEER_ACCEL = 170;
export const R_FRIENDLY_FRIENDLY = 32;
export const R_ENEMY_FRIENDLY = 28;
export const STRIKE_PANEL_CLEARANCE = 170;
export const PATH_MAX_POINTS = 300;
export const PATH_MIN_POINTS = 20;
export const PATH_SEP = 80;
export const DRIFT_JITTER = 0.5;
export const DRIFT_MAX_TURN = 0.3;
export const DEST_REACH = 24;
export const WRAP_M = 30;
export const WAVE_TIME_LIMIT_S = 30;
export const WAVE_TIME_LIMIT_MAX_LEVEL = 3;

/** Seconds allowed for a wave before it is force-advanced (Infinity = no limit). */
export function waveTimeLimit(level: number): number {
  return level <= WAVE_TIME_LIMIT_MAX_LEVEL ? WAVE_TIME_LIMIT_S : Infinity;
}

export const KEYMAP: Record<string, string> = {
  KeyW: "U", ArrowUp: "U", KeyA: "L", ArrowLeft: "L",
  KeyS: "D", ArrowDown: "D", KeyD: "R", ArrowRight: "R",
};

export const GAME_END_REASONS = {
  hostileHit: "FRIENDLY HIT BY HOSTILE",
  friendlyCollision: "FRIENDLY COLLISION",
  pingTimeout: (seconds: number) => `PING NOT IDENTIFIED WITHIN ${seconds.toFixed(1)} SECONDS`,
} as const;

export function hashStr(value: string): number {
  let h = 1779033703 ^ value.length;
  for (let i = 0; i < value.length; i++) {
    h = Math.imul(h ^ value.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Keep stream names and seed separators identical to the browser/replay. */
export function dailyStreamSeed(dailySeed: string, stream: "friendly" | "enemy" | "ghost"): number {
  return hashStr(`${dailySeed}|${stream}`);
}

export function entityStreamSeed(dailySeed: string, stream: "drift" | "path" | "espawn", index: number): number {
  return hashStr(`${dailySeed}|${stream}|${index}`);
}

export function waveSpec(level: number, wave: number) {
  const extra = Math.max(0, wave - 3);
  const planes = Math.min(MAX_FRIENDLIES, Math.floor(level / 2) + 1);
  const enemies = wave >= 2
    ? Math.min(MAX_HOSTILES, Math.ceil(level / 2) + extra)
    : 0;
  const ping = wave >= 3
    ? Math.max(MIN_PING_GAP_S, 6.5 - 0.5 * level)
    : 0;
  return {
    planes,
    enemies,
    ping,
    speed: wave >= 2 ? Math.min(120, 35 + 5 * (level - 1) + 3 * extra) : 0,
    maxGhosts: wave >= 3 ? Math.min(6, 3 + Math.ceil(level / 2)) : 0,
    ghostR: Math.max(20, 28 - 0.6 * (level - 1) - 0.4 * extra),
    drift: Math.min(2, 1 + 0.05 * (level - 1) + 0.05 * extra),
  };
}

export function nextWave(level: number, wave: number): { level: number; wave: number } {
  const wavesInLevel = level < 10 ? 3 : Infinity;
  return wave < wavesInLevel
    ? { level, wave: wave + 1 }
    : { level: level + 1, wave: 1 };
}

export function destinationPoints(pathLen: number, age: number): number {
  const fastT = pathLen / FRIENDLY_MAX_SPEED;
  const slowT = 3 * pathLen / FRIENDLY_BASE_SPEED;
  const k = Math.max(0, Math.min(1, 1 - (age - fastT) / (slowT - fastT)));
  return Math.round(PATH_MIN_POINTS + (PATH_MAX_POINTS - PATH_MIN_POINTS) * k);
}
