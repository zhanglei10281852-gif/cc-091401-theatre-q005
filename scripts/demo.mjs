#!/usr/bin/env node
/**
 * 巡演物流场景演示：上海 → 西安 → 成都。
 *
 * 复现题述事故：道具/服装/灯具分批托运，抵达成都后少一只服装箱、
 * 一只道具箱封条编号与交接记录对不上，成都装台窗口已被压缩。
 *
 * 用法：node scripts/demo.mjs
 * 数据写入临时目录，不影响正式 .runtime 数据。
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/storage/eventstore.js";
import { createLogisticsService } from "../src/service.js";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const cases = readJson("../reference/seed-cases.json").cases;
const fleet = readJson("../reference/seed-fleet.json").fleet;
const tour = readJson("../reference/seed-tour.json");
const scanSample = readJson("../reference/scan-sample.json");

const line = (title) => console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);

const dir = await mkdtemp(join(tmpdir(), "logistics-demo-"));
const store = new EventStore(join(dir, "events.jsonl"));
await store.open();
const svc = createLogisticsService(store);

line("1. 登记 10 只箱体（道具/服装/易碎灯具/危险品）");
console.log(await svc.registerCases(cases));

line("2. 按到离站窗口生成装载与换车计划");
const plan = await svc.createPlan({
  planId: tour.planId,
  cities: tour.cities,
  caseIds: cases.map((c) => c.caseId),
  fleet,
});
for (const leg of plan.legs) {
  console.log(`${leg.legId}  车辆=${leg.vehicleId}  抵达=${leg.scheduledArrivalAt}  作业完成=${leg.scheduledCompleteAt}`);
  console.log(`  装车顺序(后卸先装): ${leg.loadingOrder.join(" → ")}`);
  console.log(`  换车: ${leg.transfer.reason}`);
}

line("3. 固化上海→西安封舱清单（逐箱封签 + SHA-256 摘要）");
const sealsOf = (leg, start) =>
  leg.assignments.map((a, i) => ({ caseId: a.caseId, seal: `S-${start + i}` }));
const leg1 = plan.legs[0];
const manifest1 = await svc.sealManifest({
  planId: plan.planId,
  legId: leg1.legId,
  seals: sealsOf(leg1, 700811),
  sealedBy: "舞监-吴",
});
console.log(`${manifest1.manifestId} v${manifest1.version}  箱数=${manifest1.summary.caseCount}  摘要=${manifest1.digest.slice(0, 16)}…`);

line("4. 上海装车：PDA 离线扫码，到场部网络恢复后整批幂等合并");
const batch = structuredClone(scanSample);
batch.handoverId = null;
batch.scans = batch.scans.map((s) => ({
  ...s,
  seal: manifest1.entries.find((e) => e.caseId === s.caseId).seal,
}));
console.log("首次合并:", await svc.ingestScans(batch));
console.log("重复批次:", await svc.ingestScans(batch));

line("5. 上海→西安途中开始交接，西安正常签收");
const ho1 = await svc.startHandover({
  legId: leg1.legId,
  manifestId: manifest1.manifestId,
  fromParty: "上海舞台组",
  toParty: "西安舞台组",
  carrier: "大发物流",
  dueAt: "2026-09-25T18:00:00+08:00",
});
const r1 = await svc.completeHandover({ handoverId: ho1.handoverId, receivedBy: "司机张师傅" });
console.log("交接结果:", r1.status);

line("6. 固化西安→成都封舱清单（新版本封签），开始第二段交接");
const leg2 = plan.legs[1];
const manifest2 = await svc.sealManifest({
  planId: plan.planId,
  legId: leg2.legId,
  seals: sealsOf(leg2, 700911),
  sealedBy: "西安舞台组-李",
});
const ho2 = await svc.startHandover({
  legId: leg2.legId,
  manifestId: manifest2.manifestId,
  fromParty: "西安舞台组",
  toParty: "成都舞台组",
  carrier: "大发物流",
  dueAt: "2026-09-26T06:30:00+08:00",
});
console.log(`${manifest2.manifestId} v${manifest2.version} 交接 ${ho2.handoverId}`);

line("7. 抵达成都：扫了 9 只箱——服装箱 costume-012 没到，prop-018 封条对不上");
const arrivedSeals = new Map(manifest2.entries.map((e) => [e.caseId, e.seal]));
const scans = manifest2.entries
  .filter((e) => e.caseId !== "costume-012")
  .map((e, i) => ({
    seq: i + 1,
    caseId: e.caseId,
    seal: e.caseId === "prop-018" ? "S-700777" : e.seal, // 对不上交接记录
    scannedAt: "2026-09-26T06:20:00+08:00",
    location: "Chengdu-dock",
  }));
void arrivedSeals;
await svc.ingestScans({ deviceId: "PDA-CD-02", handoverId: ho2.handoverId, scans });
try {
  await svc.completeHandover({ handoverId: ho2.handoverId, receivedBy: "成都舞台组" });
} catch (error) {
  console.log("直接收尾被拒绝，原因：");
  for (const reason of error.reasons) console.log("  ✗ " + reason);
}

line("8. 只能追加例外：破封(prop-018) + 暂扣/短装(costume-012)，并触发后续影响评估");
const broken = await svc.addException({
  type: "broken_seal",
  caseId: "prop-018",
  legId: leg2.legId,
  reason: "成都卸货发现封条断裂，封条号 S-700777 与清单不符，开箱核验内物齐整",
  reportedBy: "器材主管-周",
});
console.log("破封影响:", broken.impact.reasons[0], "| 受影响清单:", broken.impact.affectedManifests.map((m) => m.manifestId).join(", ") || "(段后无清单)");
const held = await svc.addException({
  type: "held",
  caseId: "costume-012",
  legId: leg2.legId,
  reason: "服装箱分批托运随第二辆车，预计晚 4 小时抵达",
  reportedBy: "器材主管-周",
});
console.log("暂扣影响:", held.impact.blockedLegs.length, "段被标记；缺件风险:", held.impact.missingRisk);

line("9. 引用破封例外、逐箱登记缺件原因后，交接以 short_received 收尾（历史保留）");
const r2 = await svc.completeHandover({
  handoverId: ho2.handoverId,
  receivedBy: "成都舞台组-何",
  acknowledgeExceptionIds: [broken.exceptionId],
  shortages: [{ caseId: "costume-012", reason: "分批托运漏装第二辆车，西安方面已安排面包车补发" }],
});
console.log("交接结果:", r2.status, "| 缺件:", r2.shortages.map((s) => s.caseId).join(", "), "| 关联例外:", r2.linkedExceptions.join(", "));
try {
  await svc.completeHandover({ handoverId: ho2.handoverId, receivedBy: "hacker" });
} catch (error) {
  console.log("再次提交被拒:", error.message);
}

line("10. 器材主管扫描箱号追踪：当前责任人 / 封签链 / 缺件状态");
for (const caseId of ["prop-018", "costume-012", "light-002"]) {
  const t = svc.trackCase(caseId);
  console.log(`【${caseId}】责任人=${t.currentResponsible.party ?? "无"}（${t.currentResponsible.basis}）`);
  console.log(`  封签链: ${t.sealChain.map((l) => `${l.seal}${l.brokenBy ? "→破封:" + l.brokenBy : ""}`).join(" → ")}`);
  console.log(`  缺件: ${t.shortage.missing ? "是 — " + t.shortage.notes.join("；") : "否"}`);
}

line("11. 重启连续性：超时提醒 + 缺件告警由事件状态推导");
await store.close();
const store2 = new EventStore(join(dir, "events.jsonl"));
await store2.open();
const svc2 = createLogisticsService(store2);
await svc2.load();
const alerts = svc2.alerts(new Date("2026-09-26T07:30:00+08:00"));
console.log("缺件告警:", JSON.stringify(alerts.missingItems, null, 1));
console.log("超时交接数:", alerts.overdueHandovers.length, "(第二段已收尾，故不再超时)");

line("12. 反例：压缩到 30 分钟的装台窗口 → 时间窗冲突（具体分钟数）");
const { planLoading } = await import("../src/domain/planner.js");
const tight = planLoading({
  cities: [
    tour.cities[0],
    tour.cities[1],
    { cityId: "Chengdu", arriveAfter: "2026-09-26T07:30:00+08:00", departDeadline: "2026-09-26T08:00:00+08:00" },
  ],
  cases,
  fleet,
});
console.log("valid =", tight.valid);
for (const reason of tight.reasons) console.log("  ✗ " + reason);

line("13. 反例：烟火与锂电/喷雾被塞进唯一危险舱 → 危险品相斥拒绝");
const infeasible = planLoading({
  cities: tour.cities,
  cases,
  fleet: [
    {
      vehicleId: "single-hazmat-truck",
      durationMinutesByLeg: { "Shanghai->Xi'an": 900, "Xi'an->Chengdu": 840 },
      durationMinutes: 900,
      compartments: [
        { compartmentId: "MAIN", lengthCm: 600, widthCm: 240, heightCm: 260, payloadKg: 1200, hazardCapable: false },
        { compartmentId: "ONLY-HZ", lengthCm: 200, widthCm: 120, heightCm: 150, payloadKg: 150, hazardCapable: true },
      ],
    },
  ],
});
console.log("valid =", infeasible.valid);
for (const reason of infeasible.reasons.slice(0, 3)) console.log("  ✗ " + reason);

await store2.close();
await rm(dir, { recursive: true, force: true });
console.log("\n演示结束。");
