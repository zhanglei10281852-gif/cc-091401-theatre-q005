import assert from "node:assert/strict";
import test from "node:test";
import { LEGS, api, seedTour, startServer } from "./helpers.js";

test("卸货位：确认后不能被无关重排抢走，显式释放才可调整", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  await seedTour(server.base);
  await api(server.base, "POST", "/vehicles", { id: "veh-c", compartments: [{ id: "C1", maxWeightKg: 600, maxVolumeL: 4000 }] });
  await api(server.base, "POST", "/tours/tour-1/plan", {});

  // 确认成都站 1 号卸货位给 leg-2（veh-b）
  const confirmed = await api(server.base, "POST", "/stations/成都/unloading-slots/confirm", {
    slotId: "bay-1", legId: "leg-2", actor: "场务主管",
    window: { start: "2026-09-25T09:00:00+08:00", end: "2026-09-25T12:00:00+08:00" },
  });
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.body.slot.vehicleId, "veh-b");

  // 其他段来抢同一卸货位 → 拒绝
  const grab = await api(server.base, "POST", "/stations/成都/unloading-slots/confirm", {
    slotId: "bay-1", legId: "leg-1", actor: "场务主管",
  });
  assert.equal(grab.status, 409);
  assert.equal(grab.body.error.code, "slot_conflict");

  // 无关重排（leg-2 换车）→ 被卸货位保护阻止
  const replan = await api(server.base, "POST", "/tours/tour-1/replan", {
    legs: [LEGS[0], { id: "leg-2", vehicleId: "veh-c" }],
  });
  assert.equal(replan.status, 409);
  assert.equal(replan.body.error.code, "replan_blocked");
  const reason = replan.body.error.reasons.find((r) => r.code === "slot_protected");
  assert.equal(reason.city, "成都");
  assert.equal(reason.slotId, "bay-1");

  // 显式释放后才能重排
  const released = await api(server.base, "POST", "/tours/tour-1/replan", {
    legs: [LEGS[0], { id: "leg-2", vehicleId: "veh-c" }],
    releaseSlots: [{ city: "成都", slotId: "bay-1", actor: "场务主管", reason: "剧场调整卸货口" }],
  });
  assert.equal(released.status, 201);
  assert.equal(released.body.plan.legs.find((l) => l.legId === "leg-2").vehicleId, "veh-c");
});

test("卸货位：同一分配重复确认幂等", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  await seedTour(server.base);
  await api(server.base, "POST", "/tours/tour-1/plan", {});
  const first = await api(server.base, "POST", "/stations/成都/unloading-slots/confirm", {
    slotId: "bay-2", legId: "leg-2", actor: "场务主管",
  });
  const again = await api(server.base, "POST", "/stations/成都/unloading-slots/confirm", {
    slotId: "bay-2", legId: "leg-2", actor: "场务主管",
  });
  assert.equal(first.body.idempotent, false);
  assert.equal(again.body.idempotent, true);
});
