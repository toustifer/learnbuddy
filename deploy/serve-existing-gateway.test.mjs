import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseStore } from "../plugins/dsh-plugin-learnbuddy/src/db/store.js";
import { attachReleaseRoutes } from "./serve-existing-gateway.mjs";

test("release routes precede legacy fallback while preserving existing endpoints and store", async (t) => {
  const store = new DatabaseStore({ path: ":memory:" });
  const middlewares = [async (_req, res) => { res.writeHead(202); res.end("existing backend"); }];
  attachReleaseRoutes({ store, middlewares });
  const server = http.createServer(async (req, res) => {
    for (const handler of middlewares) {
      let next = false;
      await handler(req, res, () => { next = true; });
      if (!next || res.writableEnded) return;
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const workspace = await fetch(base + "/api/learnbuddy/workspace?userId=s-yi");
  assert.equal(workspace.status, 200);
  const body = await workspace.json();
  assert.ok(body.courses.length);
  assert.ok(body.submissions.every((s) => s.studentId === "s-yi"));
  assert.deepEqual(body.roster, []);
  const untouched = await fetch(base + "/api/learnbuddy/courses?userId=s-yi");
  assert.equal(untouched.status, 202);
  assert.equal(await untouched.text(), "existing backend");
  const malformed = await fetch(base + "/api/learnbuddy/assignments", { method: "POST", body: "invalid json" });
  assert.equal(malformed.status, 400);
  const denied = await fetch(base + "/api/learnbuddy/assignments", { method: "POST", body: JSON.stringify({ userId: "s-yi", courseId: "network" }) });
  assert.equal(denied.status, 403);
});
