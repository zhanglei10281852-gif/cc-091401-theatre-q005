import { notFound } from "../lib/errors.js";

// 换箱/拆分的血缘链：新旧箱号互相可达，封签链与例外跨箱合并
function lineageOf(state, caseId) {
  const ids = new Set([caseId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const exception of state.exceptions) {
      const details = exception.details ?? {};
      const children = [];
      if (exception.type === "rebox" && details.newCase) children.push(details.newCase.id);
      if (exception.type === "split") children.push(...(details.newCases ?? []).map((nc) => nc.id));
      if (ids.has(exception.caseId)) {
        for (const child of children) {
          if (!ids.has(child)) {
            ids.add(child);
            changed = true;
          }
        }
      }
      if (children.some((child) => ids.has(child)) && !ids.has(exception.caseId)) {
        ids.add(exception.caseId);
        changed = true;
      }
    }
  }
  return [...ids];
}

// 器材主管扫箱号：返回当前责任人、封签链、缺件状态与例外历史
export function trackCase(store, caseId) {
  const state = store.state;
  const box = state.cases.get(caseId);
  if (!box) throw notFound(`箱 ${caseId} 不存在`);
  const lineage = lineageOf(state, caseId);

  const sealChain = state.sealEvents
    .filter((event) => lineage.includes(event.caseId))
    .map((event) => ({ ...event }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const exceptions = state.exceptions.filter((exception) => lineage.includes(exception.caseId));

  const held = exceptions.some((exception) => exception.type === "hold");
  const missingCase = exceptions.some((exception) => exception.type === "missing_case" && exception.caseId === caseId);
  const compromised =
    sealChain.some((event) => event.action === "break") ||
    exceptions.some((exception) => exception.type === "seal_break" || exception.type === "seal_mismatch");
  const status = missingCase ? "missing" : held ? "held" : compromised ? "compromised" : "normal";

  const custody = state.custody.get(caseId);
  const custodian = custody
    ? { party: custody.party, since: custody.at, source: custody.source }
    : { party: null, since: null, source: "origin", note: `尚未完成交接，责任人为 ${box.route.origin} 起运方` };

  const check = state.itemChecks.get(caseId);
  const expected = box.contents ?? [];
  const missingItemIds = check ? expected.filter((item) => !check.foundItemIds.includes(item.itemId)).map((item) => item.itemId) : null;

  return {
    caseId,
    kind: box.kind,
    tourId: box.tourId,
    route: box.route,
    status,
    custodian,
    sealChain,
    contents: {
      expected,
      lastCheck: check ? { at: check.at, deviceId: check.deviceId } : null,
      missingItemIds,
    },
    exceptions: exceptions.map((exception) => ({
      id: exception.id,
      type: exception.type,
      at: exception.at,
      actor: exception.actor,
      reason: exception.reason,
    })),
    lineage: { caseIds: lineage },
  };
}
