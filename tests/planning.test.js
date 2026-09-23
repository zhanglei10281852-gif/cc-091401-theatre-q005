import assert from "node:assert/strict";
import test from "node:test";
import { CASES, STOPS, api, seedTour, startServer } from "./helpers.js";

test("装载计划：多城市窗口生成装载与换车计划，装卸顺序按目的站逆序", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  await seedTour(server.base);

  const { status, body } = await api(server.base, "POST", "/tours/tour-1/plan", {});
  assert.equal(status, 201);
  const plan = body.plan;
  assert.equal(plan.version, 1);
  assert.equal(plan.legs.length, 2);

  // leg-1 三箱同车：去西安的 lamp-002 最远，先装（loadOrder 1），到成都的后装
  const leg1 = plan.legs.find((leg) => leg.legId === "leg-1");
  const order = new Map(leg1.assignments.map((a) => [a.caseId, a.loadOrder]));
  assert.equal(order.get("lamp-002"), 1);
  assert.ok(order.get("prop-018") > 1);
  assert.ok(order.get("costume-003") > 1);

  // leg-2 只承运继续前往西安的 lamp-002
  const leg2 = plan.legs.find((leg) => leg.legId === "leg-2");
  assert.deepEqual(leg2.assignments.map((a) => a.caseId), ["lamp-002"]);

  // 成都换车：veh-a → veh-b
  assert.equal(plan.transfers.length, 1);
  assert.equal(plan.transfers[0].atCity, "成都");
  assert.equal(plan.transfers[0].fromVehicleId, "veh-a");
  assert.equal(plan.transfers[0].toVehicleId, "veh-b");
  assert.deepEqual(plan.transfers[0].caseIds, ["lamp-002"]);
});

test("装载计划：超重返回具体原因", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  await seedTour(server.base, {
    cases: [
      { ...CASES[0], id: "prop-heavy", weightKg: 900 },
    ],
  });
  const { status, body } = await api(server.base, "POST", "/tours/tour-1/plan", {});
  assert.equal(status, 409);
  assert.equal(body.error.code, "plan_infeasible");
  const reason = body.error.reasons.find((r) => r.code === "overweight");
  assert.ok(reason, "应包含超重原因");
  assert.equal(reason.caseId, "prop-heavy");
  assert.match(reason.detail, /900kg/);
});

test("装载计划：危险品相斥不能同舱，返回具体原因", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  // 单舱车辆：易燃喷漆与锂电池灯具必同舱
  await api(server.base, "POST", "/vehicles", { id: "veh-c", compartments: [{ id: "C1", maxWeightKg: 1000, maxVolumeL: 9000 }] });
  await api(server.base, "POST", "/tours", {
    id: "tour-hz",
    stops: [STOPS[0], STOPS[2]],
    legs: [{ id: "leg-hz", vehicleId: "veh-c" }],
  });
  await api(server.base, "POST", "/cases", {
    id: "paint-001", tourId: "tour-hz", kind: "prop", dimsCm: { l: 60, w: 60, h: 60 }, weightKg: 50,
    hazmatClass: "flammable", route: { origin: "上海", destination: "西安" },
  });
  await api(server.base, "POST", "/cases", {
    id: "lamp-010", tourId: "tour-hz", kind: "lighting", dimsCm: { l: 60, w: 60, h: 60 }, weightKg: 40,
    hazmatClass: "battery_lithium", route: { origin: "上海", destination: "西安" },
  });
  const { status, body } = await api(server.base, "POST", "/tours/tour-hz/plan", {});
  assert.equal(status, 409);
  const reason = body.error.reasons.find((r) => r.code === "incompatible_hazmat");
  assert.ok(reason, "应包含相斥原因");
  assert.deepEqual(reason.hazmat.sort(), ["battery_lithium", "flammable"]);
  assert.match(reason.detail, /相斥/);
});

test("装载计划：时间窗冲突返回具体原因", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  const compressed = [
    STOPS[0],
    {
      city: "成都",
      arriveWindow: { start: "2026-09-25T09:00:00+08:00", end: "2026-09-25T18:00:00+08:00" },
      // 装台时间被压缩：出发早于到达结束
      departWindow: { start: "2026-09-25T12:00:00+08:00", end: "2026-09-25T13:00:00+08:00" },
    },
    STOPS[2],
  ];
  const { status, body } = await api(server.base, "POST", "/tours", { id: "tour-bad", stops: compressed, legs: [
    { id: "leg-1", vehicleId: "veh-a" },
    { id: "leg-2", vehicleId: "veh-b" },
  ] });
  assert.equal(status, 409);
  assert.equal(body.error.code, "window_conflict");
  const reason = body.error.reasons.find((r) => r.code === "window_conflict");
  assert.equal(reason.city, "成都");
  assert.match(reason.detail, /时间不足/);
});
