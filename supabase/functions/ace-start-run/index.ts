const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Dependencies = {
  isDeviceBanned(hash: string): Promise<boolean>;
  login(name: string, pin: string): Promise<{ id: string; name: string } | null>;
  createRun(run: Record<string, unknown>): Promise<void>;
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

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function validDay(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  const text = String(value);
  if (!/^\d{8}$/.test(text)) return false;
  const date = new Date(Date.UTC(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8))));
  return date.toISOString().slice(0, 10).replaceAll("-", "") === text;
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
    if (request.method !== "POST") return response(405, { ok: false, error: "METHOD_NOT_ALLOWED" });
    let input: Record<string, unknown>;
    try {
      input = await request.json();
    } catch {
      return response(400, { ok: false, error: "INVALID_JSON" });
    }
    if (!input || typeof input !== "object" || Array.isArray(input) ||
      typeof input.device_id !== "string" || !DEVICE_ID.test(input.device_id) ||
      typeof input.name !== "string" || input.name.length < 1 || input.name.length > 50 ||
      typeof input.pin !== "string" || !/^\d{4,6}$/.test(input.pin) || !validDay(input.day)) {
      return response(400, { ok: false, error: "MISSING_FIELDS" });
    }
    try {
      const deviceHash = await sha256Hex(input.device_id);
      if (await deps.isDeviceBanned(deviceHash)) return response(403, { ok: false, error: "DEVICE_BANNED" });
      const account = await deps.login(input.name, input.pin);
      if (!account || !/^[1-9]\d*$/.test(account.id)) return response(403, { ok: false, error: "BAD_LOGIN" });
      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const token = [...tokenBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      const tokenHash = await sha256Hex(token);
      const sessionId = crypto.randomUUID();
      const expiresAt = new Date(deps.now() + 6 * 60 * 60 * 1000).toISOString();
      await deps.createRun({
        id: sessionId,
        account_id: account.id,
        puzzle_day: input.day,
        token_hash: tokenHash,
        device_hash: deviceHash,
        expires_at: expiresAt,
        status: "active",
      });
      return response(200, { ok: true, session_id: sessionId, token, expires_at: expiresAt, seed: `${input.day}|daily` });
    } catch (error) {
      console.error("ace-start-run failed", error instanceof Error ? error.message : String(error));
      return response(500, { ok: false, error: "SESSION_CREATION_FAILED" });
    }
  };
}

function requiredEnv(key: string): string {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

if (import.meta.main) {
  const base = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
  const key = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const headers = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };
  const handler = createHandler({
    async isDeviceBanned(hash) {
      const params = new URLSearchParams({
        device_hash: `eq.${hash}`,
        select: "device_hash",
        limit: "1",
        or: `(expires_at.is.null,expires_at.gt.${new Date().toISOString()})`,
      });
      const res = await fetch(`${base}/rest/v1/ace_device_bans?${params}`, { headers });
      if (!res.ok) throw new Error(`device ban lookup ${res.status}`);
      return (await res.json()).length > 0;
    },
    async login(name, pin) {
      const res = await fetch(`${base}/rest/v1/rpc/ace_check_login`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          p_name: name,
          p_pin: pin,
        }),
      });
    
      if (!res.ok) throw new Error(`account login ${res.status}`);
    
      const data = await res.json();
      const account = Array.isArray(data) ? data[0] : data;
    
      if (!account || account.o_err || !account.o_id) {
        return null;
      }
    
      return {
        id: String(account.o_id),
        name: String(account.o_name ?? name),
      };
    },



    async createRun(run) {
      const res = await fetch(`${base}/rest/v1/ace_game_runs`, {
        method: "POST", headers: { ...headers, prefer: "return=minimal" }, body: JSON.stringify(run),
      });
      if (!res.ok) throw new Error(`run insert ${res.status}`);
    },
    now: () => Date.now(),
  });
  Deno.serve(handler);
}
