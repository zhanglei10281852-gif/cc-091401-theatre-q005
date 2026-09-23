import { randomUUID } from "node:crypto";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { parseIso } from "../lib/time.js";
import { requireObject, requireString } from "../lib/validate.js";
import { volumeL } from "./planning.js";

// 破封、暂扣、换箱、拆分只能以追加例外的方式记录；
// missing_case / seal_mismatch 由交接确认时的差异自动生成。
export const EXCEPTION_TYPES = ["seal_break", "hold", "rebox", "split", "missing_case", "seal_mismatch"];

function normalizeNewCase(state, original, raw, label) {
  const value = requireObject(raw, label);
  const id = requireString(value.id, `${label}.id`);
  if (state.cases.has(id)) {
    throw conflict("case_exists", `新箱 ${id} 已存在`, [{ code: "duplicate_case", caseId: id }]);
  }
  return {
    id,
    tourId: original.tourId,
    kind: value.kind ?? original.kind,
    dimsCm: value.dimsCm ?? original.dimsCm,
    weightKg: value.weightKg ?? original.weightKg,
    fragile: value.fragile ?? original.fragile,
    hazmatClass: value.hazmatClass ?? original.hazmatClass,
    route: value.route ?? original.route,
    contents: value.contents ?? [],
    linkedFrom: original.id,
    sealId: value.sealId ?? null, // 新箱施加的封签（拆分场景随 details.newCases 提交）
  };
}

export function appendException(store, input) {
  const state = store.state;
  requireObject(input, "请求体");
  const type = requireString(input.type, "type");
  if (!EXCEPTION_TYPES.includes(type)) {
    throw badRequest(`例外类型 type 必须是 ${EXCEPTION_TYPES.join("/")} 之一`);
  }
  const caseId = requireString(input.caseId, "caseId");
  const box = state.cases.get(caseId);
  if (!box) throw notFound(`箱 ${caseId} 不存在`);
  const actor = requireString(input.actor, "actor");
  const reason = requireString(input.reason, "reason");
  const at = input.at ?? new Date().toISOString();
  parseIso(at, "at");
  const details = { ...(input.details ?? {}) };

  if (type === "rebox") {
    const newCase = normalizeNewCase(state, box, details.newCase, "details.newCase");
    newCase.contents = details.newCase.contents ?? box.contents;
    details.newCase = newCase;
  }
  if (type === "split") {
    if (!Array.isArray(details.newCases) || details.newCases.length < 2) {
      throw badRequest("拆分 split 需要 details.newCases 至少两个新箱");
    }
    details.newCases = details.newCases.map((raw, index) => normalizeNewCase(state, box, raw, `details.newCases[${index}]`));
    // 内容物守恒：拆分后的并集必须与原箱一一对应
    const originalIds = (box.contents ?? []).map((item) => item.itemId);
    const distributed = details.newCases.flatMap((nc) => (nc.contents ?? []).map((item) => item.itemId));
    const duplicated = distributed.filter((id, index) => distributed.indexOf(id) !== index);
    const missing = originalIds.filter((id) => !distributed.includes(id));
    const unexpected = distributed.filter((id) => !originalIds.includes(id));
    if (duplicated.length > 0 || missing.length > 0 || unexpected.length > 0) {
      throw badRequest("拆分后的内容物必须与原箱一一对应", [
        { code: "contents_mismatch", duplicatedItemIds: duplicated, missingItemIds: missing, unexpectedItemIds: unexpected },
      ]);
    }
  }

  const exception = { id: input.id ?? `EX-${randomUUID()}`, type, caseId, actor, reason, at, details };
  const impact = assessImpact(state, exception);
  store.record({ type: "exception_appended", exception, impact });
  return { exception, impact };
}

// 后续影响评估：找出该箱涉及的后续运输段、已固化清单、未完成交接；
// 拆分时重新校验后续段舱位是否仍装得下。
export function assessImpact(state, exception) {
  const { caseId, type } = exception;
  const box = state.cases.get(caseId);
  const impact = { affectedLegs: [], manifests: [], pendingHandovers: [], capacityWarnings: [] };
  if (!box) return impact;
  const atMs = parseIso(exception.at, "at");
  const tour = state.tours.get(box.tourId);
  const plan = state.plans.get(box.tourId);

  if (tour && plan) {
    for (const [legIndex, legPlan] of plan.legs.entries()) {
      if (!legPlan.assignments.some((assignment) => assignment.caseId === caseId)) continue;
      const departWindow = tour.stops[legIndex]?.departWindow;
      const departed = departWindow ? parseIso(departWindow.start, "departWindow.start") <= atMs : false;
      impact.affectedLegs.push({ legId: legPlan.legId, vehicleId: legPlan.vehicleId, status: departed ? "already_departed" : "upcoming" });
    }
  }
  for (const [legId, manifest] of state.manifests) {
    if (manifest.entries.some((entry) => entry.caseId === caseId)) {
      impact.manifests.push({
        legId,
        digest: manifest.digest,
        effect: "compromised",
        detail: "原清单与摘要保持不变，例外以追加方式记录",
      });
    }
  }
  for (const handover of state.handovers.values()) {
    if (handover.status === "pending" && handover.caseIds.includes(caseId)) {
      impact.pendingHandovers.push({ handoverId: handover.id, toParty: handover.toParty, dueAt: handover.dueAt });
    }
  }

  if (type === "split" && tour && plan) {
    const newCases = (exception.details.newCases ?? []).map((nc) => state.cases.get(nc.id) ?? nc);
    const addedWeight = newCases.reduce((sum, nc) => sum + nc.weightKg, 0) - box.weightKg;
    const addedVolume = newCases.reduce((sum, nc) => sum + volumeL(nc.dimsCm), 0) - volumeL(box.dimsCm);
    for (const affected of impact.affectedLegs) {
      if (affected.status !== "upcoming") continue;
      const legPlan = plan.legs.find((leg) => leg.legId === affected.legId);
      const assignment = legPlan.assignments.find((a) => a.caseId === caseId);
      const vehicle = state.vehicles.get(legPlan.vehicleId);
      const compartment = vehicle?.compartments.find((comp) => comp.id === assignment?.compartmentId);
      if (!compartment) continue;
      const used = legPlan.assignments
        .filter((a) => a.compartmentId === compartment.id)
        .reduce(
          (acc, a) => {
            const item = state.cases.get(a.caseId);
            if (item) {
              acc.weight += item.weightKg;
              acc.volume += volumeL(item.dimsCm);
            }
            return acc;
          },
          { weight: 0, volume: 0 },
        );
      if (used.weight + addedWeight > compartment.maxWeightKg) {
        impact.capacityWarnings.push({
          code: "overweight_after_split",
          legId: affected.legId,
          compartmentId: compartment.id,
          detail: `拆分后舱位 ${legPlan.vehicleId}/${compartment.id} 将超重 ${Math.round((used.weight + addedWeight - compartment.maxWeightKg) * 10) / 10}kg，需要调整装载`,
        });
      }
      if (used.volume + addedVolume > compartment.maxVolumeL) {
        impact.capacityWarnings.push({
          code: "volume_exceeded_after_split",
          legId: affected.legId,
          compartmentId: compartment.id,
          detail: `拆分后舱位 ${legPlan.vehicleId}/${compartment.id} 将超出容积，需要调整装载`,
        });
      }
    }
  }
  return impact;
}
