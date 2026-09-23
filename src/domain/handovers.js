import { randomUUID } from "node:crypto";
import { conflict, notFound } from "../lib/errors.js";
import { nowIso, parseIso } from "../lib/time.js";
import { requireObject, requireString, requireStringArray } from "../lib/validate.js";
import { appendException } from "./exceptions.js";

export function createHandover(store, body) {
  requireObject(body, "请求体");
  const state = store.state;
  const id = body.id ?? `HO-${randomUUID()}`;
  if (state.handovers.has(id)) {
    throw conflict("handover_exists", `交接 ${id} 已存在，历史交接不可覆盖`, [{ code: "duplicate_handover", handoverId: id }]);
  }
  const tourId = requireString(body.tourId, "tourId");
  if (!state.tours.has(tourId)) throw notFound(`巡演 ${tourId} 不存在`);
  const caseIds = requireStringArray(body.caseIds, "caseIds");
  for (const caseId of caseIds) {
    if (!state.cases.has(caseId)) throw notFound(`箱 ${caseId} 不存在`);
  }
  const dueAt = requireString(body.dueAt, "dueAt");
  parseIso(dueAt, "dueAt");
  const handover = {
    id,
    tourId,
    legId: body.legId ?? null,
    city: requireString(body.city, "city"),
    fromParty: requireString(body.fromParty, "fromParty"),
    toParty: requireString(body.toParty, "toParty"),
    caseIds,
    dueAt,
    sequence: body.sequence ?? null, // 交接记录序号（如 handoverSequence）
    status: "pending",
    createdAt: body.at ?? nowIso(),
  };
  store.record({ type: "handover_created", handover });
  return handover;
}

// 确认交接：核对实收箱与封签，差异自动生成缺箱/封签不符例外。
// 已确认的交接是历史记录，再次确认一律拒绝，不可覆盖。
export function confirmHandover(store, id, body) {
  const state = store.state;
  const handover = state.handovers.get(id);
  if (!handover) throw notFound(`交接 ${id} 不存在`);
  if (handover.status === "confirmed") {
    throw conflict("handover_immutable", "历史交接不可被覆盖", [
      { code: "already_confirmed", handoverId: id, confirmedAt: handover.confirmedAt, detail: `交接 ${id} 已于 ${handover.confirmedAt} 确认，不能再次确认或修改` },
    ]);
  }
  const at = body.at ?? nowIso();
  parseIso(at, "at");
  const received = body.receivedCaseIds ?? handover.caseIds;
  requireStringArray(received, "receivedCaseIds");
  const missingCaseIds = handover.caseIds.filter((caseId) => !received.includes(caseId));
  const unexpectedCaseIds = received.filter((caseId) => !handover.caseIds.includes(caseId));

  // 封签核对：与所有已固化清单中的封签编号比对
  const sealMismatches = [];
  if (body.observedSeals && typeof body.observedSeals === "object") {
    for (const [caseId, observedSealId] of Object.entries(body.observedSeals)) {
      for (const manifest of state.manifests.values()) {
        const entry = manifest.entries.find((candidate) => candidate.caseId === caseId);
        if (entry && entry.sealId !== observedSealId) {
          sealMismatches.push({ caseId, expectedSealId: entry.sealId, observedSealId, legId: manifest.legId });
        }
      }
    }
  }

  const discrepancies = { missingCaseIds, unexpectedCaseIds, sealMismatches };
  store.record({
    type: "handover_confirmed",
    handoverId: id,
    confirmedAt: at,
    actor: body.actor ?? "system",
    receivedCaseIds: received,
    discrepancies,
  });

  const followUps = [];
  for (const caseId of missingCaseIds) {
    followUps.push(
      appendException(store, {
        type: "missing_case",
        caseId,
        actor: body.actor ?? "system",
        reason: `交接 ${id} 确认时未收到该箱`,
        at,
        details: { handoverId: id, source: "handover" },
      }),
    );
  }
  for (const mismatch of sealMismatches) {
    followUps.push(
      appendException(store, {
        type: "seal_mismatch",
        caseId: mismatch.caseId,
        actor: body.actor ?? "system",
        reason: `交接 ${id} 封条编号与固化清单不符`,
        at,
        details: { ...mismatch, handoverId: id, source: "handover" },
      }),
    );
  }
  return { handover: state.handovers.get(id), discrepancies, followUps };
}

// 超时提醒：对所有超期未完成的交接触发一次提醒（幂等）。
// 基于事件重放与当前时间计算，重启后自然保持连续。
export function sweepReminders(store, now) {
  const nowMs = parseIso(now, "now");
  const fired = [];
  for (const handover of store.state.handovers.values()) {
    if (handover.status !== "pending") continue;
    if (store.state.reminders.has(handover.id)) continue;
    if (nowMs > parseIso(handover.dueAt, "dueAt")) {
      const reminder = {
        handoverId: handover.id,
        dueAt: handover.dueAt,
        firedAt: now,
        message: `交接 ${handover.id}（${handover.fromParty} → ${handover.toParty}，${handover.caseIds.length} 箱）已超过时限 ${handover.dueAt} 仍未完成`,
      };
      store.record({ type: "reminder_fired", reminder });
      fired.push(reminder);
    }
  }
  return fired;
}

export function listPendingHandovers(store, now) {
  sweepReminders(store, now);
  const nowMs = parseIso(now, "now");
  return [...store.state.handovers.values()]
    .filter((handover) => handover.status === "pending")
    .map((handover) => ({
      ...handover,
      overdue: nowMs > parseIso(handover.dueAt, "dueAt"),
      reminded: store.state.reminders.has(handover.id),
    }));
}
