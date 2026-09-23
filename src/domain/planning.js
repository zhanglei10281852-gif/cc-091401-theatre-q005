import { badRequest, conflict, notFound } from "../lib/errors.js";
import { parseIso, parseWindow } from "../lib/time.js";
import { requireObject, requireString } from "../lib/validate.js";
import { hazmatConflict } from "./hazmat.js";

export function volumeL(dimsCm) {
  return (dimsCm.l * dimsCm.w * dimsCm.h) / 1000;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

export function normalizeStops(stops) {
  if (!Array.isArray(stops) || stops.length < 2) {
    throw badRequest("stops 至少需要两个城市站");
  }
  return stops.map((raw, index) => {
    requireObject(raw, `stops[${index}]`);
    const stop = { city: requireString(raw.city, `stops[${index}].city`), arriveWindow: null, departWindow: null };
    if (raw.arriveWindow) {
      parseWindow(raw.arriveWindow, `stops[${index}].arriveWindow`);
      stop.arriveWindow = { start: raw.arriveWindow.start, end: raw.arriveWindow.end };
    }
    if (raw.departWindow) {
      parseWindow(raw.departWindow, `stops[${index}].departWindow`);
      stop.departWindow = { start: raw.departWindow.start, end: raw.departWindow.end };
    }
    return stop;
  });
}

export function normalizeLegs(legs, stops) {
  if (!Array.isArray(legs) || legs.length !== stops.length - 1) {
    throw badRequest(`legs 数量必须等于站数减一（${stops.length - 1}）`);
  }
  const seen = new Set();
  return legs.map((raw, index) => {
    requireObject(raw, `legs[${index}]`);
    const id = requireString(raw.id, `legs[${index}].id`);
    if (seen.has(id)) throw badRequest(`运输段 id ${id} 重复`);
    seen.add(id);
    return { id, vehicleId: requireString(raw.vehicleId, `legs[${index}].vehicleId`) };
  });
}

// 到离站窗口冲突检查：同站出发不得早于到达结束；下站到达不得早于上站出发
export function validateWindows(stops) {
  const reasons = [];
  for (const [index, stop] of stops.entries()) {
    if (stop.arriveWindow && stop.departWindow) {
      const arriveEnd = parseIso(stop.arriveWindow.end, "arriveWindow.end");
      const departStart = parseIso(stop.departWindow.start, "departWindow.start");
      if (departStart < arriveEnd) {
        reasons.push({
          code: "window_conflict",
          city: stop.city,
          detail: `${stop.city} 站出发窗口开始 ${stop.departWindow.start} 早于到达窗口结束 ${stop.arriveWindow.end}，装卸与装台时间不足`,
        });
      }
    }
    if (index > 0) {
      const prev = stops[index - 1];
      if (prev.departWindow && stop.arriveWindow) {
        const departStart = parseIso(prev.departWindow.start, "departWindow.start");
        const arriveStart = parseIso(stop.arriveWindow.start, "arriveWindow.start");
        if (arriveStart < departStart) {
          reasons.push({
            code: "transit_window_conflict",
            from: prev.city,
            to: stop.city,
            detail: `到达 ${stop.city} 的窗口开始 ${stop.arriveWindow.start} 早于从 ${prev.city} 出发 ${prev.departWindow.start}，运输时间窗不可行`,
          });
        }
      }
    }
  }
  return reasons;
}

// 装载计划：按段把箱子分配进车辆舱位（重箱优先的首次适配），
// 校验载重、容积与危险品相斥；装载顺序按目的站逆序（先卸的后装）。
export function buildPlan(state, tour) {
  const reasons = [];
  const cityIndex = new Map(tour.stops.map((stop, index) => [stop.city, index]));
  const legCases = tour.legs.map(() => []);
  for (const box of state.cases.values()) {
    if (box.tourId !== tour.id) continue;
    const originIndex = cityIndex.get(box.route.origin);
    const destIndex = cityIndex.get(box.route.destination);
    if (originIndex === undefined || destIndex === undefined || originIndex >= destIndex) {
      reasons.push({
        code: "invalid_route",
        caseId: box.id,
        detail: `箱 ${box.id} 的路线 ${box.route.origin} → ${box.route.destination} 与巡演站序不符`,
      });
      continue;
    }
    for (let legIndex = originIndex; legIndex < destIndex; legIndex++) {
      legCases[legIndex].push(box);
    }
  }

  const planLegs = [];
  for (const [legIndex, leg] of tour.legs.entries()) {
    const vehicle = state.vehicles.get(leg.vehicleId);
    if (!vehicle) {
      reasons.push({ code: "unknown_vehicle", legId: leg.id, vehicleId: leg.vehicleId, detail: `段 ${leg.id} 指定的车辆 ${leg.vehicleId} 未注册` });
      continue;
    }
    const compartments = vehicle.compartments.map((comp) => ({
      id: comp.id,
      maxWeightKg: comp.maxWeightKg,
      maxVolumeL: comp.maxVolumeL,
      usedWeight: 0,
      usedVolume: 0,
      hazmatClasses: new Set(),
    }));
    const assignments = [];
    const sorted = [...legCases[legIndex]].sort((a, b) => b.weightKg - a.weightKg || a.id.localeCompare(b.id));
    for (const box of sorted) {
      const volume = volumeL(box.dimsCm);
      let placed = null;
      let failure = { code: "no_compartment", detail: `车辆 ${vehicle.id} 没有舱位能容纳箱 ${box.id}` };
      for (const comp of compartments) {
        if (comp.usedWeight + box.weightKg > comp.maxWeightKg) {
          failure = {
            code: "overweight",
            compartmentId: comp.id,
            detail: `箱 ${box.id} 重 ${box.weightKg}kg，舱位 ${vehicle.id}/${comp.id} 剩余载重 ${round1(comp.maxWeightKg - comp.usedWeight)}kg`,
          };
          continue;
        }
        if (comp.usedVolume + volume > comp.maxVolumeL) {
          failure = {
            code: "volume_exceeded",
            compartmentId: comp.id,
            detail: `箱 ${box.id} 体积 ${round1(volume)}L，舱位 ${vehicle.id}/${comp.id} 剩余容积 ${round1(comp.maxVolumeL - comp.usedVolume)}L`,
          };
          continue;
        }
        const clash = [...comp.hazmatClasses].find((existing) => hazmatConflict(existing, box.hazmatClass));
        if (clash) {
          failure = {
            code: "incompatible_hazmat",
            compartmentId: comp.id,
            hazmat: [box.hazmatClass, clash],
            detail: `箱 ${box.id} 的危险品类别 ${box.hazmatClass} 与舱位 ${vehicle.id}/${comp.id} 内已有的 ${clash} 相斥，不能同舱运输`,
          };
          continue;
        }
        placed = comp;
        break;
      }
      if (!placed) {
        reasons.push({ caseId: box.id, legId: leg.id, ...failure });
      } else {
        placed.usedWeight += box.weightKg;
        placed.usedVolume += volume;
        if (box.hazmatClass && box.hazmatClass !== "none") placed.hazmatClasses.add(box.hazmatClass);
        assignments.push({ caseId: box.id, compartmentId: placed.id, destIndex: cityIndex.get(box.route.destination) });
      }
    }
    planLegs.push({ legId: leg.id, vehicleId: leg.vehicleId, assignments });
  }
  if (reasons.length > 0) {
    throw conflict("plan_infeasible", "装载计划不可行", reasons);
  }

  // 换车计划：相邻段车辆不同，继续前行的箱子需要在换乘站换车
  const transfers = [];
  for (let index = 1; index < tour.legs.length; index++) {
    const prev = tour.legs[index - 1];
    const curr = tour.legs[index];
    if (prev.vehicleId === curr.vehicleId) continue;
    const continuing = planLegs[index].assignments.filter((a) => a.destIndex > index).map((a) => a.caseId);
    const stop = tour.stops[index];
    transfers.push({
      atCity: stop.city,
      fromVehicleId: prev.vehicleId,
      toVehicleId: curr.vehicleId,
      caseIds: continuing,
      window: { arrive: stop.arriveWindow, depart: stop.departWindow },
    });
  }

  // 装卸顺序：目的地越晚的箱子越先装（后卸），保证先卸的箱子最后装、最先能卸
  for (const legPlan of planLegs) {
    legPlan.assignments.sort((a, b) => b.destIndex - a.destIndex || a.caseId.localeCompare(b.caseId));
    legPlan.assignments.forEach((assignment, index) => {
      assignment.loadOrder = index + 1;
      delete assignment.destIndex;
    });
  }

  return { tourId: tour.id, legs: planLegs, transfers };
}

// 生成或重排计划。重排时保护已固化的封舱清单与已确认的卸货位：
// 只有显式 releaseSlots 才能释放卸货位，无关重排不能抢走。
export function planTour(store, tourId, body = {}, at) {
  const state = store.state;
  const tour = state.tours.get(tourId);
  if (!tour) throw notFound(`巡演 ${tourId} 不存在`);

  const nextStops = body.stops ? normalizeStops(body.stops) : tour.stops;
  const nextLegs = body.legs ? normalizeLegs(body.legs, nextStops) : tour.legs;
  const windowReasons = validateWindows(nextStops);
  if (windowReasons.length > 0) {
    throw conflict("window_conflict", "到离站时间窗冲突", windowReasons);
  }

  const candidate = buildPlan(state, { ...tour, stops: nextStops, legs: nextLegs });

  const blocked = [];
  for (const [legId, manifest] of state.manifests) {
    if (!tour.legs.some((leg) => leg.id === legId)) continue;
    const legPlan = candidate.legs.find((leg) => leg.legId === legId);
    const plannedCaseIds = new Set((legPlan?.assignments ?? []).map((a) => a.caseId));
    const sealedCaseIds = manifest.entries.map((entry) => entry.caseId);
    const missing = sealedCaseIds.filter((caseId) => !plannedCaseIds.has(caseId));
    if (!legPlan || legPlan.vehicleId !== manifest.vehicleId || missing.length > 0) {
      blocked.push({
        code: "manifest_immutable",
        legId,
        missingCaseIds: missing,
        detail: `段 ${legId} 的封舱清单已于 ${manifest.sealedAt} 固化（摘要 ${manifest.digest.slice(0, 16)}…），重排不能改变其内容，如需变更请追加例外`,
      });
    }
  }

  const releases = Array.isArray(body.releaseSlots) ? body.releaseSlots : [];
  const releaseKeys = new Set(releases.map((r) => `${r.city}:${r.slotId}`));
  for (const [key, slot] of state.slots) {
    if (!tour.legs.some((leg) => leg.id === slot.legId)) continue;
    if (releaseKeys.has(key)) continue;
    const legPlan = candidate.legs.find((leg) => leg.legId === slot.legId);
    if (!legPlan || legPlan.vehicleId !== slot.vehicleId) {
      blocked.push({
        code: "slot_protected",
        city: slot.city,
        slotId: slot.slotId,
        detail: `卸货位 ${slot.city}/${slot.slotId} 已确认给段 ${slot.legId}（车辆 ${slot.vehicleId}），无关重排不能抢占；如确需调整请在 releaseSlots 中显式释放`,
      });
    }
  }
  if (blocked.length > 0) {
    throw conflict("replan_blocked", "重排被已固化的记录阻止", blocked);
  }

  for (const release of releases) {
    store.record({
      type: "slot_released",
      city: requireString(release.city, "releaseSlots.city"),
      slotId: requireString(release.slotId, "releaseSlots.slotId"),
      actor: release.actor ?? "system",
      reason: release.reason ?? "",
      at,
    });
  }
  if (body.stops || body.legs) {
    store.record({ type: "tour_updated", tourId, stops: nextStops, legs: nextLegs, at });
  }
  const plan = { ...candidate, version: (state.plans.get(tourId)?.version ?? 0) + 1, createdAt: at };
  store.record({ type: "plan_created", plan });
  return plan;
}
