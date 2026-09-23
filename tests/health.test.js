import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";

test("健康接口返回服务标识", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "logistics-health-"));
  context.after(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });
  const server = await createApp({ dataDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await server.shutdown();
  });
  const address = server.address();
  const response = await fetch("http://127.0.0.1:" + address.port + "/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", service: "touring-logistics" });
});
