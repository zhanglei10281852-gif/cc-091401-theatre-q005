import assert from "node:assert/strict";
import test from "node:test";
import { makeService, seedTour } from "./helpers.js";

function sealsForEntries(plan, legIndex, start = 700900) {
  const ids = plan.legs[legIndex].assignments
    .slice()
    .sort((a, b) => plan.legs[legIndex].unloadSequence[a.caseId] - plan.legs[legIndex].unloadSequence[b.caseId])
    .map((a) => a.caseId);
  let next = start;
  return ids.map((caseId) => ({ caseId, seal: `S-${next++}` }));
}

test("封舱清单固化后包含逐箱封签、卸货位与摘要，摘要含 SHA-256 摘要", async () => {
  const { service } = await makeService();
  const { plan } = await seedTour(service);
  const manifest = await service.sealManifest({
    planId: plan.planId,
    legId: plan.legs[0].legId,
    seals: sealsForEntries(plan, 0),
    sealedBy: "crew-wu",
  });
  assert.equal(manifest.entries.length, 10);
  assert.equal(manifest.version, 1);
  assert.match(manifest.digest, /^[0-9a-f]{64}$/);
  assert.equal(manifest.summary.caseCount, 10);
  assert.deepEqual(manifest.summary.seals.length, 10);
  assert.ok(manifest.entries.every((e) => /Xi'an-DOCK-\d{2}$/.test(e.unloadSlot)));
});

test("同段重新封舱生成新版本，历史版本仍可读取且摘要不变", async () => {
  const { service } = await makeService();
  const { plan } = await seedTour(service);
  const first = await service.sealManifest({
    planId: plan.planId,
    legId: plan.legs[0].legId,
    seals: sealsForEntries(plan, 0),
    sealedBy: "crew-wu",
  });
  const second = await service.sealManifest({
    planId: plan.planId,
    legId: plan.legs[0].legId,
    seals: sealsForEntries(plan, 0, 700920),
    sealedBy: "crew-li",
    notes: "转舱后重封",
  });
  assert.equal(second.version, 2);
  assert.equal(second.supersedes, first.manifestId);
  const versions = service.listManifestVersions(plan.legs[0].legId);
  assert.deepEqual(versions.map((m) => m.version), [1, 2]);
  const storedFirst = service.getManifest(first.manifestId);
  assert.equal(storedFirst.digest, first.digest);
  assert.equal(storedFirst.sealedBy, "crew-wu");
});

test("封签编号格式错误、重复、复用历史编号都会被拒绝并给出具体原因", async () => {
  const { service } = await makeService();
  const { plan } = await seedTour(service);
  const seals = sealsForEntries(plan, 0);
  const badFormat = seals.map((s, i) => (i === 0 ? { ...s, seal: "SEAL-1" } : s));
  await assert.rejects(
    () => service.sealManifest({ planId: plan.planId, legId: plan.legs[0].legId, seals: badFormat, sealedBy: "x" }),
    (error) => error.code === "validation_failed" && /S-######/.test(error.reasons.join()),
  );
  const duplicate = seals.map((s, i) => (i === 1 ? { ...s, seal: seals[0].seal } : s));
  await assert.rejects(
    () => service.sealManifest({ planId: plan.planId, legId: plan.legs[0].legId, seals: duplicate, sealedBy: "x" }),
    /清单内重复/,
  );
  await service.sealManifest({ planId: plan.planId, legId: plan.legs[0].legId, seals, sealedBy: "x" });
  const reuse = sealsForEntries(plan, 0, 700920);
  reuse[0] = { ...reuse[0], seal: seals[0].seal }; // 复用已固化编号
  await assert.rejects(
    () => service.sealManifest({ planId: plan.planId, legId: plan.legs[0].legId, seals: reuse, sealedBy: "x" }),
    /封签不可复用/,
  );
});

test("离线扫码按设备序列幂等合并：重复批次只回 duplicates，冲突序号拒绝", async () => {
  const { service } = await makeService();
  const batch = {
    deviceId: "PDA-SH-07",
    operatorId: "crew-wu",
    scans: [
      { seq: 1, caseId: "prop-018", seal: "S-700806", scannedAt: "2026-09-24T10:12:00+08:00" },
      { seq: 2, caseId: "prop-021", seal: "S-700807", scannedAt: "2026-09-24T10:15:00+08:00" },
    ],
  };
  const first = await service.ingestScans(batch);
  assert.deepEqual(first.accepted, [1, 2]);
  const again = await service.ingestScans(batch);
  assert.deepEqual(again.duplicates, [1, 2]);
  assert.deepEqual(again.accepted, []);

  // 追加新序号正常合并
  const more = await service.ingestScans({
    deviceId: "PDA-SH-07",
    scans: [{ seq: 3, caseId: "prop-033", seal: "S-700808", scannedAt: "2026-09-24T10:18:00+08:00" }],
  });
  assert.deepEqual(more.accepted, [3]);
  assert.equal(more.totalForDevice, 3);

  // 同序号不同内容 → 拒绝，不允许覆盖
  await assert.rejects(
    () =>
      service.ingestScans({
        deviceId: "PDA-SH-07",
        scans: [{ seq: 1, caseId: "prop-099", seal: "S-700999", scannedAt: "2026-09-24T10:12:00+08:00" }],
      }),
    (error) => error.code === "seq_conflict" && /序号不可被覆盖/.test(error.message),
  );
});

test("交接完成时核对封签链：不符拒绝并提示先追加破封例外", async () => {
  const { service } = await makeService();
  const { plan } = await seedTour(service);
  const seals = sealsForEntries(plan, 0);
  const manifest = await service.sealManifest({
    planId: plan.planId,
    legId: plan.legs[0].legId,
    seals,
    sealedBy: "crew-wu",
  });
  const handover = await service.startHandover({
    legId: plan.legs[0].legId,
    manifestId: manifest.manifestId,
    fromParty: "stage-shanghai",
    toParty: "carrier-dafa",
    dueAt: "2026-09-25T18:00:00+08:00",
  });
  // 全部扫码，但 prop-018 的封签对不上
  await service.ingestScans({
    deviceId: "PDA-SH-07",
    handoverId: handover.handoverId,
    scans: seals.map((s, i) =>
      s.caseId === "prop-018"
        ? { seq: i + 1, caseId: s.caseId, seal: "S-999999", scannedAt: "2026-09-24T11:00:00+08:00" }
        : { seq: i + 1, caseId: s.caseId, seal: s.seal, scannedAt: "2026-09-24T11:00:00+08:00" },
    ),
  });
  await assert.rejects(
    () => service.completeHandover({ handoverId: handover.handoverId, receivedBy: "driver-zhang" }),
    (error) => error.code === "seal_mismatch" && /S-999999/.test(error.reasons.join()) && /broken_seal/.test(error.reasons.join()),
  );

  // 追加破封例外后，完成时引用例外编号即可收尾
  const exception = await service.addException({
    type: "broken_seal",
    caseId: "prop-018",
    legId: plan.legs[0].legId,
    reason: "西安中转时发现封条被月台叉车刮断，已开箱核验",
    reportedBy: "crew-li",
  });
  const completed = await service.completeHandover({
    handoverId: handover.handoverId,
    receivedBy: "driver-zhang",
    acknowledgeExceptionIds: [exception.exceptionId],
  });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.linkedExceptions, [exception.exceptionId]);

  // 历史交接不可覆盖
  await assert.rejects(
    () => service.completeHandover({ handoverId: handover.handoverId, receivedBy: "someone-else" }),
    (error) => error.code === "handover_closed",
  );
});

test("缺箱必须逐箱登记缺件原因，交接以 short_received 收尾并进入缺件告警", async () => {
  const { service } = await makeService();
  const { plan } = await seedTour(service);
  const seals = sealsForEntries(plan, 0);
  const manifest = await service.sealManifest({
    planId: plan.planId,
    legId: plan.legs[0].legId,
    seals,
    sealedBy: "crew-wu",
  });
  const handover = await service.startHandover({
    legId: plan.legs[0].legId,
    manifestId: manifest.manifestId,
    fromParty: "stage-shanghai",
    toParty: "carrier-dafa",
    dueAt: "2026-09-25T18:00:00+08:00",
  });
  const scanned = seals.filter((s) => s.caseId !== "costume-012");
  await service.ingestScans({
    deviceId: "PDA-SH-07",
    handoverId: handover.handoverId,
    scans: scanned.map((s, i) => ({ seq: i + 1, ...s, scannedAt: "2026-09-24T11:00:00+08:00" })),
  });
  await assert.rejects(
    () => service.completeHandover({ handoverId: handover.handoverId, receivedBy: "driver-zhang" }),
    /未扫码且未登记缺件/,
  );
  const result = await service.completeHandover({
    handoverId: handover.handoverId,
    receivedBy: "driver-zhang",
    shortages: [{ caseId: "costume-012", reason: "分批托运，服装箱随第二辆面包车晚到" }],
  });
  assert.equal(result.status, "short_received");
  const alerts = service.alerts(new Date("2026-09-25T19:00:00+08:00"));
  assert.ok(alerts.missingItems.some((m) => m.caseId === "costume-012" && m.type === "short_received"));
  const tracked = service.trackCase("costume-012");
  assert.equal(tracked.shortage.missing, true);
});

test("破封/暂扣/换箱/拆分只能追加例外，评估给出后续影响且不改变历史", async () => {
  const { service } = await makeService();
  const { plan } = await seedTour(service);
  // 暂扣 pyro-001：评估应阻塞成都段并提示已固化清单不可改写
  const held = await service.addException({
    type: "held",
    caseId: "pyro-001",
    legId: plan.legs[0].legId,
    reason: "西安场消防临检，烟火制品被暂扣",
    reportedBy: "crew-li",
  });
  assert.equal(held.type, "held");
  assert.match(held.impact.blockedLegs.map((b) => b.legId).join(), /Xi'an->Chengdu/);
  assert.match(held.impact.reasons.join(), /暂扣/);
  assert.match(held.impact.missingRisk, /缺件/);

  // 换箱：尺寸明显超限的替补箱 → 后续段复算给出超重/超尺寸原因
  await service.registerCases([
    { caseId: "prop-900", category: "prop", lengthCm: 250, widthCm: 250, heightCm: 250, weightKg: 900, hazard: "none" },
  ]);
  const swap = await service.addException({
    type: "swap",
    caseId: "prop-018",
    otherCaseId: "prop-900",
    legId: plan.legs[0].legId,
    reason: "原箱锁扣损坏，临时换用大道具箱",
  });
  assert.ok(swap.impact.blockedLegs.length > 0, JSON.stringify(swap.impact, null, 1));
  assert.match(swap.impact.reasons.join(), /超重|超尺寸|容积/);

  // 拆分：母箱拆为两只子箱，重量守恒时后续段可行
  const split = await service.addException({
    type: "split",
    caseId: "prop-033",
    legId: plan.legs[0].legId,
    reason: "手持道具需分车携带降低风险",
    newCases: [
      { caseId: "prop-033-A", category: "prop", lengthCm: 60, widthCm: 45, heightCm: 45, weightKg: 22, hazard: "none" },
      { caseId: "prop-033-B", category: "prop", lengthCm: 60, widthCm: 45, heightCm: 45, weightKg: 18, hazard: "none" },
    ],
  });
  assert.deepEqual(split.impact.newCaseIds, ["prop-033-A", "prop-033-B"]);
  assert.match(split.impact.reasons.join(), /仍可行|可核销/);

  // 非法类型被拒
  await assert.rejects(
    () => service.addException({ type: "delete", caseId: "pyro-001", legId: plan.legs[0].legId }),
    /broken_seal\/held\/swap\/split/,
  );
});

test("拆分重量偏差超过 5% 触发核实提示", async () => {
  const { service } = await makeService();
  const { plan } = await seedTour(service);
  const split = await service.addException({
    type: "split",
    caseId: "prop-033",
    legId: plan.legs[0].legId,
    newCases: [
      { caseId: "prop-033-A", category: "prop", lengthCm: 60, widthCm: 45, heightCm: 45, weightKg: 10, hazard: "none" },
    ],
  });
  assert.match(split.impact.reasons.join(), /偏差超过 5%/);
});

test("已确认的下一站卸货位不能被无关重排抢走", async () => {
  const { service } = await makeService();
  const { plan } = await seedTour(service);
  const seals = sealsForEntries(plan, 0);
  const manifest = await service.sealManifest({
    planId: plan.planId,
    legId: plan.legs[0].legId,
    seals,
    sealedBy: "crew-wu",
  });
  // 西安→成都段先封舱并开始交接（确认成都卸货位）
  const seals2 = sealsForEntries(plan, 1, 700820);
  const manifest2 = await service.sealManifest({
    planId: plan.planId,
    legId: plan.legs[1].legId,
    seals: seals2,
    sealedBy: "crew-li",
  });
  const handover = await service.startHandover({
    legId: plan.legs[1].legId,
    manifestId: manifest2.manifestId,
    fromParty: "stage-xian",
    toParty: "carrier-dafa",
  });
  const targetCase = manifest2.entries[0].caseId;
  const targetSlot = manifest2.entries[0].unloadSlot;

  // 用改变成都段卸货顺序的自定义序列重新规划同段 → 必须被锁定拦截
  const seq = { ...plan.legs[1].unloadSequence };
  const ids = Object.keys(seq);
  const a = ids.find((id) => id !== targetCase);
  const rankA = seq[a];
  const rankTarget = seq[targetCase];
  seq[a] = rankTarget;
  seq[targetCase] = rankA;
  await assert.rejects(
    () =>
      seedTour(service, {
        planId: "tour-replan",
        unloadSequenceByLeg: { [plan.legs[1].legId]: seq },
      }),
    (error) => error.code === "slots_locked" && error.reasons.join().includes(targetSlot) && error.reasons.join().includes(targetCase),
  );
  void handover;
});

test("两个未完成交接不能占用同一卸货位", async () => {
  const { service } = await makeService();
  const { plan } = await seedTour(service);
  const manifest = await service.sealManifest({
    planId: plan.planId,
    legId: plan.legs[0].legId,
    seals: sealsForEntries(plan, 0),
    sealedBy: "crew-wu",
  });
  const first = await service.startHandover({
    legId: plan.legs[0].legId,
    manifestId: manifest.manifestId,
    fromParty: "stage-shanghai",
    toParty: "carrier-dafa",
  });
  const second = await service.sealManifest({
    planId: plan.planId,
    legId: plan.legs[0].legId,
    seals: sealsForEntries(plan, 0, 700920),
    sealedBy: "crew-wu-2",
  });
  await assert.rejects(
    () =>
      service.startHandover({
        legId: plan.legs[0].legId,
        manifestId: second.manifestId,
        fromParty: "stage-shanghai",
        toParty: "carrier-kuaida",
      }),
    (error) => error.code === "slots_locked" && error.message.includes(first.handoverId),
  );
});
