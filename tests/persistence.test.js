import assert from "node:assert/strict";
import test from "node:test";
import { Store } from "../src/store.js";
import { api, seedTour, startServer, tempDataFile } from "./helpers.js";

test("重启后未完成交接与超时提醒保持连续", async (context) => {
  const dataFile = tempDataFile();
  const first = await startServer(dataFile);
  context.after(() => first.close());
  await seedTour(first.base);
  await api(first.base, "POST", "/handovers", {
    id: "HO-40", tourId: "tour-1", city: "成都",
    fromParty: "车队A", toParty: "成都剧场", caseIds: ["prop-018"],
    dueAt: "2026-09-25T17:00:00+08:00",
  });
  // 触发一次超时提醒
  const before = await api(first.base, "GET", "/reminders?now=" + encodeURIComponent("2026-09-25T18:00:00+08:00"));
  assert.equal(before.body.reminders.length, 1);
  await first.close();

  // 模拟重启：从同一事件日志重放
  const second = await startServer(dataFile);
  context.after(() => second.close());
  const pending = await api(second.base, "GET", "/handovers/pending?now=" + encodeURIComponent("2026-09-25T19:00:00+08:00"));
  assert.equal(pending.body.handovers.length, 1);
  assert.equal(pending.body.handovers[0].id, "HO-40");
  assert.equal(pending.body.handovers[0].overdue, true);
  assert.equal(pending.body.handovers[0].reminded, true);

  // 提醒不重复触发
  const after = await api(second.base, "GET", "/reminders?now=" + encodeURIComponent("2026-09-25T20:00:00+08:00"));
  assert.equal(after.body.reminders.length, 1);
  assert.equal(after.body.reminders[0].firedAt, before.body.reminders[0].firedAt);
  await second.close();
});

test("重启后已固化清单、例外与责任人状态完整恢复", async (context) => {
  const dataFile = tempDataFile();
  const first = await startServer(dataFile);
  context.after(() => first.close());
  await seedTour(first.base);
  await api(first.base, "POST", "/tours/tour-1/plan", {});
  const sealed = await api(first.base, "POST", "/legs/leg-1/manifest/seal", {
    seals: [
      { caseId: "prop-018", sealId: "S-700812" },
      { caseId: "costume-003", sealId: "S-700813" },
      { caseId: "lamp-002", sealId: "S-700814" },
    ],
    actor: "张三",
    at: "2026-09-24T10:00:00+08:00",
  });
  await api(first.base, "POST", "/exceptions", {
    type: "hold", caseId: "prop-018", actor: "安监", reason: "抽查", at: "2026-09-25T10:00:00+08:00",
  });
  await first.close();

  // 重启：清单摘要一致，暂扣状态仍在，重复封舱仍幂等
  const second = await startServer(dataFile);
  context.after(() => second.close());
  const manifest = await api(second.base, "GET", "/legs/leg-1/manifest");
  assert.equal(manifest.body.manifest.digest, sealed.body.manifest.digest);
  const tracking = await api(second.base, "GET", "/cases/prop-018/tracking");
  assert.equal(tracking.body.status, "held");
  const reseal = await api(second.base, "POST", "/legs/leg-1/manifest/seal", {
    seals: [
      { caseId: "prop-018", sealId: "S-700812" },
      { caseId: "costume-003", sealId: "S-700813" },
      { caseId: "lamp-002", sealId: "S-700814" },
    ],
    actor: "李四",
  });
  assert.equal(reseal.body.idempotent, true);
  await second.close();

  // 事件日志只增不改
  const store = Store.open(dataFile);
  assert.ok(store.state.eventCount > 0);
});
