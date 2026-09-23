import assert from "node:assert/strict";
import test from "node:test";
import { makeService, reopenService, seedTour } from "./helpers.js";

function sealsForEntries(plan, legIndex, start = 700900) {
  const ids = plan.legs[legIndex].assignments
    .slice()
    .sort((a, b) => plan.legs[legIndex].unloadSequence[a.caseId] - plan.legs[legIndex].unloadSequence[b.caseId])
    .map((a) => a.caseId);
  let next = start;
  return ids.map((caseId) => ({ caseId, seal: `S-${next++}` }));
}

test("重启后未完成交接、扫码进度与封签链通过事件重放保持连续", async () => {
  const { service, store, dir } = await makeService();
  const { plan } = await seedTour(service);
  const manifest = await service.sealManifest({
    planId: plan.planId,
    legId: plan.legs[0].legId,
    seals: sealsForEntries(plan, 0),
    sealedBy: "crew-wu",
  });
  const handover = await service.startHandover({
    legId: plan.legs[0].legId,
    manifestId: manifest.manifestId,
    fromParty: "stage-shanghai",
    toParty: "carrier-dafa",
    dueAt: "2026-09-25T18:00:00+08:00",
  });
  await service.ingestScans({
    deviceId: "PDA-SH-07",
    handoverId: handover.handoverId,
    scans: [
      { seq: 1, caseId: "light-002", seal: manifest.entries.find((e) => e.caseId === "light-002").seal, scannedAt: "2026-09-24T11:00:00+08:00" },
    ],
  });
  await store.close();

  // 模拟进程重启：新服务实例从同一事件文件重放
  const reopened = await reopenService(dir);
  const restored = reopened.service.state.handovers.get(handover.handoverId);
  assert.equal(restored.status, "pending");
  assert.equal(restored.manifestDigest, manifest.digest);
  assert.deepEqual(restored.scannedCaseIds, ["light-002"]);
  assert.equal(reopened.service.state.manifests.has(manifest.manifestId), true);

  // 重放后继续扫码合并仍然幂等
  const again = await reopened.service.ingestScans({
    deviceId: "PDA-SH-07",
    handoverId: handover.handoverId,
    scans: [
      { seq: 1, caseId: "light-002", seal: manifest.entries.find((e) => e.caseId === "light-002").seal, scannedAt: "2026-09-24T11:00:00+08:00" },
    ],
  });
  assert.deepEqual(again.duplicates, [1]);

  // 超时提醒由重放状态连续推导
  const alerts = reopened.service.alerts(new Date("2026-09-25T19:30:00+08:00"));
  const overdue = alerts.overdueHandovers.find((a) => a.handoverId === handover.handoverId);
  assert.ok(overdue);
  assert.equal(overdue.overdueMinutes, 90);
  assert.deepEqual(overdue.outstandingCaseIds.length, 9);
  await reopened.store.close();
});

test("重启后完成交接与扫码关联照常工作（离线先扫、重启、后建交接）", async () => {
  const { service, store, dir } = await makeService();
  const { plan } = await seedTour(service);
  // 上海装车时 PDA 离线，扫了全部 10 只箱，但此时尚未建交接
  const seals = sealsForEntries(plan, 0);
  await service.ingestScans({
    deviceId: "PDA-SH-07",
    scans: seals.map((s, i) => ({ seq: i + 1, ...s, scannedAt: "2026-09-24T11:00:00+08:00" })),
  });
  await store.close();

  const reopened = await reopenService(dir);
  const manifest = await reopened.service.sealManifest({
    planId: plan.planId,
    legId: plan.legs[0].legId,
    seals,
    sealedBy: "crew-wu",
  });
  // 重启后才建交接，离线扫码应自动归属
  const handover = await reopened.service.startHandover({
    legId: plan.legs[0].legId,
    manifestId: manifest.manifestId,
    fromParty: "stage-shanghai",
    toParty: "carrier-dafa",
  });
  assert.equal(handover.scannedCaseIds.length, 10);
  const done = await reopened.service.completeHandover({
    handoverId: handover.handoverId,
    receivedBy: "driver-zhang",
  });
  assert.equal(done.status, "completed");
  await reopened.store.close();
});

test("事件日志物理上只追加：历史交接记录仍保留原始字段", async () => {
  const { service, store, dir } = await makeService();
  const { plan } = await seedTour(service);
  const manifest = await service.sealManifest({
    planId: plan.planId,
    legId: plan.legs[0].legId,
    seals: sealsForEntries(plan, 0),
    sealedBy: "crew-wu",
  });
  const handover = await service.startHandover({
    legId: plan.legs[0].legId,
    fromParty: "stage-shanghai",
    toParty: "carrier-dafa",
  });
  const seals = sealsForEntries(plan, 0);
  await service.ingestScans({
    deviceId: "PDA-SH-07",
    handoverId: handover.handoverId,
    scans: seals.map((s, i) => ({ seq: i + 1, ...s, scannedAt: "2026-09-24T11:00:00+08:00" })),
  });
  await service.completeHandover({ handoverId: handover.handoverId, receivedBy: "driver-zhang" });
  await store.close();

  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(`${dir}/events.jsonl`, "utf8");
  const events = raw.trim().split("\n").map((line) => JSON.parse(line));
  const started = events.find((e) => e.type === "handover_started");
  const completed = events.find((e) => e.type === "handover_completed");
  assert.ok(started && completed);
  // started 事件里的 status 永远是 pending，completed 是独立追加事件，不覆盖前者
  assert.equal(started.payload.status, "pending");
  assert.equal(completed.payload.status, "completed");
  assert.notEqual(started.eventId, completed.eventId);
});
