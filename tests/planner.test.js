import assert from "node:assert/strict";
import test from "node:test";
import {
  assignCompartments,
  checkCityWindow,
  checkHazardConflict,
  checkOverweight,
  loadingOrder,
} from "../src/domain/rules.js";
import { planLoading } from "../src/domain/planner.js";

const baseCase = {
  lengthCm: 100,
  widthCm: 100,
  heightCm: 100,
  weightKg: 100,
  hazard: "none",
};

const fleetOneTruck = (compartments, durationMinutes = 300) => [
  { vehicleId: "truck-1", durationMinutes, compartments },
];

const citiesTwo = [
  { cityId: "A", arriveAfter: "2026-09-24T08:00:00+08:00", departDeadline: "2026-09-24T20:00:00+08:00" },
  { cityId: "B", arriveAfter: "2026-09-25T08:00:00+08:00", departDeadline: "2026-09-25T20:00:00+08:00" },
];

test("装车顺序遵循后卸先装（LIFO）", () => {
  const cases = [
    { caseId: "c1", ...baseCase },
    { caseId: "c2", ...baseCase },
    { caseId: "c3", ...baseCase },
  ];
  const order = loadingOrder(cases, { c1: 1, c2: 2, c3: 3 }); // c1 最先卸
  assert.deepEqual(
    order.map((o) => o.caseId),
    ["c3", "c2", "c1"],
  );
});

test("规划通过时返回车辆、舱位分配与装卸顺序", () => {
  const cases = [
    { caseId: "prop-1", category: "prop", ...baseCase },
    { caseId: "light-1", category: "fragile_light", ...baseCase, weightKg: 120 },
  ];
  const result = planLoading({
    cities: citiesTwo,
    cases,
    fleet: fleetOneTruck([
      {
        compartmentId: "hold-1",
        lengthCm: 300,
        widthCm: 200,
        heightCm: 200,
        payloadKg: 1000,
        hazardCapable: false,
      },
    ]),
  });
  assert.equal(result.valid, true, result.reasons.join("；"));
  const leg = result.plan.legs[0];
  assert.equal(leg.vehicleId, "truck-1");
  assert.equal(leg.assignments.length, 2);
  // 灯具先卸 → 后装
  assert.deepEqual(leg.loadingOrder, ["prop-1", "light-1"]);
});

test("超重返回具体总重、上限与超出数值", () => {
  const cases = [
    { caseId: "heavy-1", category: "misc", ...baseCase, weightKg: 900 },
    { caseId: "heavy-2", category: "misc", ...baseCase, weightKg: 800 },
  ];
  const result = planLoading({
    cities: citiesTwo,
    cases,
    fleet: fleetOneTruck([
      { compartmentId: "hold-1", lengthCm: 500, widthCm: 300, heightCm: 300, payloadKg: 1000, hazardCapable: true },
    ]),
  });
  assert.equal(result.valid, false);
  const reason = result.reasons.find((r) => r.includes("超重"));
  assert.ok(reason, result.reasons);
  assert.match(reason, /1700/);
  assert.match(reason, /超出 700/);
});

test("危险品相斥：烟火与锂电池不能同舱，只有一个危险舱时拒绝并说明", () => {
  const cases = [
    { caseId: "pyro-1", category: "misc", ...baseCase, hazard: "pyrotechnic" },
    { caseId: "light-bat", category: "fragile_light", ...baseCase, hazard: "lithium_battery" },
  ];
  const direct = checkHazardConflict(cases);
  assert.equal(direct.length, 2); // 双向各一条，去重后仍反映两两关系
  const result = planLoading({
    cities: citiesTwo,
    cases,
    fleet: fleetOneTruck([
      { compartmentId: "hz-only", lengthCm: 300, widthCm: 200, heightCm: 200, payloadKg: 1000, hazardCapable: true },
    ]),
  });
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some((r) => r.includes("危险品相斥")), result.reasons.join("\n"));
});

test("危险品分舱后可行：烟火与喷雾各占独立危险舱", () => {
  const cases = [
    { caseId: "pyro-1", category: "misc", ...baseCase, weightKg: 30, hazard: "pyrotechnic" },
    { caseId: "fx-1", category: "misc", ...baseCase, weightKg: 30, hazard: "aerosol" },
  ];
  const result = planLoading({
    cities: citiesTwo,
    cases,
    fleet: fleetOneTruck([
      { compartmentId: "hz1", lengthCm: 200, widthCm: 200, heightCm: 200, payloadKg: 200, hazardCapable: true },
      { compartmentId: "hz2", lengthCm: 200, widthCm: 200, heightCm: 200, payloadKg: 200, hazardCapable: true },
    ]),
  });
  assert.equal(result.valid, true, result.reasons.join("；"));
  const byCase = Object.fromEntries(result.plan.legs[0].assignments.map((a) => [a.caseId, a.compartmentId]));
  assert.notEqual(byCase["pyro-1"], byCase["fx-1"]);
});

test("危险品不能装无适装标记的舱位", () => {
  const item = { caseId: "pyro-1", ...baseCase, hazard: "pyrotechnic" };
  const packing = assignCompartments([item], [
    { compartmentId: "plain", lengthCm: 300, widthCm: 200, heightCm: 200, payloadKg: 1000, hazardCapable: false },
  ]);
  assert.equal(packing.reasons.length, 1);
  assert.match(packing.reasons[0], /无危险品适装标记/);
});

test("时间窗冲突给出窗口、所需时长与超出分钟数", () => {
  const tight = checkCityWindow({
    cityId: "B",
    arrivalAt: Date.parse("2026-09-25T19:00:00+08:00"),
    arriveAfter: "2026-09-25T08:00:00+08:00",
    departDeadline: "2026-09-25T20:00:00+08:00",
    workMinutes: 90,
    workLabel: "卸货+装车",
  });
  assert.equal(tight.reasons.length, 1);
  assert.match(tight.reasons[0], /晚 30 分钟/);
});

test("压缩后的装台窗口导致末段不可行并返回具体原因", () => {
  const cases = [{ caseId: "c1", category: "prop", ...baseCase }];
  const cities = [
    { cityId: "A", arriveAfter: "2026-09-24T08:00:00+08:00", departDeadline: "2026-09-24T20:00:00+08:00" },
    { cityId: "B", arriveAfter: "2026-09-26T07:30:00+08:00", departDeadline: "2026-09-26T08:00:00+08:00" },
  ];
  const result = planLoading({
    cities,
    cases,
    fleet: fleetOneTruck(
      [{ compartmentId: "h", lengthCm: 300, widthCm: 200, heightCm: 200, payloadKg: 1000, hazardCapable: false }],
      2400,
    ),
  });
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some((r) => r.includes("B") && r.includes("卸货交付")), result.reasons.join("\n"));
});

test("中途时间窗只够同车中转时，规划自动换车或直接判不可行", () => {
  const cases = [{ caseId: "c1", category: "prop", ...baseCase }];
  const compartment = { compartmentId: "h", lengthCm: 300, widthCm: 200, heightCm: 200, payloadKg: 1000, hazardCapable: false };
  const cities = [
    { cityId: "A", arriveAfter: "2026-09-24T08:00:00+08:00", departDeadline: "2026-09-24T12:00:00+08:00" },
    { cityId: "B", arriveAfter: "2026-09-24T18:00:00+08:00", departDeadline: "2026-09-24T19:00:00+08:00" },
    { cityId: "C", arriveAfter: "2026-09-25T08:00:00+08:00", departDeadline: "2026-09-25T20:00:00+08:00" },
  ];
  // 慢车在 B 站窗口（60 分钟）内连卸带装（90 分钟）完不成；快车可以
  const fleet = [
    { vehicleId: "slow", durationMinutes: 300, compartments: [compartment] },
    { vehicleId: "fast", durationMinutesByLeg: { "A->B": 300, "B->C": 300 }, durationMinutes: 300, compartments: [compartment] },
  ];
  // 两车行驶一样快时，B 站 60 分钟窗口对谁都不够 90 分钟作业
  const result = planLoading({ cities, cases, fleet }, { loadMinutes: 45, unloadMinutes: 45 });
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some((r) => r.includes("A->B") || r.includes("B")), result.reasons.join("\n"));

  // B 站窗口放宽到 2 小时，首车沿用
  const cities2 = [cities[0], { ...cities[1], departDeadline: "2026-09-24T21:00:00+08:00" }, cities[2]];
  const ok = planLoading({ cities: cities2, cases, fleet });
  assert.equal(ok.valid, true, ok.reasons.join("；"));
  assert.equal(ok.plan.legs[0].transfer.switched, false);
});

test("checkOverweight 报告没有任何舱位可容纳的超大箱体", () => {
  const reasons = checkOverweight(
    [{ caseId: "giant", lengthCm: 999, widthCm: 999, heightCm: 999, weightKg: 1 }],
    [{ lengthCm: 100, widthCm: 100, heightCm: 100, payloadKg: 9999 }],
  );
  assert.ok(reasons.some((r) => r.includes("超尺寸") && r.includes("giant")));
});
