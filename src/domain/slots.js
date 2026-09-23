import { conflict, notFound } from "../lib/errors.js";
import { nowIso, parseWindow } from "../lib/time.js";
import { requireObject, requireString } from "../lib/validate.js";

// 确认卸货位：同一卸货位确认后不能被其他段/车辆抢占；
// 重复确认同一分配按幂等处理。
export function confirmUnloadingSlot(store, city, body) {
  requireObject(body, "请求体");
  const state = store.state;
  const slotId = requireString(body.slotId, "slotId");
  const legId = requireString(body.legId, "legId");
  const tour = [...state.tours.values()].find((candidate) => candidate.legs.some((leg) => leg.id === legId));
  if (!tour) throw notFound(`运输段 ${legId} 不存在`);
  const leg = tour.legs.find((candidate) => candidate.id === legId);
  const key = `${city}:${slotId}`;
  const existing = state.slots.get(key);
  if (existing) {
    if (existing.legId === legId) {
      return { slot: existing, idempotent: true };
    }
    throw conflict("slot_conflict", "卸货位已被确认，不能抢占", [
      {
        code: "slot_already_confirmed",
        city,
        slotId,
        heldBy: { legId: existing.legId, vehicleId: existing.vehicleId },
        detail: `卸货位 ${city}/${slotId} 已确认给段 ${existing.legId}（车辆 ${existing.vehicleId}）`,
      },
    ]);
  }
  let window = null;
  if (body.window) {
    parseWindow(body.window, "window");
    window = { start: body.window.start, end: body.window.end };
  }
  const slot = {
    city,
    slotId,
    legId,
    vehicleId: leg.vehicleId,
    window,
    confirmedBy: requireString(body.actor, "actor"),
    confirmedAt: body.at ?? nowIso(),
  };
  store.record({ type: "slot_confirmed", slot });
  return { slot, idempotent: false };
}
