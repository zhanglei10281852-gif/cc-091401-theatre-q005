import { DomainError, badRequest, notFound } from "../lib/errors.js";
import { nowIso, parseIso } from "../lib/time.js";
import { requireInteger, requireObject, requireString } from "../lib/validate.js";
import { appendException } from "./exceptions.js";

export const SCAN_ACTIONS = ["load", "unload", "verify_seal", "break_seal", "custody", "item_check"];

// 离线扫码恢复：同一设备同一序列号只应用一次（幂等合并），
// 重复上报返回原记录；破封扫码自动追加破封例外并触发影响评估。
export function syncScans(store, body) {
  requireObject(body, "请求体");
  if (!Array.isArray(body.scans) || body.scans.length === 0) {
    throw badRequest("字段 scans 必须是非空数组");
  }
  const results = body.scans.map((raw, index) => {
    try {
      return applyScan(store, raw, index);
    } catch (error) {
      if (error instanceof DomainError) {
        return { key: raw?.deviceId != null ? `${raw.deviceId}:${raw.deviceSeq}` : `index:${index}`, status: "rejected", error: { code: error.code, message: error.message } };
      }
      throw error;
    }
  });
  return {
    results,
    applied: results.filter((r) => r.status === "applied").length,
    duplicates: results.filter((r) => r.status === "duplicate").length,
    rejected: results.filter((r) => r.status === "rejected").length,
  };
}

function applyScan(store, raw, index) {
  requireObject(raw, `scans[${index}]`);
  const deviceId = requireString(raw.deviceId, `scans[${index}].deviceId`);
  const deviceSeq = requireInteger(raw.deviceSeq, `scans[${index}].deviceSeq`, { min: 0 });
  const key = `${deviceId}:${deviceSeq}`;
  const existing = store.state.scans.get(key);
  if (existing) {
    return { key, status: "duplicate", scan: existing };
  }
  const caseId = requireString(raw.caseId, `scans[${index}].caseId`);
  if (!store.state.cases.has(caseId)) {
    throw notFound(`箱 ${caseId} 不存在`);
  }
  const action = requireString(raw.action, `scans[${index}].action`);
  if (!SCAN_ACTIONS.includes(action)) {
    throw badRequest(`扫码动作 action 必须是 ${SCAN_ACTIONS.join("/")} 之一`);
  }
  const at = raw.at ?? nowIso();
  parseIso(at, `scans[${index}].at`);
  const scan = {
    deviceId,
    deviceSeq,
    caseId,
    action,
    at,
    actor: raw.actor ?? null,
    party: raw.party ?? null,
    sealId: raw.sealId ?? null,
    foundItemIds: raw.foundItemIds ?? null,
    receivedAt: nowIso(), // 外部记录保留来源与接收时间
  };
  if (action === "custody" && !scan.party) {
    throw badRequest("custody 扫码需要 party 字段（接收方）");
  }
  if (action === "item_check" && !Array.isArray(scan.foundItemIds)) {
    throw badRequest("item_check 扫码需要 foundItemIds 数组");
  }
  store.record({ type: "scan_recorded", scan });

  let followUp = null;
  if (action === "break_seal") {
    followUp = appendException(store, {
      type: "seal_break",
      caseId,
      actor: scan.actor ?? deviceId,
      reason: `设备 ${deviceId} 扫码上报破封`,
      at,
      details: { sealId: scan.sealId, source: "scan", deviceId, deviceSeq },
    });
  }
  return { key, status: "applied", scan, followUp };
}
