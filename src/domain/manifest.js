import { badRequest, conflict, notFound } from "../lib/errors.js";
import { manifestDigest } from "../lib/digest.js";
import { parseIso } from "../lib/time.js";
import { requireString } from "../lib/validate.js";

function findLeg(state, legId) {
  for (const tour of state.tours.values()) {
    const leg = tour.legs.find((candidate) => candidate.id === legId);
    if (leg) return { tour, leg };
  }
  return null;
}

// 封舱：按装载计划核对箱号与封签，固化清单并计算摘要。
// 已固化的清单不可覆盖；内容完全相同的重复封舱按幂等处理。
export function sealManifest(store, legId, body) {
  const state = store.state;
  const found = findLeg(state, legId);
  if (!found) throw notFound(`运输段 ${legId} 不存在`);
  const { tour, leg } = found;
  const plan = state.plans.get(tour.id);
  if (!plan) {
    throw conflict("plan_required", "请先生成装载计划再封舱", [{ code: "plan_missing", legId }]);
  }
  const legPlan = plan.legs.find((candidate) => candidate.legId === legId);
  const expectedCaseIds = legPlan.assignments.map((assignment) => assignment.caseId).sort();

  if (!Array.isArray(body.seals)) {
    throw badRequest("字段 seals 必须是 [{caseId, sealId}] 数组");
  }
  const entries = body.seals.map((raw, index) => ({
    caseId: requireString(raw.caseId, `seals[${index}].caseId`),
    sealId: requireString(raw.sealId, `seals[${index}].sealId`),
  }));
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.caseId)) throw badRequest(`箱 ${entry.caseId} 的封签重复提交`);
    seen.add(entry.caseId);
  }
  const providedCaseIds = entries.map((entry) => entry.caseId).sort();
  const missing = expectedCaseIds.filter((caseId) => !providedCaseIds.includes(caseId));
  const unexpected = providedCaseIds.filter((caseId) => !expectedCaseIds.includes(caseId));
  if (missing.length > 0 || unexpected.length > 0) {
    throw conflict("manifest_case_mismatch", "封签箱号与装载计划不一致", [
      {
        code: "case_mismatch",
        legId,
        missingCaseIds: missing,
        unexpectedCaseIds: unexpected,
        detail: `计划内缺少：${missing.join("、") || "无"}；计划外多出：${unexpected.join("、") || "无"}`,
      },
    ]);
  }

  const sortedEntries = [...entries].sort((a, b) => a.caseId.localeCompare(b.caseId));
  const digest = manifestDigest({ legId, vehicleId: leg.vehicleId, entries: sortedEntries });
  const existing = state.manifests.get(legId);
  if (existing) {
    if (existing.digest === digest) {
      return { manifest: existing, idempotent: true };
    }
    throw conflict("manifest_immutable", "封舱清单已固化，不能覆盖", [
      {
        code: "digest_mismatch",
        legId,
        sealedDigest: existing.digest,
        detail: `段 ${legId} 清单已于 ${existing.sealedAt} 固化（摘要 ${existing.digest.slice(0, 16)}…），如需变更请追加例外`,
      },
    ]);
  }

  const sealedAt = body.at ?? new Date().toISOString();
  parseIso(sealedAt, "at");
  const manifest = { legId, vehicleId: leg.vehicleId, entries: sortedEntries, digest, sealedAt, sealedBy: requireString(body.actor, "actor") };
  store.record({ type: "manifest_sealed", manifest });
  return { manifest, idempotent: false };
}

export function getManifest(store, legId) {
  const manifest = store.state.manifests.get(legId);
  if (!manifest) throw notFound(`段 ${legId} 的封舱清单不存在`);
  return manifest;
}
