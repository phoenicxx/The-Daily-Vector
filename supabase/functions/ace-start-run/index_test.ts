import { createHandler } from "./index.ts";

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DAY = 20261119;

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function setup(banned = false) {
  let loginCalls = 0;
  const runs: Record<string, unknown>[] = [];
  const handler = createHandler({
    async isDeviceBanned(hash) { return banned && hash === await sha256(DEVICE_ID); },
    async login(name, pin) {
      loginCalls++;
      return name === "PLAYER" && pin === "1234" ? { id: "42", name } : null;
    },
    async createRun(run) { runs.push(run); },
    now: () => Date.UTC(2026, 10, 19),
  });
  return { handler, runs, get loginCalls() { return loginCalls; } };
}

async function request(handler: (request: Request) => Promise<Response>, deviceId = DEVICE_ID) {
  return await handler(new Request("https://example.test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "PLAYER", pin: "1234", day: DAY, device_id: deviceId }),
  }));
}

Deno.test("banned device cannot start a run even for a newly registered account", async () => {
  const test = setup(true);
  const result = await request(test.handler);
  if (result.status !== 403 || (await result.json()).error !== "DEVICE_BANNED" || test.runs.length || test.loginCalls) {
    throw new Error("banned device reached account authentication or run creation");
  }
});

Deno.test("unbanned device starts a run with its server hash stored", async () => {
  const test = setup();
  const result = await request(test.handler);
  const body = await result.json();
  if (result.status !== 200 || test.runs.length !== 1 || test.runs[0].device_hash !== await sha256(DEVICE_ID) || !body.session_id || !body.token) {
    throw new Error("valid unbanned device did not start a bound run");
  }
});

Deno.test("malformed device identifier is rejected", async () => {
  const test = setup();
  const result = await request(test.handler, "not-a-device-id");
  if (result.status !== 400 || test.runs.length) throw new Error("invalid device identifier accepted");
});
