/**
 * M4 serve wiring tests (SPEC §15, §16): `startServer` brings up the whole
 * control plane on an ephemeral port over an in-memory store — the web/
 * dashboard at `/` (index.html + app.js), the bearer-auth API, and a
 * `close()` that releases the port and leaves no handles behind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { startServer, DEFAULT_SERVE_PORT, type StartServerHandle } from "../src/server/serve.js";

const SECRET = "serve-test-secret";

test("startServer: web dashboard + API on an ephemeral port, clean close", async () => {
  // Capture the startup banner (`decompi: serving on http://127.0.0.1:<port>`).
  const chunks: string[] = [];
  const stdout = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const original = stdout.write.bind(process.stdout);
  stdout.write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  let handle: StartServerHandle | null = null;
  try {
    handle = await startServer({
      port: 0,
      dbPath: ":memory:",
      authTokens: [{ id: "tok-serve", secret: SECRET }],
    });
  } finally {
    stdout.write = original;
  }
  assert.ok(handle !== null, "startServer resolved");
  assert.equal(DEFAULT_SERVE_PORT, 8787);

  const address = handle.server.address();
  assert.ok(address !== null && typeof address === "object", "server is listening");
  const base = `http://127.0.0.1:${address.port}`;
  assert.match(
    chunks.join(""),
    new RegExp(`decompi: serving on http://127\\.0\\.0\\.1:${address.port}`),
    "startup banner names the bound address",
  );

  try {
    // GET /api/health returns 200 with the provisioned bearer token (SPEC
    // §16: every API endpoint requires auth).
    const health = await fetch(`${base}/api/health`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { status: string }).status, "ok");

    // GET / serves index.html as text/html (static files need no token).
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await index.text(), /<title>Decompi · control plane<\/title>/);

    // GET /app.js serves the dashboard script.
    const app = await fetch(`${base}/app.js`);
    assert.equal(app.status, 200);
    assert.match(app.headers.get("content-type") ?? "", /^application\/javascript/);

    // Unknown static paths 404 without reaching the API.
    const missing = await fetch(`${base}/nope.js`);
    assert.equal(missing.status, 404);

    // The API still enforces auth — no token, no health.
    const unauth = await fetch(`${base}/api/health`);
    assert.equal(unauth.status, 401);

    // close() shuts down cleanly and is idempotent: the port is released (a
    // fresh listener can bind it immediately) and the old server refuses
    // connections — no hanging handles keep anything alive.
    await handle.close();
    await handle.close();
    await assert.rejects(fetch(`${base}/api/health`), /fetch failed/);

    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(address.port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  } finally {
    await handle.close().catch(() => undefined);
  }
});
