/**
 * 例外影响评估。
 *
 * 破封、暂扣、换箱、拆分只能追加例外记录；本模块对追加的例外做事后评估：
 * 沿计划后续各段重跑装载规则，给出被阻塞的段、受影响封舱清单、
 * 缺件风险与必须重新封签等具体结论。评估不改写任何历史记录。
 */
import { assignCompartments } from "./rules.js";

const EXCEPTION_TYPES = new Set(["broken_seal", "held", "swap", "split"]);

export function isValidExceptionType(type) {
  return EXCEPTION_TYPES.has(type);
}

/**
 * @param state 服务层还原的状态（需提供 cases 台账 Map、fleet、plans、manifests、handovers）
 * @param exception 已追加的例外
 * @returns 结构化影响评估
 */
export function assessException(state, exception) {
  switch (exception.type) {
    case "broken_seal":
      return assessBrokenSeal(state, exception);
    case "held":
      return assessHeld(state, exception);
    case "swap":
      return assessSwap(state, exception);
    case "split":
      return assessSplit(state, exception);
    default:
      return {
        exceptionId: exception.exceptionId,
        type: exception.type,
        blockedLegs: [],
        reasons: [`未知例外类型 ${exception.type}`],
      };
  }
}

function latestPlan(state) {
  const plans = state.plans ? [...state.plans.values()] : [];
  return plans.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null;
}

function futureLegs(state, fromLegId) {
  const plan = latestPlan(state);
  if (!plan) return [];
  const startIndex = plan.legs.findIndex((leg) => leg.legId === fromLegId);
  const slice = startIndex === -1 ? plan.legs : plan.legs.slice(startIndex);
  return slice.filter((leg) => leg.feasible);
}

function manifestsForLeg(state, legId) {
  return [...(state.manifests?.values() ?? [])].filter((manifest) => manifest.legId === legId);
}

function legContainsCase(leg, caseId) {
  return leg.assignments.some((assignment) => assignment.caseId === caseId);
}

function futureManifests(state, legId, caseIds) {
  const out = [];
  for (const leg of futureLegs(state, legId)) {
    for (const manifest of manifestsForLeg(state, leg.legId)) {
      if (manifest.entries.some((entry) => caseIds.includes(entry.caseId))) {
        out.push({
          manifestId: manifest.manifestId,
          legId: leg.legId,
          version: manifest.version,
          note: "历史封舱清单不可改写，重启封舱须另出新版本",
        });
      }
    }
  }
  return out;
}

function pendingHandoversForCase(state, caseIds) {
  return [...(state.handovers?.values() ?? [])].filter(
    (handover) =>
      handover.status === "pending" && handover.expectedCaseIds.some((id) => caseIds.includes(id)),
  );
}

/** 用替换表重建某段计划箱体，并在该段原车辆上复算装载 */
function repackLeg(state, leg, replacements) {
  const vehicle = state.fleet.find((v) => v.vehicleId === leg.vehicleId);
  if (!vehicle) return { reasons: [`段 ${leg.legId} 的车辆 ${leg.vehicleId} 已不在车队，无法复算`] };
  const cases = [];
  for (const id of leg.assignments.map((a) => a.caseId)) {
    if (replacements.has(id)) {
      cases.push(...replacements.get(id));
    } else {
      const item = state.cases.get(id);
      if (item) cases.push(item);
    }
  }
  return assignCompartments(cases, vehicle.compartments, leg.unloadSequence);
}

function assessBrokenSeal(state, exception) {
  const { caseId, legId } = exception;
  const reasons = [`箱体 ${caseId} 必须重新施封并开箱核验内物后方可再次封舱`];
  const affectedManifests = [];
  for (const leg of futureLegs(state, legId)) {
    if (!legContainsCase(leg, caseId)) continue;
    for (const manifest of manifestsForLeg(state, leg.legId)) {
      if (manifest.entries.some((entry) => entry.caseId === caseId)) {
        affectedManifests.push({
          manifestId: manifest.manifestId,
          legId: leg.legId,
          version: manifest.version,
          note: "该封舱清单基于旧封签固化，仅作历史记录；重启封舱须另出新版本",
        });
      }
    }
  }
  for (const handover of pendingHandoversForCase(state, [caseId])) {
    reasons.push(
      `进行中的交接 ${handover.handoverId}（${handover.fromParty}→${handover.toParty}）仍登记 ${caseId} 的旧封签，破封后扫码比对将判定封签不符，需重新施封并追加新版本封舱清单`,
    );
  }
  return {
    exceptionId: exception.exceptionId,
    type: "broken_seal",
    blockedLegs: [], // 破封本身不阻塞运输，重新封签即可
    affectedManifests,
    resealRequired: true,
    missingRisk: "破封期间存在内物遗失风险，开箱核验前按疑似缺件处理",
    reasons,
  };
}

function assessHeld(state, exception) {
  const { caseId, legId } = exception;
  const reasons = [];
  const blockedLegs = [];
  const legs = futureLegs(state, legId).filter((leg) => legContainsCase(leg, caseId));
  for (const leg of legs) {
    const legReasons = [
      `箱体 ${caseId} 被暂扣（${exception.reason ?? "未注明依据"}），无法在 ${leg.legId} 段装车发运`,
    ];
    const sealed = manifestsForLeg(state, leg.legId);
    if (sealed.length > 0) {
      legReasons.push(
        `该段封舱清单 ${sealed.at(-1).manifestId} 已固化含此箱，历史清单不可改写，须凭例外在现场做短装批注并安排补运`,
      );
    } else {
      legReasons.push("该段尚未封舱，需先解除暂扣或改走补运，再行封舱");
    }
    blockedLegs.push({ legId: leg.legId, reasons: legReasons });
    reasons.push(...legReasons);
  }
  if (blockedLegs.length === 0) {
    reasons.push(`暂扣的 ${caseId} 不在 ${legId} 之后的任何运输段内，不影响后续发运`);
  }
  return {
    exceptionId: exception.exceptionId,
    type: "held",
    blockedLegs,
    missingRisk: `后续装台将缺少 ${caseId}，器材主管追踪视图标记缺件，解除暂扣前不消失`,
    releaseBeforeShip: true,
    reasons,
  };
}

function assessSwap(state, exception) {
  const { caseId, otherCaseId, legId } = exception;
  const reasons = [];
  if (!state.cases.has(caseId) || !state.cases.has(otherCaseId)) {
    const missing = !state.cases.has(caseId) ? caseId : otherCaseId;
    reasons.push(`换箱评估失败: ${missing} 不在箱体台账中`);
  }
  const blockedLegs = [];
  for (const leg of futureLegs(state, legId)) {
    if (!state.cases.has(caseId) || !state.cases.has(otherCaseId)) break;
    if (!legContainsCase(leg, caseId) && !legContainsCase(leg, otherCaseId)) continue;
    // 两只箱交换去向：凡该段含其中任一只，复算时两只都按交换后在场处理
    const result = repackLeg(
      state,
      leg,
      new Map([
        [caseId, [state.cases.get(otherCaseId)]],
        [otherCaseId, [state.cases.get(caseId)]],
      ]),
    );
    const legReasons = result.reasons.map((reason) => `换箱后 ${reason}`);
    if (legReasons.length > 0) blockedLegs.push({ legId: leg.legId, reasons: legReasons });
    reasons.push(...legReasons);
  }
  if (blockedLegs.length === 0 && reasons.length === 0) {
    reasons.push(`换箱 ${caseId} ↔ ${otherCaseId} 不影响后续各段舱位适装与时间窗`);
  }
  return {
    exceptionId: exception.exceptionId,
    type: "swap",
    blockedLegs,
    affectedManifests: futureManifests(state, legId, [caseId, otherCaseId]),
    resealRequired: true,
    reasons,
  };
}

function assessSplit(state, exception) {
  const { caseId, legId, newCases } = exception;
  const parent = state.cases.get(caseId);
  const reasons = [];
  const blockedLegs = [];

  if (parent && Array.isArray(newCases) && newCases.length > 0) {
    const totalNewWeight = newCases.reduce((sum, c) => sum + c.weightKg, 0);
    if (Math.abs(totalNewWeight - parent.weightKg) > parent.weightKg * 0.05) {
      reasons.push(
        `拆分重量异常: 母箱 ${caseId} ${parent.weightKg}kg，${newCases.length} 只新箱合计 ${totalNewWeight}kg，偏差超过 5%，需核实内物是否遗漏`,
      );
    }
    const children = newCases.map((c) => ({
      hazard: "none",
      category: parent.category,
      ...c,
    }));
    for (const leg of futureLegs(state, legId)) {
      if (!legContainsCase(leg, caseId)) continue;
      const result = repackLeg(state, leg, new Map([[caseId, children]]));
      const legReasons = result.reasons.map((reason) => `拆分后 ${reason}`);
      if (legReasons.length > 0) blockedLegs.push({ legId: leg.legId, reasons: legReasons });
      reasons.push(...legReasons);
    }
  }
  if (blockedLegs.length === 0 && reasons.length === 0) {
    reasons.push(
      `拆分 ${caseId} → ${newCases.map((c) => c.caseId).join("、")} 后后续各段仍可行，母箱待子箱全部签收后核销`,
    );
  }
  return {
    exceptionId: exception.exceptionId,
    type: "split",
    blockedLegs,
    newCaseIds: (newCases ?? []).map((c) => c.caseId),
    affectedManifests: futureManifests(state, legId, [caseId]),
    resealRequired: true,
    missingRisk: "拆分过渡期内容易漏扫子箱，母箱在后续段标记缺件直至子箱全部签收",
    reasons,
  };
}

/** 供例外登记入口做字段校验 */
export function validateExceptionPayload(payload) {
  const reasons = [];
  if (!isValidExceptionType(payload?.type)) {
    reasons.push(
      `例外类型必须是 broken_seal/held/swap/split 之一，收到: ${String(payload?.type)}`,
    );
  }
  if (!payload?.caseId) reasons.push("例外必须关联箱体 caseId");
  if (!payload?.legId) reasons.push("例外必须标注发生段 legId");
  if (payload?.type === "swap" && !payload.otherCaseId) {
    reasons.push("换箱例外必须提供 otherCaseId");
  }
  if (payload?.type === "split") {
    if (!Array.isArray(payload.newCases) || payload.newCases.length === 0) {
      reasons.push("拆分例外必须提供至少一只新箱 newCases[]");
    } else {
      for (const item of payload.newCases) {
        if (!item?.caseId) reasons.push("拆分产生的新箱缺少 caseId");
        for (const field of ["lengthCm", "widthCm", "heightCm", "weightKg"]) {
          if (typeof item?.[field] !== "number" || item[field] <= 0) {
            reasons.push(`新箱 ${item?.caseId ?? "?"} 的 ${field} 必须为正数`);
          }
        }
      }
    }
  }
  return reasons;
}
