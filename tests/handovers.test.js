import assert from "node:assert/strict";
import test from "node:test";
import { api, seedTour, startServer } from "./helpers.js";

const SEALS = [
  { caseId: "prop-018", sealId: "S-700812" },
  { caseId: "costume-003", sealId: "S-700813" },
  { caseId: "lamp-002", sealId: "S-700814" },
];

async function seedWithManifest(base) {
  await seedTour(base);
  await api(base, "POST", "/tours/tour-1/plan", {});
  await api(base, "POST", "/legs/leg-1/manifest/seal", { seals: SEALS, actor: "张三", at: "2026-09-24T10:00:00+08:00" });
}

test("交接确认：缺箱与封条编号不符自动生成例外并评估影响", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  await seedWithManifest(server.base);
  await api(server.base, "POST", "/handovers", {
    id: "HO-14", tourId: "tour-1", legId: "leg-1", city: "成都",
    fromParty: "车队A", toParty: "成都剧场", caseIds: ["prop-018", "costume-003"],
    dueAt: "2026-09-25T17:00:00+08:00", sequence: 14,
  });

  // 抵达后少了一只箱子，且封条编号与交接记录对不上
  const confirm = await api(server.base, "POST", "/handovers/HO-14/confirm", {
    receivedCaseIds: ["prop-018"],
    observedSeals: { "prop-018": "S-700899" },
    actor: "器材主管",
    at: "2026-09-25T16:00:00+08:00",
  });
  assert.equal(confirm.status, 200);
  assert.deepEqual(confirm.body.discrepancies.missingCaseIds, ["costume-003"]);
  assert.equal(confirm.body.discrepancies.sealMismatches.length, 1);
  assert.equal(confirm.body.discrepancies.sealMismatches[0].expectedSealId, "S-700812");
  assert.equal(confirm.body.discrepancies.sealMismatches[0].observedSealId, "S-700899");

  const types = confirm.body.followUps.map((f) => f.exception.type).sort();
  assert.deepEqual(types, ["missing_case", "seal_mismatch"]);

  // 缺箱追踪状态为 missing，封签不符的箱为 compromised
  const missing = await api(server.base, "GET", "/cases/costume-003/tracking");
  assert.equal(missing.body.status, "missing");
  const tampered = await api(server.base, "GET", "/cases/prop-018/tracking");
  assert.equal(tampered.body.status, "compromised");
});

test("交接：历史交接不可被覆盖", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  await seedWithManifest(server.base);
  await api(server.base, "POST", "/handovers", {
    id: "HO-15", tourId: "tour-1", legId: "leg-1", city: "成都",
    fromParty: "车队A", toParty: "成都剧场", caseIds: ["prop-018"],
    dueAt: "2026-09-25T17:00:00+08:00",
  });
  const first = await api(server.base, "POST", "/handovers/HO-15/confirm", { actor: "器材主管", at: "2026-09-25T16:00:00+08:00" });
  assert.equal(first.status, 200);
  assert.equal(first.body.handover.status, "confirmed");

  // 再次确认（即使是相同内容）一律拒绝
  const again = await api(server.base, "POST", "/handovers/HO-15/confirm", { actor: "器材主管", at: "2026-09-25T16:05:00+08:00" });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "handover_immutable");
  assert.equal(again.body.error.reasons[0].confirmedAt, "2026-09-25T16:00:00+08:00");

  // 同 id 重复创建也拒绝
  const recreate = await api(server.base, "POST", "/handovers", {
    id: "HO-15", tourId: "tour-1", city: "成都", fromParty: "车队A", toParty: "成都剧场",
    caseIds: ["prop-018"], dueAt: "2026-09-25T17:00:00+08:00",
  });
  assert.equal(recreate.status, 409);
  assert.equal(recreate.body.error.code, "handover_exists");
});

test("超时提醒：未完成交接超期触发提醒且只触发一次", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  await seedTour(server.base);
  await api(server.base, "POST", "/handovers", {
    id: "HO-16", tourId: "tour-1", city: "成都",
    fromParty: "车队A", toParty: "成都剧场", caseIds: ["prop-018"],
    dueAt: "2026-09-25T17:00:00+08:00",
  });

  const pending = await api(server.base, "GET", "/handovers/pending?now=" + encodeURIComponent("2026-09-25T18:00:00+08:00"));
  assert.equal(pending.body.handovers.length, 1);
  assert.equal(pending.body.handovers[0].overdue, true);
  assert.equal(pending.body.handovers[0].reminded, true);

  const reminders = await api(server.base, "GET", "/reminders?now=" + encodeURIComponent("2026-09-25T19:00:00+08:00"));
  assert.equal(reminders.body.reminders.length, 1);
  assert.equal(reminders.body.reminders[0].handoverId, "HO-16");
  assert.match(reminders.body.reminders[0].message, /HO-16/);
});
