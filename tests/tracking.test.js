import assert from "node:assert/strict";
import test from "node:test";
import { api, seedTour, startServer } from "./helpers.js";

test("追踪：扫箱号返回当前责任人、封签链和缺件状态", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  await seedTour(server.base);
  await api(server.base, "POST", "/tours/tour-1/plan", {});
  await api(server.base, "POST", "/legs/leg-1/manifest/seal", {
    seals: [
      { caseId: "prop-018", sealId: "S-700812" },
      { caseId: "costume-003", sealId: "S-700813" },
      { caseId: "lamp-002", sealId: "S-700814" },
    ],
    actor: "张三",
    at: "2026-09-24T10:00:00+08:00",
  });
  // 途中验封 + 清点（少了一件道具盾）
  await api(server.base, "POST", "/scans/sync", {
    scans: [
      { deviceId: "scanner-1", deviceSeq: 1, caseId: "prop-018", action: "verify_seal", sealId: "S-700812", at: "2026-09-25T09:30:00+08:00", actor: "器材主管" },
      { deviceId: "scanner-1", deviceSeq: 2, caseId: "prop-018", action: "item_check", foundItemIds: ["sword-1"], at: "2026-09-25T09:35:00+08:00" },
    ],
  });
  await api(server.base, "POST", "/handovers", {
    id: "HO-30", tourId: "tour-1", legId: "leg-1", city: "成都",
    fromParty: "车队A", toParty: "成都剧场", caseIds: ["prop-018"],
    dueAt: "2026-09-25T17:00:00+08:00",
  });
  await api(server.base, "POST", "/handovers/HO-30/confirm", { actor: "器材主管", at: "2026-09-25T16:00:00+08:00" });

  const { status, body } = await api(server.base, "GET", "/cases/prop-018/tracking");
  assert.equal(status, 200);
  // 当前责任人：交接确认后的接收方
  assert.equal(body.custodian.party, "成都剧场");
  assert.equal(body.custodian.source, "handover");
  // 封签链：封舱施加 → 途中验封，按时间排列
  assert.deepEqual(
    body.sealChain.map((e) => [e.sealId, e.action]),
    [["S-700812", "apply"], ["S-700812", "verify"]],
  );
  // 缺件：道具盾不在清点结果中
  assert.deepEqual(body.contents.missingItemIds, ["shield-2"]);
  assert.equal(body.status, "normal");
});

test("追踪：未交接的箱责任人为起运方", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  await seedTour(server.base);
  const { body } = await api(server.base, "GET", "/cases/prop-018/tracking");
  assert.equal(body.custodian.source, "origin");
  assert.match(body.custodian.note, /上海/);
});
