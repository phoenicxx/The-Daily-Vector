import { createHandler } from "./supabase/functions/ace-submit-run/index.ts";
import genuineLog from "./fixtures/genuine-run.json" with { type: "json" };
import {
  replayInputLog,
  type RunInputLog,
} from "./supabase/functions/ace-submit-run/replay/gameReplay.ts";

const capturedLog = genuineLog as RunInputLog;
const SESSION_ID = capturedLog.metadata.sessionId!;
const TOKEN = "test-token-with-more-than-thirty-two-characters";
const DAY = capturedLog.metadata.day;
const NOW = Date.now();

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function setup(overrides: Record<string, unknown> = {}) {
  let completed = false;
  const writes: unknown[] = [];
  const session = {
    id: SESSION_ID,
    account_id: "42",
    token_hash: "",
    puzzle_day: DAY,
    expires_at: new Date(NOW + 60_000).toISOString(),
    status: "active",
    ...overrides,
  };
  const handler = createHandler({
    async getSession(id) {
      return id === SESSION_ID ? session : null;
    },
    async getAccount(id) {
      return id === "42" ? { id: "42", name: "VECTOR PLAYER" } : null;
    },
    async complete(id, tokenHash, accountId, day, score) {
      if (
        completed || id !== session.id || tokenHash !== session.token_hash ||
        accountId !== session.account_id ||
        day !== session.puzzle_day ||
        session.status !== "active" ||
        Date.parse(String(session.expires_at)) <= NOW
      ) throw new Error("SESSION_USED");
      completed = true;
      session.status = "completed";
      writes.push(score);
      return "score-verified";
    },
    now: () => NOW,
  });
  return { handler, session, writes };
}

async function request(
  handler: (r: Request) => Promise<Response>,
  extra: Record<string, unknown> = {},
) {
  return await handler(
    new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: SESSION_ID,
        token: TOKEN,
        account_name: "VECTOR PLAYER",
        input_log: structuredClone(capturedLog),
        ...extra,
      }),
    }),
  );
}

Deno.test("genuine captured run passes strict replay and completes its session", async () => {
  const { handler, session, writes } = setup();
  session.token_hash = await sha256(TOKEN);
  const response = await request(handler);
  if (response.status !== 200 || writes.length !== 1) {
    throw new Error(
      "genuine captured tape did not complete after strict replay",
    );
  }
  const score = writes[0] as Record<string, unknown>;
  if (
    score.points !== 1558 || score.time_ms !== 36316 || score.waves !== 2 ||
    score.ending_reason !== "FRIENDLY HIT BY HOSTILE"
  ) throw new Error("score was not derived from the genuine captured replay");
});

Deno.test("forged client score fields are ignored", async () => {
  const { handler, session, writes } = setup();
  session.token_hash = await sha256(TOKEN);
  const response = await request(handler, {
    points: 999999999,
    time_ms: 1,
    waves: 999,
    ending_reason: "WIN",
  });
  if (
    response.status !== 200 || writes.length !== 1 || writes[0] === 999999999
  ) {
    throw new Error(
      "forged score fields were not ignored in favor of replay result",
    );
  }
});

Deno.test("malformed input log is rejected", async () => {
  const { handler, session } = setup();
  session.token_hash = await sha256(TOKEN);
  const response = await request(handler, {
    input_log: { ...capturedLog, overflow: true },
  });
  if (response.status < 400) throw new Error("overflowed tape was accepted");
});

Deno.test("forged session ID and modified input log are rejected", async () => {
  const { handler, session } = setup();
  session.token_hash = await sha256(TOKEN);
  const forgedId = await request(handler, {
    session_id: "11111111-1111-4111-8111-111111111111",
  });
  if (forgedId.status !== 403) throw new Error("forged session ID accepted");
  const changed = structuredClone(capturedLog);
  const frame = changed.events.find((event) => event[2] === "FRAME");
  if (!frame) throw new Error("fixture has no frame event");
  frame[3] = 50_001;
  const modified = await request(handler, { input_log: changed });
  if (modified.status < 400) throw new Error("modified input log accepted");
});

Deno.test("forced game over and invalid replay are rejected", async () => {
  const { handler, session } = setup();
  session.token_hash = await sha256(TOKEN);
  const forced = structuredClone(capturedLog);
  forced.events.at(-1)![3] = "PING NOT IDENTIFIED WITHIN 3.0 SECONDS";
  const forcedResponse = await request(handler, { input_log: forced });
  if (forcedResponse.status < 400) throw new Error("forced game over accepted");
  const invalid = structuredClone(capturedLog);
  invalid.events.splice(1, 1);
  const invalidResponse = await request(handler, { input_log: invalid });
  if (invalidResponse.status < 400) throw new Error("invalid replay accepted");
});

Deno.test("expired session is rejected", async () => {
  const { handler, session } = setup({
    expires_at: new Date(NOW - 1).toISOString(),
  });
  session.token_hash = await sha256(TOKEN);
  const response = await request(handler);
  if (
    response.status !== 403 ||
    (await response.json()).error !== "SESSION_EXPIRED"
  ) throw new Error("expired session accepted");
});

Deno.test("completed session cannot be reused", async () => {
  const { handler, session } = setup({
    status: "completed",
  });
  session.token_hash = await sha256(TOKEN);
  const response = await request(handler);
  if (response.status !== 409) throw new Error("reused session accepted");
});

Deno.test("unknown run status is rejected", async () => {
  const { handler, session } = setup({ status: "revoked" });
  session.token_hash = await sha256(TOKEN);
  const response = await request(handler);
  if (response.status !== 403) {
    throw new Error("non-active session was accepted");
  }
});

Deno.test("successful session is single-use", async () => {
  const { handler, session, writes } = setup();
  session.token_hash = await sha256(TOKEN);
  const first = await request(handler);
  const second = await request(handler);
  if (first.status !== 200 || second.status !== 409 || writes.length !== 1) {
    throw new Error("session did not complete exactly once");
  }
});

Deno.test("wrong token and mismatched daily seed are rejected", async () => {
  const { handler, session } = setup();
  session.token_hash = await sha256(TOKEN);
  const wrongToken = await request(handler, {
    token: "another-token-with-more-than-32-characters",
  });
  if (wrongToken.status !== 403) throw new Error("wrong token was accepted");

  const log = structuredClone(capturedLog);
  log.metadata.seed = `${DAY - 1}|daily`;
  const wrongSeed = await request(handler, { input_log: log });
  if (wrongSeed.status !== 422) {
    throw new Error("wrong daily seed was accepted");
  }
});

Deno.test("missing account linkage and invalid puzzle day are rejected", async () => {
  const { handler, session } = setup({ account_id: undefined });
  session.token_hash = await sha256(TOKEN);
  const noAccount = await request(handler);
  if (noAccount.status !== 403) {
    throw new Error("run without account_id was accepted");
  }

  const invalidDay = setup({ puzzle_day: "20260230" });
  invalidDay.session.token_hash = await sha256(TOKEN);
  const response = await request(invalidDay.handler);
  if (response.status !== 403) {
    throw new Error("invalid puzzle day was accepted");
  }
});

Deno.test("wrong account assertion is rejected", async () => {
  const { handler, session } = setup();
  session.token_hash = await sha256(TOKEN);
  const response = await request(handler, { account_name: "SOMEONE ELSE" });
  if (
    response.status !== 403 || (await response.json()).error !== "WRONG_ACCOUNT"
  ) throw new Error("wrong account accepted");
});

Deno.test("operator wave skip is rejected", async () => {
  const { handler, session } = setup();
  session.token_hash = await sha256(TOKEN);
  const log = structuredClone(capturedLog);
  log.events[1][2] = "DEBUG_WAVE_SKIP";
  const response = await request(handler, { input_log: log });
  if (response.status < 400) {
    throw new Error("operator/debug tape was accepted");
  }
});

Deno.test("invalid ending reason is rejected", async () => {
  const { handler, session } = setup();
  session.token_hash = await sha256(TOKEN);
  const log = structuredClone(capturedLog);
  log.events.at(-1)![3] = "PLAYER CLAIMED WIN";
  const response = await request(handler, { input_log: log });
  if (response.status < 400) {
    throw new Error("invalid ending reason was accepted");
  }
});
