import assert from "node:assert/strict";
import test from "node:test";
import { api, seedTour, startServer } from "./helpers.js";

test("离线扫码恢复：按设备序列幂等合并，重复上报不产生重复记录", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  await seedTour(server.base);

  const batch = {
    scans: [
      { deviceId: "scanner-1", deviceSeq: 1, caseId: "prop-018", action: "load", at: "2026-09-24T08:30:00+08:00", actor: "装车工甲" },
      { deviceId: "scanner-1", deviceSeq: 2, caseId: "prop-018", action: "custody", party: "车队A", at: "2026-09-24T09:00:00+08:00" },
    ],
  };
  const first = await api(server.base, "POST", "/scans/sync", batch);
  assert.equal(first.status, 200);
  assert.equal(first.body.applied, 2);
  assert.equal(first.body.duplicates, 0);

  // 离线恢复后整批重传：全部识别为重复，返回原记录
  const replay = await api(server.base, "POST", "/scans/sync", batch);
  assert.equal(replay.body.applied, 0);
  assert.equal(replay.body.duplicates, 2);
  assert.equal(replay.body.results[0].scan.actor, "装车工甲");

  // 同一设备序列号即使内容不同也不覆盖原记录
  const conflict = await api(server.base, "POST", "/scans/sync", {
    scans: [{ deviceId: "scanner-1", deviceSeq: 1, caseId: "costume-003", action: "unload", at: "2026-09-24T10:00:00+08:00" }],
  });
  assert.equal(conflict.body.duplicates, 1);
  assert.equal(conflict.body.results[0].scan.caseId, "prop-018");

  // 责任人来自 custody 扫码，且未被重复上报改变
  const tracking = await api(server.base, "GET", "/cases/prop-018/tracking");
  assert.equal(tracking.body.custodian.party, "车队A");
});

test("破封扫码：自动追加破封例外并触发后续影响评估", async (context) => {
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
  await api(server.base, "POST", "/handovers", {
    id: "HO-14", tourId: "tour-1", legId: "leg-1", city: "成都",
    fromParty: "车队A", toParty: "成都剧场", caseIds: ["prop-018", "costume-003"],
    dueAt: "2026-09-25T17:00:00+08:00", sequence: 14,
  });

  const sync = await api(server.base, "POST", "/scans/sync", {
    scans: [{ deviceId: "scanner-2", deviceSeq: 7, caseId: "prop-018", action: "break_seal", sealId: "S-700812", at: "2026-09-25T10:00:00+08:00", actor: "器材主管" }],
  });
  assert.equal(sync.status, 200);
  const followUp = sync.body.results[0].followUp;
  assert.equal(followUp.exception.type, "seal_break");
  // 影响评估：已固化清单被标记 compromised，未完成交接被列出
  assert.equal(followUp.impact.manifests[0].effect, "compromised");
  assert.deepEqual(followUp.impact.pendingHandovers.map((h) => h.handoverId), ["HO-14"]);

  // 重复上报同一破封扫码不会重复追加例外
  const replay = await api(server.base, "POST", "/scans/sync", {
    scans: [{ deviceId: "scanner-2", deviceSeq: 7, caseId: "prop-018", action: "break_seal", sealId: "S-700812", at: "2026-09-25T10:00:00+08:00" }],
  });
  assert.equal(replay.body.duplicates, 1);
  const exceptions = await api(server.base, "GET", "/exceptions");
  assert.equal(exceptions.body.exceptions.filter((e) => e.type === "seal_break").length, 1);
});
