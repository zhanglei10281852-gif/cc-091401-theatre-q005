/**
 * 巡演物流领域服务。
 *
 * 所有写操作都翻译成只追加事件；状态由事件重放得到，因此重启后未完成交接、
 * 超时提醒与封签链连续，历史交接与已固化封舱清单没有任何覆盖路径。
 */
import { randomUUID } from "node:crypto";
import { digest, iso } from "./domain/util.js";
import { planLoading } from "./domain/planner.js";
import { assessException, validateExceptionPayload } from "./domain/impact.js";

const SEAL_PATTERN = /^S-\d{6}$/;

export class ConflictError extends Error {
  constructor(reasons, code = "conflict") {
    super(Array.isArray(reasons) ? reasons.join("；") : reasons);
    this.reasons = Array.isArray(reasons) ? reasons : [reasons];
    this.code = code;
  }
}

export class ValidationError extends Error {
  constructor(reasons) {
    super(Array.isArray(reasons) ? reasons.join("；") : reasons);
    this.reasons = Array.isArray(reasons) ? reasons : [reasons];
    this.code = "validation_failed";
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.code = "not_found";
  }
}

export function createLogisticsService(store, clock = () => new Date()) {
  // ---- 重放状态 ----
  const state = {
    cases: new Map(),
    plans: new Map(),
    manifests: new Map(),
    manifestVersionsByLeg: new Map(), // legId -> manifestId[]（版本顺序）
    handovers: new Map(),
    scans: new Map(), // `${deviceId}:${seq}` -> scan
    scansByCase: new Map(),
    exceptions: new Map(),
    releases: new Map(), // exceptionId -> release event payload
    slots: new Map(), // `${legId}:${slot}` -> { handoverId, caseId }
    sealsByCase: new Map(), // caseId -> [{ seal, manifestId, legId, at }]
    events: 0,
  };
  let loaded = false;

  function nowIso() {
    return iso(clock());
  }

  async function load() {
    if (loaded) return state;
    await store.replay(applyEvent);
    // 扫码归属是派生状态：重放后为所有未完成交接补算一次
    for (const handover of state.handovers.values()) {
      if (handover.status === "pending") attachScansToHandover(handover);
    }
    loaded = true;
    return state;
  }

  function applyEvent(event) {
    const { type, payload } = event;
    state.events += 1;
    switch (type) {
      case "case_registered":
        state.cases.set(payload.caseId, payload);
        break;
      case "plan_created":
        state.plans.set(payload.planId, payload);
        break;
      case "manifest_sealed": {
        state.manifests.set(payload.manifestId, payload);
        const list = state.manifestVersionsByLeg.get(payload.legId) ?? [];
        list.push(payload.manifestId);
        state.manifestVersionsByLeg.set(payload.legId, list);
        for (const entry of payload.entries) {
          const chain = state.sealsByCase.get(entry.caseId) ?? [];
          chain.push({
            seal: entry.seal,
            manifestId: payload.manifestId,
            legId: payload.legId,
            at: payload.sealedAt,
            active: true,
          });
          state.sealsByCase.set(entry.caseId, chain);
        }
        break;
      }
      case "handover_started":
        state.handovers.set(payload.handoverId, payload);
        for (const slot of payload.reservedSlots) {
          state.slots.set(`${slot.legId}:${slot.slot}`, {
            handoverId: payload.handoverId,
            caseId: slot.caseId,
          });
        }
        break;
      case "scan_recorded": {
        state.scans.set(`${payload.deviceId}:${payload.seq}`, payload);
        const list = state.scansByCase.get(payload.caseId) ?? [];
        list.push(payload);
        state.scansByCase.set(payload.caseId, list);
        break;
      }
      case "handover_completed": {
        const handover = state.handovers.get(payload.handoverId);
        if (handover) {
          handover.status = payload.status;
          handover.completedAt = payload.at;
          handover.receivedBy = payload.receivedBy;
          handover.shortages = payload.shortages;
          handover.sealMismatches = payload.sealMismatches;
          handover.linkedExceptions = payload.linkedExceptions;
        }
        break;
      }
      case "exception_added":
        state.exceptions.set(payload.exceptionId, payload);
        if (payload.type === "broken_seal") {
          // 旧封签在链条上标记失效（不改写记录，只翻转派生标记）
          const chain = state.sealsByCase.get(payload.caseId) ?? [];
          for (const link of chain) link.active = false;
        }
        break;
      case "exception_released":
        state.releases.set(payload.exceptionId, payload);
        break;
      default:
        // 未知事件类型忽略前向兼容，不阻断重放
        break;
    }
  }

  async function record(type, payload) {
    const event = await store.append(type, payload);
    applyEvent(event);
    return event;
  }

  // ---- 箱体台账 ----
  async function registerCases(cases) {
    await load();
    if (!Array.isArray(cases) || cases.length === 0) {
      throw new ValidationError("cases 必须为非空数组");
    }
    const registered = [];
    for (const item of cases) {
      if (state.cases.has(item.caseId)) {
        // 台账箱体幂等登记：字段一致视为重复提交直接跳过；不一致拒绝（台账不可覆盖）
        const existing = state.cases.get(item.caseId);
        const mutableFields = ["category", "lengthCm", "widthCm", "heightCm", "weightKg", "hazard"];
        const changed = mutableFields.filter((field) => existing[field] !== (item[field] ?? (field === "hazard" ? "none" : undefined)));
        if (changed.length > 0) {
          throw new ConflictError(
            `箱体 ${item.caseId} 已登记且字段不一致（${changed.join("、")}），台账不可覆盖；如需变更请走换箱/拆分例外`,
          );
        }
        continue;
      }
      const reasons = validateCase(item);
      if (reasons.length > 0) throw new ValidationError(reasons);
      const payload = { hazard: "none", ...item, registeredAt: nowIso() };
      await record("case_registered", payload);
      registered.push(item.caseId);
    }
    return { registered, skipped: cases.length - registered.length, total: state.cases.size };
  }

  function validateCase(item) {
    const reasons = [];
    if (!item?.caseId) reasons.push("箱体缺少 caseId");
    for (const field of ["lengthCm", "widthCm", "heightCm", "weightKg"]) {
      if (typeof item?.[field] !== "number" || item[field] <= 0) {
        reasons.push(`箱体 ${item?.caseId ?? "?"} 的 ${field} 必须为正数`);
      }
    }
    if (item?.category && !["prop", "costume", "fragile_light", "rigging", "misc"].includes(item.category)) {
      reasons.push(`箱体 ${item.caseId} 的 category 非法: ${item.category}`);
    }
    return reasons;
  }

  // ---- 装载规划 ----
  async function createPlan(input, fleet) {
    await load();
    const fullInput = { ...input };
    const fleetSnapshot = fleet ?? input.fleet;
    if (!fullInput.cases && !fullInput.caseIds) {
      throw new ValidationError("规划必须提供 caseIds 箱体列表（或 cases 台账）");
    }
    if (fullInput.cases && !Array.isArray(fullInput.cases)) {
      throw new ValidationError("cases 必须为数组");
    }
    if (fullInput.caseIds && !Array.isArray(fullInput.caseIds)) {
      throw new ValidationError("caseIds 必须为数组");
    }
    if (!fleetSnapshot) {
      throw new ValidationError("规划必须提供 fleet 车队与舱位定义");
    }
    if (!fullInput.cases && fullInput.caseIds) {
      fullInput.cases = fullInput.caseIds.map((id) => {
        const item = state.cases.get(id);
        if (!item) throw new ValidationError(`箱体 ${id} 尚未登记`);
        return item;
      });
    }
    const result = planLoading(fullInput, input.timing);
    if (!result.valid) {
      throw new ConflictError(result.reasons, "plan_infeasible");
    }
    // 已确认的下一站卸货位不能被无关重排抢走
    const lockReasons = findLockedSlotViolations(result.plan);
    if (lockReasons.length > 0) throw new ConflictError(lockReasons, "slots_locked");

    result.plan.planId = input.planId ?? result.plan.planId;
    if (state.plans.has(result.plan.planId)) {
      result.plan.planId = `${result.plan.planId}-${randomUUID().slice(0, 8)}`;
    }
    await record("plan_created", { ...result.plan, fleetSnapshot: fleetSnapshot ?? null });
    return result.plan;
  }

  function findLockedSlotViolations(plan) {
    const reasons = [];
    for (const leg of plan.legs) {
      for (const [key, lock] of state.slots) {
        const sep = key.lastIndexOf(":");
        const lockedLegId = key.slice(0, sep);
        const lockedSlot = key.slice(sep + 1);
        if (lockedLegId !== leg.legId) continue;
        const owner = state.handovers.get(lock.handoverId);
        if (owner?.status !== "pending") continue; // 已完成交接的占位随历史定案，不拦新计划
        const newRank = leg.unloadSequence?.[lock.caseId];
        if (newRank === undefined) {
          reasons.push(
            `卸货位锁定: ${leg.legId} 已确认的 ${lockedSlot} 属于 ${lock.caseId}（交接 ${lock.handoverId}），重排后该箱被移出本段，已确认的下一站卸货位不能被无关重排抢走`,
          );
          continue;
        }
        const newSlot = bayFor(leg.toCity, newRank);
        if (newSlot !== lockedSlot) {
          reasons.push(
            `卸货位锁定: ${leg.legId} 的 ${lockedSlot} 已由交接 ${lock.handoverId}（${owner.fromParty}→${owner.toParty}）确认给 ${lock.caseId}，重排将使其改到 ${newSlot}，已确认的下一站卸货位不能被无关重排抢走`,
          );
        }
      }
    }
    return reasons;
  }

  function getPlan(planId) {
    const plan = state.plans.get(planId);
    if (!plan) throw new NotFoundError(`计划 ${planId} 不存在`);
    return plan;
  }

  function latestPlanForLeg(legId) {
    return [...state.plans.values()]
      .filter((plan) => plan.legs.some((leg) => leg.legId === legId))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  }

  // ---- 封舱清单（固化，不可变；同段重封生成新版本） ----
  async function sealManifest({ planId, legId, seals, sealedBy, notes = "" }) {
    await load();
    const plan = planId ? getPlan(planId) : latestPlanForLeg(legId);
    if (!plan) throw new ValidationError(`找不到段 ${legId} 的计划`);
    const leg = plan.legs.find((item) => item.legId === legId);
    if (!leg) throw new NotFoundError(`计划 ${plan.planId} 中不存在段 ${legId}`);
    if (!leg.feasible) throw new ConflictError(`段 ${legId} 不可行，不能封舱`);

    if (!Array.isArray(seals) || seals.length === 0) {
      throw new ValidationError("必须提供每只箱体的封签编号 seals[]");
    }
    const sealByCase = new Map(seals.map((s) => [s.caseId, s.seal]));
    const reasons = [];
    const expectedIds = leg.assignments.map((a) => a.caseId);
    for (const caseId of expectedIds) {
      if (!sealByCase.has(caseId)) reasons.push(`封舱清单缺少箱体 ${caseId} 的封签编号`);
    }
    const sealNumbers = new Set();
    for (const { caseId, seal } of seals) {
      if (!SEAL_PATTERN.test(seal)) {
        reasons.push(`箱体 ${caseId} 的封签编号 ${seal} 不符合 S-###### 样例格式`);
      }
      if (sealNumbers.has(seal)) reasons.push(`封签编号 ${seal} 在本清单内重复`);
      sealNumbers.add(seal);
    }
    // 封签号一次性使用：重封必须换用新封签，任何历史编号复用都拒绝
    const usedSeals = new Set();
    for (const chain of state.sealsByCase.values()) {
      for (const link of chain) usedSeals.add(link.seal);
    }
    for (const { caseId, seal } of seals) {
      if (usedSeals.has(seal)) {
        reasons.push(`封签编号 ${seal} 已在历史封舱记录中使用，封签不可复用（重封须换新封签），箱体 ${caseId}`);
      }
    }
    if (reasons.length > 0) throw new ValidationError(reasons);

    const previousVersions = state.manifestVersionsByLeg.get(legId) ?? [];
    const entries = leg.assignments
      .slice()
      .sort((a, b) => leg.unloadSequence[a.caseId] - leg.unloadSequence[b.caseId])
      .map((assignment) => {
        const rank = leg.unloadSequence[assignment.caseId];
        return {
          caseId: assignment.caseId,
          seal: sealByCase.get(assignment.caseId),
          compartmentId: assignment.compartmentId,
          loadingSlot: assignment.loadingSlot,
          unloadRank: rank,
          unloadSlot: bayFor(leg.toCity, rank),
        };
      });

    const manifest = {
      manifestId: `MAN-${legId.replace(/->/g, "-")}-v${previousVersions.length + 1}`.toUpperCase(),
      planId: plan.planId,
      legId,
      fromCity: leg.fromCity,
      toCity: leg.toCity,
      vehicleId: leg.vehicleId,
      version: previousVersions.length + 1,
      supersedes: previousVersions.at(-1) ?? null,
      entries,
      sealedBy,
      sealedAt: nowIso(),
      notes,
    };
    manifest.summary = buildSummary(manifest);
    manifest.digest = digest({
      manifestId: manifest.manifestId,
      legId: manifest.legId,
      version: manifest.version,
      entries: manifest.entries.map((e) => ({
        caseId: e.caseId,
        seal: e.seal,
        compartmentId: e.compartmentId,
        unloadSlot: e.unloadSlot,
      })),
    });
    await record("manifest_sealed", manifest);
    return manifest;
  }

  function buildSummary(manifest) {
    return {
      manifestId: manifest.manifestId,
      legId: manifest.legId,
      version: manifest.version,
      caseCount: manifest.entries.length,
      sealCount: manifest.entries.length,
      seals: manifest.entries.map((e) => e.seal),
      compartments: [...new Set(manifest.entries.map((e) => e.compartmentId))].sort(),
      digest: undefined,
    };
  }

  function getManifest(manifestId) {
    const manifest = state.manifests.get(manifestId);
    if (!manifest) throw new NotFoundError(`封舱清单 ${manifestId} 不存在`);
    return manifest;
  }

  function listManifestVersions(legId) {
    return (state.manifestVersionsByLeg.get(legId) ?? []).map((id) => state.manifests.get(id));
  }

  function currentSeal(caseId) {
    const chain = state.sealsByCase.get(caseId) ?? [];
    const active = chain.filter((link) => link.active);
    return active.at(-1) ?? null;
  }

  // ---- 交接 ----
  async function startHandover(payload) {
    await load();
    const { legId, manifestId, fromParty, toParty, carrier, dueAt } = payload;
    const reasons = [];
    if (!legId) reasons.push("缺少 legId");
    if (!fromParty) reasons.push("缺少交出方 fromParty");
    if (!toParty) reasons.push("缺少接收方 toParty");
    const manifest = manifestId
      ? state.manifests.get(manifestId)
      : (state.manifestVersionsByLeg.get(legId) ?? []).at(-1)
        ? state.manifests.get(state.manifestVersionsByLeg.get(legId).at(-1))
        : null;
    if (!manifest) reasons.push(`段 ${legId ?? "?"} 尚无已固化封舱清单，不能开始交接`);
    if (reasons.length > 0) throw new ValidationError(reasons);

    const expectedCaseIds = manifest.entries.map((e) => e.caseId);
    const reservedSlots = manifest.entries.map((e) => ({
      legId,
      slot: e.unloadSlot,
      caseId: e.caseId,
    }));
    // 卸货位占用冲突：已被别的未完成交接确认的位置不能再抢
    for (const slot of reservedSlots) {
      const key = `${slot.legId}:${slot.slot}`;
      const owner = state.slots.get(key);
      if (owner) {
        const ownerHandover = state.handovers.get(owner.handoverId);
        if (ownerHandover && ownerHandover.status === "pending") {
          throw new ConflictError(
            `卸货位 ${slot.slot} 已被未完成交接 ${owner.handoverId}（${ownerHandover.fromParty}→${ownerHandover.toParty}）为 ${owner.caseId} 确认占用，不能被本次交接抢走`,
            "slots_locked",
          );
        }
      }
    }

    const plan = latestPlanForLeg(legId);
    const leg = plan?.legs.find((item) => item.legId === legId);
    const handover = {
      handoverId: payload.handoverId ?? `HO-${randomUUID().slice(0, 12)}`,
      legId,
      manifestId: manifest.manifestId,
      manifestDigest: manifest.digest,
      fromParty,
      toParty,
      carrier: carrier ?? toParty,
      expectedCaseIds,
      expectedSeals: Object.fromEntries(manifest.entries.map((e) => [e.caseId, e.seal])),
      reservedSlots,
      status: "pending",
      startedAt: nowIso(),
      dueAt: dueAt ?? leg?.scheduledArrivalAt ?? null,
      scannedCaseIds: [],
    };
    if (state.handovers.has(handover.handoverId)) {
      throw new ConflictError(`交接 ${handover.handoverId} 已存在`);
    }
    await record("handover_started", handover);
    attachScansToHandover(state.handovers.get(handover.handoverId));
    return state.handovers.get(handover.handoverId);
  }

  /**
   * 离线扫码批量恢复。
   * 幂等键：设备序列号 + 设备内自增序号。重复批次只合并新序号；
   * 同序号内容不一致（乱序覆盖/伪造）直接拒绝，整批不落库。
   */
  async function ingestScans(batch) {
    await load();
    const reasons = [];
    if (!batch?.deviceId) reasons.push("扫码批次缺少 deviceId（设备序列号）");
    if (!Array.isArray(batch?.scans)) reasons.push("扫码批次缺少 scans 数组");
    if (reasons.length > 0) throw new ValidationError(reasons);

    const incoming = [];
    const duplicates = [];
    const seqs = new Set();
    for (const scan of batch.scans) {
      if (typeof scan?.seq !== "number" || scan.seq < 0) {
        reasons.push(`存在缺少数值 seq 的扫码记录`);
        continue;
      }
      if (seqs.has(scan.seq)) reasons.push(`设备 ${batch.deviceId} 本批内序号 ${scan.seq} 重复`);
      seqs.add(scan.seq);
      if (!scan.caseId) reasons.push(`序号 ${scan.seq} 的扫码缺少 caseId`);
      if (!scan.seal) reasons.push(`序号 ${scan.seq} 的扫码缺少 seal`);
      if (!scan.scannedAt || Number.isNaN(Date.parse(scan.scannedAt))) {
        reasons.push(`序号 ${scan.seq} 的扫码缺少有效 scannedAt（离线采集的原始时间）`);
      }
      const key = `${batch.deviceId}:${scan.seq}`;
      const existing = state.scans.get(key);
      if (existing) {
        if (
          existing.caseId !== scan.caseId ||
          existing.seal !== scan.seal ||
          existing.scannedAt !== scan.scannedAt
        ) {
          throw new ConflictError(
            `设备 ${batch.deviceId} 序号 ${scan.seq} 已有不同内容的记录（已存 ${existing.caseId}/${existing.seal}@${existing.scannedAt}），设备序号不可被覆盖；请核对设备时钟或改用新序号补扫`,
            "seq_conflict",
          );
        }
        duplicates.push(scan.seq);
        continue;
      }
      incoming.push(scan);
    }
    if (reasons.length > 0) throw new ValidationError(reasons);

    const accepted = [];
    for (const scan of incoming) {
      const event = await record("scan_recorded", {
        deviceId: batch.deviceId,
        seq: scan.seq,
        caseId: scan.caseId,
        seal: scan.seal,
        scannedAt: scan.scannedAt,
        receivedAt: nowIso(),
        location: scan.location ?? null,
        handoverId: scan.handoverId ?? batch.handoverId ?? null,
        operatorId: batch.operatorId ?? scan.operatorId ?? null,
        source: batch.source ?? "offline_batch",
      });
      accepted.push(event.payload);
    }
    // 幂等地挂到进行中交接：显式 handoverId 优先；否则挂给唯一/最近的含该箱的待办交接
    for (const scan of accepted) {
      let handover = null;
      if (scan.handoverId) handover = state.handovers.get(scan.handoverId) ?? null;
      if (!handover || handover.status !== "pending") {
        const candidates = [...state.handovers.values()]
          .filter((h) => h.status === "pending" && h.expectedCaseIds.includes(scan.caseId))
          .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
        if (candidates.length === 1) handover = candidates[0];
      }
      if (handover && handover.status === "pending") attachScansToHandover(handover);
    }
    return {
      deviceId: batch.deviceId,
      accepted: accepted.map((s) => s.seq),
      duplicates,
      totalForDevice: [...state.scans.keys()].filter((k) => k.startsWith(`${batch.deviceId}:`)).length,
    };
  }

  function attachScansToHandover(handover) {
    for (const scan of state.scans.values()) {
      if (handover.scannedCaseIds.includes(scan.caseId)) continue;
      let belongs = scan.handoverId === handover.handoverId;
      if (!belongs && scan.handoverId === null && handover.expectedCaseIds.includes(scan.caseId)) {
        // 离线先扫、交接后建：归给最早开始的含该箱待办交接，避免被无关交接认领
        const earlier = [...state.handovers.values()]
          .filter(
            (other) =>
              other !== handover &&
              other.status === "pending" &&
              other.expectedCaseIds.includes(scan.caseId) &&
              other.startedAt < handover.startedAt,
          )
          .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))[0];
        belongs = !earlier;
      }
      if (belongs) handover.scannedCaseIds.push(scan.caseId);
    }
  }

  /**
   * 完成交接：核对封签链与缺件。
   * - 封签与封舱清单不符 → 拒绝，除非已就该箱追加 broken_seal 例外（在 linkedExceptions 中引用）
   * - 缺箱 → 必须在 shortages 中逐箱登记原因，交接以 short_received 收尾（历史保留）
   */
  async function completeHandover({ handoverId, receivedBy, shortages = [], acknowledgeExceptionIds = [] }) {
    await load();
    const handover = state.handovers.get(handoverId);
    if (!handover) throw new NotFoundError(`交接 ${handoverId} 不存在`);
    if (handover.status !== "pending") {
      throw new ConflictError(
        `交接 ${handoverId} 已于 ${handover.completedAt} 以 ${handover.status} 收尾，历史交接不可被覆盖`,
        "handover_closed",
      );
    }
    attachScansToHandover(handover);

    const scanned = new Set(handover.scannedCaseIds);
    const sealMismatches = [];
    const broken = new Set(
      [...state.exceptions.values()]
        .filter((e) => e.type === "broken_seal" && !state.releases.has(e.exceptionId))
        .map((e) => e.exceptionId),
    );
    const linked = new Set(acknowledgeExceptionIds);

    for (const caseId of handover.expectedCaseIds) {
      if (!scanned.has(caseId)) continue;
      const scans = [...state.scans.values()]
        .filter((s) => s.handoverId === handoverId && s.caseId === caseId)
        .sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : 1));
      const latestScan = scans.at(-1);
      const expectedSeal = handover.expectedSeals[caseId];
      if (latestScan && latestScan.seal !== expectedSeal) {
        const ack = acknowledgeExceptionIds.find((id) => {
          const exception = state.exceptions.get(id);
          return exception?.type === "broken_seal" && exception.caseId === caseId;
        });
        if (!ack) {
          sealMismatches.push({
            caseId,
            expectedSeal,
            scannedSeal: latestScan.seal,
            reason: `扫码封签 ${latestScan.seal} 与封舱清单 ${handover.manifestId} 登记的 ${expectedSeal} 不符；请先追加 broken_seal 例外并重新施封，再在确认时引用例外编号`,
          });
        } else {
          linked.add(ack);
        }
      }
    }
    if (sealMismatches.length > 0) {
      throw new ConflictError(sealMismatches.map((m) => m.reason), "seal_mismatch");
    }

    const shortageIds = new Set(shortages.map((s) => s.caseId));
    const missing = handover.expectedCaseIds.filter(
      (id) => !scanned.has(id) && !shortageIds.has(id),
    );
    if (missing.length > 0) {
      throw new ConflictError(
        `还有 ${missing.length} 只箱体未扫码且未登记缺件: ${missing.join("、")}；缺件须在 shortages 中逐箱注明原因后才能收尾交接`,
        "shortage_unacknowledged",
      );
    }
    for (const item of shortages) {
      if (!handover.expectedCaseIds.includes(item.caseId)) {
        throw new ValidationError(`缺件登记 ${item.caseId} 不属于本交接封舱清单`);
      }
      if (!item.reason) throw new ValidationError(`缺件 ${item.caseId} 必须注明原因`);
    }
    const status = shortages.length > 0 ? "short_received" : "completed";
    const payload = {
      handoverId,
      status,
      at: nowIso(),
      receivedBy,
      shortages: shortages.map((s) => ({ ...s, at: nowIso() })),
      sealMismatches: [],
      linkedExceptions: [...linked].filter((id) => broken.has(id) || state.exceptions.has(id)),
    };
    await record("handover_completed", payload);
    return state.handovers.get(handoverId);
  }

  // ---- 例外（只追加）+ 影响评估 ----
  async function addException(payload) {
    await load();
    const reasons = validateExceptionPayload(payload);
    if (!state.cases.has(payload.caseId)) reasons.push(`箱体 ${payload.caseId} 未登记`);
    const legExists = [...state.plans.values()].some((plan) =>
      plan.legs.some((leg) => leg.legId === payload.legId),
    );
    if (!legExists) reasons.push(`段 ${payload.legId} 不在任何计划中`);
    if (payload.type === "swap" && payload.otherCaseId && !state.cases.has(payload.otherCaseId)) {
      reasons.push(`换箱对方 ${payload.otherCaseId} 未登记`);
    }
    if (reasons.length > 0) throw new ValidationError(reasons);

    const exception = {
      exceptionId: payload.exceptionId ?? `EX-${randomUUID().slice(0, 12)}`,
      type: payload.type,
      caseId: payload.caseId,
      otherCaseId: payload.otherCaseId ?? null,
      newCases: payload.newCases ?? null,
      legId: payload.legId,
      reason: payload.reason ?? "",
      reportedBy: payload.reportedBy ?? null,
      at: nowIso(),
    };
    if (state.exceptions.has(exception.exceptionId)) {
      throw new ConflictError(`例外 ${exception.exceptionId} 已存在`);
    }
    // 拆分产生的新箱先进入台账（同样以事件固化）
    if (payload.type === "split") {
      for (const item of exception.newCases) {
        if (!state.cases.has(item.caseId)) {
          await record("case_registered", {
            hazard: "none",
            ...item,
            parentCaseId: payload.caseId,
            registeredAt: nowIso(),
          });
        }
      }
    }
    const impact = assessException(serviceState(), exception);
    await record("exception_added", { ...exception, impact });
    return state.exceptions.get(exception.exceptionId);
  }

  /** 解除暂扣等：只能追加解除记录，不删除原例外 */
  async function releaseException({ exceptionId, releasedBy, note }) {
    await load();
    const exception = state.exceptions.get(exceptionId);
    if (!exception) throw new NotFoundError(`例外 ${exceptionId} 不存在`);
    if (state.releases.has(exceptionId)) {
      throw new ConflictError(`例外 ${exceptionId} 已解除，历史记录不可覆盖`);
    }
    const payload = { exceptionId, releasedBy, note: note ?? "", at: nowIso() };
    await record("exception_released", payload);
    return payload;
  }

  // ---- 器材主管箱号追踪 ----
  function trackCase(caseId) {
    const item = state.cases.get(caseId);
    if (!item) throw new NotFoundError(`箱体 ${caseId} 未登记`);

    const sealChain = (state.sealsByCase.get(caseId) ?? []).map((link) => ({ ...link }));
    annotateSealChain(caseId, sealChain);

    const handoverHistory = [...state.handovers.values()]
      .filter((h) => h.expectedCaseIds.includes(caseId))
      .map((h) => ({
        handoverId: h.handoverId,
        legId: h.legId,
        fromParty: h.fromParty,
        toParty: h.toParty,
        status: h.status,
        startedAt: h.startedAt,
        completedAt: h.completedAt ?? null,
      }))
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));

    const activeExceptions = [...state.exceptions.values()].filter(
      (e) =>
        (e.caseId === caseId || e.otherCaseId === caseId || childOfSplit(e, caseId)) &&
        !state.releases.has(e.exceptionId),
    );

    return {
      caseId,
      category: item.category,
      dimensions: {
        lengthCm: item.lengthCm,
        widthCm: item.widthCm,
        heightCm: item.heightCm,
      },
      weightKg: item.weightKg,
      hazard: item.hazard ?? "none",
      currentResponsible: currentResponsible(caseId, handoverHistory),
      currentSeal: currentSeal(caseId),
      sealChain,
      handoverHistory,
      exceptions: activeExceptions.map((e) => ({
        exceptionId: e.exceptionId,
        type: e.type,
        legId: e.legId,
        at: e.at,
        reason: e.reason,
        impactBlockedLegs: e.impact?.blockedLegs?.map((b) => b.legId) ?? [],
      })),
      shortage: shortageStatus(caseId, activeExceptions),
      lastScans: (state.scansByCase.get(caseId) ?? [])
        .slice(-5)
        .map((s) => ({ deviceId: s.deviceId, seq: s.seq, seal: s.seal, scannedAt: s.scannedAt, location: s.location })),
    };
  }

  function annotateSealChain(caseId, chain) {
    const breaks = [...state.exceptions.values()]
      .filter((e) => e.type === "broken_seal" && e.caseId === caseId)
      .sort((a, b) => (a.at < b.at ? -1 : 1));
    chain.forEach((link, index) => {
      const from = Date.parse(link.at);
      const until = index + 1 < chain.length ? Date.parse(chain[index + 1].at) : Infinity;
      const broke = breaks.find((e) => {
        const t = Date.parse(e.at);
        return t >= from && t < until;
      });
      link.brokenBy = broke?.exceptionId ?? null;
    });
  }

  function childOfSplit(exception, caseId) {
    return (
      exception.type === "split" &&
      Array.isArray(exception.newCases) &&
      exception.newCases.some((c) => c.caseId === caseId)
    );
  }

  function currentResponsible(caseId, history) {
    const latest = history.at(-1);
    if (!latest) {
      // 尚未交接：最近一次封舱的施封方负责
      const seal = currentSeal(caseId);
      const manifest = seal ? state.manifests.get(seal.manifestId) : null;
      return manifest
        ? { party: manifest.sealedBy, basis: `封舱清单 ${manifest.manifestId} 已固化，等待交接` }
        : { party: null, basis: "箱体已登记但尚未封舱发运" };
    }
    const handover = state.handovers.get(latest.handoverId);
    if (handover.status === "pending") {
      return { party: handover.carrier, basis: `交接 ${handover.handoverId} 在途（${handover.fromParty} 已交出）` };
    }
    const short = (handover.shortages ?? []).some((s) => s.caseId === caseId);
    const heldActive = [...state.exceptions.values()].some(
      (e) => e.type === "held" && e.caseId === caseId && !state.releases.has(e.exceptionId),
    );
    if (handover.status === "short_received" && (short || heldActive)) {
      return {
        party: handover.carrier,
        basis: `交接 ${handover.handoverId} 短收 ${caseId}，货未交付，责任仍在承运方，收货方 ${handover.toParty} 已登记缺件`,
      };
    }
    return {
      party: handover.toParty,
      basis: `交接 ${handover.handoverId} 已由 ${handover.receivedBy ?? handover.toParty} 签收`,
    };
  }

  function shortageStatus(caseId, activeExceptions) {
    const notes = [];
    let missing = false;
    for (const handover of state.handovers.values()) {
      for (const shortage of handover.shortages ?? []) {
        if (shortage.caseId === caseId) {
          missing = true;
          notes.push(`交接 ${handover.handoverId} 短收：${shortage.reason}`);
        }
      }
    }
    if (activeExceptions.some((e) => e.type === "held")) {
      missing = true;
      notes.push("箱体处于暂扣状态，无法随下一段发运");
    }
    const split = [...state.exceptions.values()].find(
      (e) => e.type === "split" && e.caseId === caseId,
    );
    if (split) {
      const childIds = split.newCases.map((c) => c.caseId);
      const receivedChildren = new Set();
      for (const handover of state.handovers.values()) {
        if (handover.status !== "pending") {
          for (const id of childIds) if (handover.scannedCaseIds.includes(id)) receivedChildren.add(id);
        }
      }
      const outstanding = childIds.filter((id) => !receivedChildren.has(id));
      if (outstanding.length > 0) {
        missing = true;
        notes.push(`母箱已拆分为 ${childIds.join("、")}，尚有子箱 ${outstanding.join("、")} 未完成签收`);
      } else {
        notes.push("拆分子箱已全部签收，母箱可核销");
      }
    }
    return { missing, notes };
  }

  // ---- 告警：超时未完成交接 + 缺件（重启后由事件状态连续推导） ----
  function alerts(now = clock()) {
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    const overdue = [];
    for (const handover of state.handovers.values()) {
      if (handover.status !== "pending" || !handover.dueAt) continue;
      attachScansToHandover(handover);
      const dueMs = Date.parse(handover.dueAt);
      if (nowMs > dueMs) {
        overdue.push({
          type: "handover_overdue",
          handoverId: handover.handoverId,
          legId: handover.legId,
          fromParty: handover.fromParty,
          toParty: handover.toParty,
          carrier: handover.carrier,
          dueAt: handover.dueAt,
          overdueMinutes: Math.round((nowMs - dueMs) / 60000),
          scannedCaseIds: handover.scannedCaseIds,
          outstandingCaseIds: handover.expectedCaseIds.filter(
            (id) => !handover.scannedCaseIds.includes(id),
          ),
        });
      }
    }
    const missing = [];
    for (const handover of state.handovers.values()) {
      for (const shortage of handover.shortages ?? []) {
        missing.push({
          type: "short_received",
          handoverId: handover.handoverId,
          legId: handover.legId,
          ...shortage,
        });
      }
    }
    for (const exception of state.exceptions.values()) {
      if (exception.type === "held" && !state.releases.has(exception.exceptionId)) {
        missing.push({
          type: "held",
          exceptionId: exception.exceptionId,
          caseId: exception.caseId,
          legId: exception.legId,
          reason: exception.reason,
        });
      }
    }
    return { generatedAt: iso(nowMs), overdueHandovers: overdue, missingItems: missing };
  }

  function serviceState() {
    return {
      cases: state.cases,
      plans: state.plans,
      manifests: state.manifests,
      handovers: state.handovers,
      exceptions: state.exceptions,
      get fleet() {
        return recoverFleet();
      },
    };
  }

  function recoverFleet() {
    const plans = [...state.plans.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    for (const plan of plans) {
      if (plan.fleetSnapshot) return plan.fleetSnapshot;
    }
    return [];
  }

  function bayFor(city, rank) {
    return `${city}-DOCK-${String(rank).padStart(2, "0")}`;
  }

  return {
    load,
    registerCases,
    createPlan,
    sealManifest,
    startHandover,
    ingestScans,
    completeHandover,
    addException,
    releaseException,
    trackCase,
    alerts,
    getManifest,
    listManifestVersions,
    getPlan,
    state,
  };
}
