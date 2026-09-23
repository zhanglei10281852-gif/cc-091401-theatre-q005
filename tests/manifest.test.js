import assert from "node:assert/strict";
import test from "node:test";
import { api, seedTour, startServer } from "./helpers.js";

const SEALS = [
  { caseId: "prop-018", sealId: "S-700812" },
  { caseId: "costume-003", sealId: "S-700813" },
  { caseId: "lamp-002", sealId: "S-700814" },
];

async function planned(base) {
  await seedTour(base);
  await api(base, "POST", "/tours/tour-1/plan", {});
}

test("封舱清单：固化后生成稳定摘要，重复封舱幂等", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  await planned(server.base);

  const first = await api(server.base, "POST", "/legs/leg-1/manifest/seal", { seals: SEALS, actor: "张三", at: "2026-09-24T10:00:00+08:00" });
  assert.equal(first.status, 201);
  assert.match(first.body.manifest.digest, /^[0-9a-f]{64}$/);
  assert.equal(first.body.idempotent, false);

  // 相同内容重复封舱 → 幂等返回同一摘要
  const again = await api(server.base, "POST", "/legs/leg-1/manifest/seal", { seals: SEALS, actor: "李四", at: "2026-09-24T11:00:00+08:00" });
  assert.equal(again.status, 201);
  assert.equal(again.body.idempotent, true);
  assert.equal(again.body.manifest.digest, first.body.manifest.digest);

  const fetched = await api(server.base, "GET", "/legs/leg-1/manifest");
  assert.equal(fetched.body.manifest.digest, first.body.manifest.digest);
});

test("封舱清单：已固化不可覆盖，箱号不符拒绝并说明", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  await planned(server.base);
  await api(server.base, "POST", "/legs/leg-1/manifest/seal", { seals: SEALS, actor: "张三", at: "2026-09-24T10:00:00+08:00" });

  // 换封签编号重封 → 拒绝
  const tampered = SEALS.map((s) => (s.caseId === "prop-018" ? { ...s, sealId: "S-999999" } : s));
  const overwrite = await api(server.base, "POST", "/legs/leg-1/manifest/seal", { seals: tampered, actor: "李四" });
  assert.equal(overwrite.status, 409);
  assert.equal(overwrite.body.error.code, "manifest_immutable");

  // 少一箱 → 拒绝并列出缺箱
  const missing = await api(server.base, "POST", "/legs/leg-1/manifest/seal", { seals: SEALS.slice(0, 2), actor: "李四" });
  assert.equal(missing.status, 409);
  assert.equal(missing.body.error.code, "manifest_case_mismatch");
  assert.deepEqual(missing.body.error.reasons[0].missingCaseIds, ["lamp-002"]);
});

test("封舱清单：固化后重排不能改变该段内容", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  await planned(server.base);
  await api(server.base, "POST", "/legs/leg-1/manifest/seal", { seals: SEALS, actor: "张三", at: "2026-09-24T10:00:00+08:00" });

  // 试图把 leg-1 换车 → 被固化清单阻止
  const replan = await api(server.base, "POST", "/tours/tour-1/replan", {
    legs: [
      { id: "leg-1", vehicleId: "veh-b" },
      { id: "leg-2", vehicleId: "veh-b" },
    ],
  });
  assert.equal(replan.status, 409);
  assert.equal(replan.body.error.code, "replan_blocked");
  const reason = replan.body.error.reasons.find((r) => r.code === "manifest_immutable");
  assert.equal(reason.legId, "leg-1");
});
