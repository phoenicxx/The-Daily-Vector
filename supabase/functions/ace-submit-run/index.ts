import {
  replayInputLog,
  type RunInputLog,
} from "./replay/gameReplay.ts";

const MAX_BODY_BYTES = 8_000_000;
const MAX_EVENTS = 100_000;
const MAX_EVENT_TIME_MS = 24 * 60 * 60 * 1000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RunSession = Record<string, unknown>;
type Account = { id: string; name: string };
type Dependencies = {
  getSession(id: string): Promise<RunSession | null>;
  getAccount(id: string): Promise<Account | null>;
  complete(
    id: string,
    tokenHash: string,
    accountId: string,
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

function isPuzzleDay(value: unknown): boolean {
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
    31,
  ];
  return month >= 1 && month <= 12 && date >= 1 &&
    date <= monthLengths[month - 1];
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
    invalid("Replay input invalid: input_log must be an object");
  }
  const value = log as RunInputLog;
  if (
    !value.metadata || !Array.isArray(value.events) ||
    typeof value.overflow !== "boolean"
  ) invalid("Replay input invalid: metadata, events, or overflow is missing");
  if (value.events.length < 2 || value.events.length > MAX_EVENTS) {
    invalid(`Replay input invalid: event count ${value.events.length} is outside 2..${MAX_EVENTS}`);
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
    invalid("Replay input invalid: recorded field dimensions are invalid");
  }
  let prior = -1;
  for (const event of value.events) {
    if (
      !Array.isArray(event) || event.length < 3 || !Number.isFinite(event[0]) ||
      !Number.isSafeInteger(event[1]) || typeof event[2] !== "string"
    ) invalid(`Replay input invalid: malformed event at index ${value.events.indexOf(event)}`);
    if (event[0] < prior || event[0] > MAX_EVENT_TIME_MS) {
      invalid(`Replay input invalid: event time is invalid at sequence ${event[1]}`);
    }
    prior = event[0];
    if (
      event.some((field) =>
        typeof field === "number" &&
        (!Number.isFinite(field) || Math.abs(field) > 10_000_000)
      )
    ) {
      invalid(`Replay input invalid: numeric value is invalid at sequence ${event[1]}`);
    }
  }
  if (JSON.stringify(log).length > MAX_BODY_BYTES) {
    invalid("INPUT_LOG_TOO_LARGE");
  }
}

export function createHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, apikey, content-type",
          "access-control-allow-methods": "POST, OPTIONS",
        },
      });
    }
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
      input.account_name.length > 50
    ) return response(400, { ok: false, error: "MISSING_FIELDS" });
    if (!Object.hasOwn(input, "input_log") || input.input_log == null) {
      return response(400, { ok: false, error: "MISSING_INPUT_LOG" });
    }
    try {
      const session = await deps.getSession(input.session_id);
      if (!session) {
        return response(403, { ok: false, error: "INVALID_SESSION" });
      }
      const expiry = Date.parse(String(session.expires_at ?? ""));
      const storedHash = String(session.token_hash ?? "").toLowerCase();
      const accountId = String(session.account_id ?? "");
      const day = Number(session.puzzle_day);
      if (
        !/^[1-9]\d*$/.test(accountId) ||
        !isPuzzleDay(session.puzzle_day) ||
        !Number.isSafeInteger(day) || !Number.isFinite(expiry)
      ) return response(403, { ok: false, error: "INVALID_SESSION" });
      if (expiry <= deps.now()) {
        return response(403, { ok: false, error: "SESSION_EXPIRED" });
      }
      if (session.status === "completed") {
        return response(409, { ok: false, error: "SESSION_USED" });
      }
      if (session.status !== "active") {
        return response(403, { ok: false, error: "INVALID_SESSION" });
      }
      if (!storedHash || await sha256Hex(input.token) !== storedHash) {
        return response(403, { ok: false, error: "INVALID_SESSION" });
      }
      const account = await deps.getAccount(accountId);
      if (!account || account.id !== accountId) {
        return response(403, { ok: false, error: "INVALID_SESSION" });
      }
      if (input.account_name !== account.name) {
        return response(403, { ok: false, error: "WRONG_ACCOUNT" });
      }
      validateLogShape(input.input_log, input.session_id, day);
      if (input.input_log.metadata.seed !== `${day}|daily`) {
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
        accountId,
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
        const detail = message.startsWith("Replay input invalid:")
          ? message.slice("Replay input invalid: ".length).slice(0, 180)
          : message === "SESSION_MISMATCH"
          ? "run metadata does not match the server session"
          : message;
        const errorCode = message === "SESSION_MISMATCH"
          ? "SESSION_MISMATCH"
          : "INVALID_INPUT_LOG";
        return response(422, {
          ok: false,
          error: `${errorCode}: ${detail}`,
          error_code: errorCode,
          detail,
        });
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
  const base = requiredEnv("SUPABASE_URL").replace(/\/+$/, "");
  const key = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
  const handler = createHandler({
    async getSession(id) {
      const url = new URL(`${base}/rest/v1/ace_game_runs`);
      url.searchParams.set("id", `eq.${id}`);
      url.searchParams.set(
        "select",
        "id,account_id,puzzle_day,token_hash,expires_at,status",
      );
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`session lookup ${res.status}`);
      const rows = await res.json();
      return rows[0] ?? null;
    },
    async getAccount(id) {
      const url = new URL(`${base}/rest/v1/ace_accounts`);
      url.searchParams.set("id", `eq.${id}`);
      url.searchParams.set("select", "id,name");
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`account lookup ${res.status}`);
      const rows = await res.json();
      const account = rows[0];
      return account
        ? { id: String(account.id), name: String(account.name) }
        : null;
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
