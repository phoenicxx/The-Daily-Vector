import {
  replayInputLog,
  type RunInputLog,
} from "../../../replay/gameReplay.ts";

const MAX_BODY_BYTES = 8_000_000;
const MAX_EVENTS = 100_000;
const MAX_EVENT_TIME_MS = 24 * 60 * 60 * 1000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RunSession = Record<string, unknown>;
type Dependencies = {
  getSession(id: string): Promise<RunSession | null>;
  complete(
    id: string,
    tokenHash: string,
    name: string,
    day: number,
    score: {
      points: number;
      time_ms: number;
      waves: number;
      ending_reason: string;
    },
  ): Promise<string>;
  now(): number;
};

function response(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, apikey, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}

function invalid(message: string): never {
  throw new Error(message);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function validateLogShape(
  log: unknown,
  sessionId: string,
  day: number,
): asserts log is RunInputLog {
  if (!log || typeof log !== "object" || Array.isArray(log)) {
    invalid("INVALID_INPUT_LOG");
  }
  const value = log as RunInputLog;
  if (
    !value.metadata || !Array.isArray(value.events) ||
    typeof value.overflow !== "boolean"
  ) invalid("INVALID_INPUT_LOG");
  if (value.events.length < 2 || value.events.length > MAX_EVENTS) {
    invalid("INVALID_INPUT_LOG");
  }
  if (value.metadata.sessionId !== sessionId || value.metadata.day !== day) {
    invalid("SESSION_MISMATCH");
  }
  if (
    !Number.isFinite(value.metadata.width) ||
    !Number.isFinite(value.metadata.height) ||
    value.metadata.width < 1 || value.metadata.height < 1 ||
    value.metadata.width > 10_000 || value.metadata.height > 10_000
  ) {
    invalid("INVALID_INPUT_LOG");
  }
  let prior = -1;
  for (const event of value.events) {
    if (
      !Array.isArray(event) || event.length < 3 || !Number.isFinite(event[0]) ||
      !Number.isSafeInteger(event[1]) || typeof event[2] !== "string"
    ) invalid("INVALID_INPUT_LOG");
    if (event[0] < prior || event[0] > MAX_EVENT_TIME_MS) {
      invalid("INVALID_INPUT_LOG");
    }
    prior = event[0];
    if (
      event.some((field) =>
        typeof field === "number" &&
        (!Number.isFinite(field) || Math.abs(field) > 10_000_000)
      )
    ) {
      invalid("INVALID_INPUT_LOG");
    }
  }
  if (JSON.stringify(log).length > MAX_BODY_BYTES) {
    invalid("INPUT_LOG_TOO_LARGE");
  }
}

export function createHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return response(204, {});
    if (request.method !== "POST") {
      return response(405, { ok: false, error: "METHOD_NOT_ALLOWED" });
    }
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_BODY_BYTES) {
      return response(413, { ok: false, error: "REQUEST_TOO_LARGE" });
    }
    let input: Record<string, unknown>;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
        return response(413, { ok: false, error: "REQUEST_TOO_LARGE" });
      }
      input = JSON.parse(text);
    } catch {
      return response(400, { ok: false, error: "INVALID_JSON" });
    }
    if (
      !input || typeof input !== "object" || Array.isArray(input) ||
      typeof input.session_id !== "string" || !UUID.test(input.session_id) ||
      typeof input.token !== "string" || input.token.length < 32 ||
      input.token.length > 512 ||
      typeof input.account_name !== "string" || input.account_name.length < 1 ||
      input.account_name.length > 50 ||
      !Object.hasOwn(input, "input_log")
    ) return response(400, { ok: false, error: "MISSING_FIELDS" });
    try {
      const session = await deps.getSession(input.session_id);
      if (!session) {
        return response(403, { ok: false, error: "INVALID_SESSION" });
      }
      const expiry = Date.parse(String(session.expires_at ?? ""));
      const storedHash = String(session.token_hash ?? "").toLowerCase();
      const accountName = String(session.account_name ?? session.name ?? "");
      const day = Number(session.puzzle_day ?? session.day);
      const seed = String(session.seed ?? "");
      if (
        !accountName || !/^\d{8}$/.test(String(day)) || !Number.isFinite(expiry)
      ) return response(403, { ok: false, error: "INVALID_SESSION" });
      if (seed !== `${day}|daily`) {
        return response(403, { ok: false, error: "INVALID_SESSION" });
      }
      if (expiry <= deps.now()) {
        return response(403, { ok: false, error: "SESSION_EXPIRED" });
      }
      if (input.account_name !== accountName) {
        return response(403, { ok: false, error: "WRONG_ACCOUNT" });
      }
      if (
        session.completed_at || session.used_at || session.completed === true ||
        session.used === true
      ) {
        return response(409, { ok: false, error: "SESSION_USED" });
      }
      if (!storedHash || await sha256Hex(input.token) !== storedHash) {
        return response(403, { ok: false, error: "INVALID_SESSION" });
      }
      validateLogShape(input.input_log, input.session_id, day);
      if (input.input_log.metadata.seed !== seed) {
        return response(422, { ok: false, error: "SESSION_MISMATCH" });
      }
      const outcome = replayInputLog(input.input_log);
      const result = outcome.result;
      if (
        !outcome.terminal || !result || !Number.isSafeInteger(result.points) ||
        !Number.isSafeInteger(result.timeMs) ||
        !Number.isSafeInteger(result.waves) ||
        result.points < 0 || result.timeMs < 0 || result.waves < 0 ||
        ![
          "FRIENDLY HIT BY HOSTILE",
          "FRIENDLY COLLISION",
          "PING NOT IDENTIFIED WITHIN 3.0 SECONDS",
        ].includes(result.reason)
      ) {
        return response(422, { ok: false, error: "INVALID_TERMINAL_RESULT" });
      }
      if (
        input.input_log.events.some((event) => event[2] === "DEBUG_WAVE_SKIP")
      ) {
        return response(422, { ok: false, error: "DEBUG_RUN_NOT_RANKED" });
      }
      const scoreId = await deps.complete(
        input.session_id,
        storedHash,
        accountName,
        day,
        {
          points: result.points,
          time_ms: result.timeMs,
          waves: result.waves,
          ending_reason: result.reason,
        },
      );
      return response(200, { ok: true, score_id: scoreId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.startsWith("Replay input invalid:") ||
        message === "INVALID_INPUT_LOG" || message === "SESSION_MISMATCH"
      ) {
        return response(422, { ok: false, error: "INVALID_INPUT_LOG" });
      }
      if (message === "INPUT_LOG_TOO_LARGE") {
        return response(413, { ok: false, error: message });
      }
      if (message === "SESSION_USED") {
        return response(409, { ok: false, error: message });
      }
      console.error("ace-submit-run failed", message);
      return response(500, { ok: false, error: "SUBMISSION_FAILED" });
    }
  };
}

function requiredEnv(key: string): string {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

if (import.meta.main) {
  const url = requiredEnv("SUPABASE_URL");
  const base = url.replace(/\/$/, "");
  const key = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
  const handler = createHandler({
    async getSession(id) {
      const res = await fetch(
        `${base}/rest/v1/ace_game_runs?id=eq.${id}&select=*`,
        { headers },
      );
      if (!res.ok) throw new Error(`session lookup ${res.status}`);
      const rows = await res.json();
      return rows[0] ?? null;
    },
    async complete(id, tokenHash, name, day, score) {
      const res = await fetch(`${base}/rest/v1/rpc/ace_complete_verified_run`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          p_session_id: id,
          p_token_hash: tokenHash,
          p_name: name,
          p_day: day,
          p_points: score.points,
          p_time_ms: score.time_ms,
          p_waves: score.waves,
          p_ending_reason: score.ending_reason,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (data?.message === "SESSION_USED") throw new Error("SESSION_USED");
        throw new Error(
          `atomic completion failed ${res.status}: ${
            data?.message ?? "unknown"
          }`,
        );
      }
      return String(data);
    },
    now: () => Date.now(),
  });
  Deno.serve(handler);
}
