/**
 * 装载与换车规划。
 *
 * 输入多个城市的到离站窗口、箱体台账与车队（含舱位），沿巡演顺序逐段推演：
 * 在首站装车 → 行驶 → 中途站卸/转舱/再装车 → … → 末站卸货交付装台。
 * 每段选择时间窗与舱位都可行的车辆，优先沿用上一段车辆以减少换车。
 * 规划只产出"提案"，封舱清单固化由服务层完成。
 */
import { assignCompartments, checkCityWindow, checkOverweight } from "./rules.js";

const DEFAULTS = {
  loadMinutes: 45,
  unloadMinutes: 45,
  // 换车转舱额外耗时（全部箱体卸到月台再装入另一辆车）
  transferMinutes: 30,
};

/**
 * @param {object} input
 * @param {Array}  input.cities  [{ cityId, arriveAfter, departDeadline }] 按巡演顺序；
 *                               末站的 departDeadline 表示装台必须开始的时间
 * @param {Array}  input.cases   箱体台账
 * @param {Array}  input.fleet   [{ vehicleId, durationMinutes, durationMinutesByLeg?, compartments }]
 * @param {object} [input.unloadSequenceByLeg] { [legId]: { [caseId]: 卸货序号 } }
 * @param {object} [options]    覆盖默认装卸/转舱时长
 * @returns {{ plan: object|null, valid: boolean, reasons: string[] }}
 */
export function planLoading(input, options = {}) {
  const timing = { ...DEFAULTS, ...options };
  const validation = validateInput(input);
  if (validation.length > 0) {
    return { plan: null, valid: false, reasons: validation };
  }
  const { cities, cases, fleet } = input;
  const reasons = [];

  // 整车队级别的静态初判（超重、无舱可容）
  reasons.push(
    ...checkOverweight(cases, fleet.flatMap((v) => v.compartments)),
  );

  const legs = [];
  let previousVehicleId = null;
  // 首站：最早进站后装车上一段，必须在首站离站截止前驶离
  let firstWindow = checkCityWindow({
    cityId: cities[0].cityId,
    arrivalAt: null,
    arriveAfter: cities[0].arriveAfter,
    departDeadline: cities[0].departDeadline,
    workMinutes: timing.loadMinutes,
    workLabel: "装车",
  });
  if (firstWindow.reasons.length > 0) reasons.push(...firstWindow.reasons);
  let prevDepartAt = firstWindow.departAt ?? Date.parse(cities[0].arriveAfter) + timing.loadMinutes * 60000;

  for (let i = 0; i < cities.length - 1; i += 1) {
    const from = cities[i];
    const to = cities[i + 1];
    const legId = `${from.cityId}->${to.cityId}`;
    const isLastLeg = i === cities.length - 2;
    const unloadSequence = input.unloadSequenceByLeg?.[legId] ?? defaultUnloadSequence(cases);

    let selected = null;
    const failedTries = [];
    for (const vehicle of sortWithPreference(fleet, previousVehicleId)) {
      const duration = durationFor(vehicle, legId);
      if (typeof duration !== "number") {
        failedTries.push(`${vehicle.vehicleId}: 缺少该段行驶时长`);
        continue;
      }
      const switched = previousVehicleId !== null && vehicle.vehicleId !== previousVehicleId;
      const arrivalAt = prevDepartAt + duration * 60000;
      const workMinutes = isLastLeg
        ? timing.unloadMinutes
        : timing.unloadMinutes + timing.loadMinutes + (switched ? timing.transferMinutes : 0);
      const windowCheck = checkCityWindow({
        cityId: to.cityId,
        arrivalAt,
        arriveAfter: to.arriveAfter,
        departDeadline: to.departDeadline,
        workMinutes,
        workLabel: switched ? "卸货+换车转舱+装车" : isLastLeg ? "卸货交付" : "卸货+装车",
      });
      if (windowCheck.reasons.length > 0) {
        failedTries.push(`${vehicle.vehicleId}: ${windowCheck.reasons.join("；")}`);
        continue;
      }
      const packing = assignCompartments(cases, vehicle.compartments, unloadSequence);
      if (packing.reasons.length > 0) {
        failedTries.push(`${vehicle.vehicleId}: ${packing.reasons.join("；")}`);
        continue;
      }
      selected = {
        vehicle,
        duration,
        switched,
        arrivalAt,
        windowCheck,
        packing,
      };
      break;
    }

    if (!selected) {
      reasons.push(`${legId}: 无可行车辆——${failedTries.join(" | ")}`);
      legs.push({
        legId,
        fromCity: from.cityId,
        toCity: to.cityId,
        arriveAfter: to.arriveAfter,
        departDeadline: to.departDeadline,
        vehicleId: null,
        feasible: false,
        assignments: [],
        transfer: { switched: false, reason: "上一段未能成行" },
      });
      break; // 后续段失去链式前提，不再推演
    }

    const usedCompartments = [...new Set(selected.packing.assignments.map((a) => a.compartmentId))];
    legs.push({
      legId,
      fromCity: from.cityId,
      toCity: to.cityId,
      departAfter: from.arriveAfter,
      departDeadline: from.departDeadline,
      arriveAfter: to.arriveAfter,
      arriveDeadline: to.departDeadline,
      vehicleId: selected.vehicle.vehicleId,
      durationMinutes: selected.duration,
      feasible: true,
      scheduledDepartureAt: new Date(prevDepartAt).toISOString(),
      scheduledArrivalAt: new Date(selected.arrivalAt).toISOString(),
      scheduledReadyAt: new Date(selected.windowCheck.readyAt).toISOString(),
      scheduledCompleteAt: new Date(selected.windowCheck.departAt).toISOString(),
      waitMinutes: selected.windowCheck.waitMinutes,
      compartments: usedCompartments,
      assignments: selected.packing.assignments,
      loadingOrder: selected.packing.assignments.map((a) => a.caseId),
      unloadSequence: Object.fromEntries(
        Object.entries(unloadSequence).sort((a, b) => a[1] - b[1]),
      ),
      transfer: transferInfo(previousVehicleId, selected.vehicle.vehicleId, to.cityId, selected.switched),
    });
    previousVehicleId = selected.vehicle.vehicleId;
    prevDepartAt = selected.windowCheck.departAt;
  }

  const plan = {
    planId: input.planId ?? `plan-${cities.map((c) => c.cityId).join("-")}`.toLowerCase(),
    timing,
    cities: cities.map((c) => ({ ...c })),
    caseIds: cases.map((c) => c.caseId),
    legs,
    createdAt: new Date().toISOString(),
  };
  return { plan, valid: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function transferInfo(previousVehicleId, vehicleId, city, switched) {
  if (previousVehicleId === null) return { switched: false, reason: "首发段，无需换车" };
  if (!switched) return { switched: false, reason: `沿用 ${previousVehicleId}，同车中转` };
  return {
    switched: true,
    city,
    fromVehicle: previousVehicleId,
    toVehicle: vehicleId,
    reason: `在 ${city} 换车：${previousVehicleId} → ${vehicleId}，全部箱体需在到站窗口内卸车转舱后重新封舱`,
  };
}

function sortWithPreference(fleet, preferredVehicleId) {
  return [...fleet].sort((a, b) => {
    const pa = a.vehicleId === preferredVehicleId ? 0 : 1;
    const pb = b.vehicleId === preferredVehicleId ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return a.vehicleId.localeCompare(b.vehicleId);
  });
}

function durationFor(vehicle, legId) {
  return vehicle.durationMinutesByLeg?.[legId] ?? vehicle.durationMinutes;
}

/** 默认卸货顺序：灯具/索具先卸（装台最先要用），道具次之，服装最后 */
const CATEGORY_UNLOAD_PRIORITY = {
  fragile_light: 1,
  rigging: 2,
  prop: 3,
  costume: 4,
  misc: 5,
};

function defaultUnloadSequence(cases) {
  return Object.fromEntries(
    [...cases]
      .sort((a, b) => {
        const pa = CATEGORY_UNLOAD_PRIORITY[a.category] ?? 5;
        const pb = CATEGORY_UNLOAD_PRIORITY[b.category] ?? 5;
        if (pa !== pb) return pa - pb;
        return a.caseId.localeCompare(b.caseId);
      })
      .map((c, index) => [c.caseId, index + 1]),
  );
}

function validateInput(input) {
  const reasons = [];
  if (!input || typeof input !== "object") return ["规划输入为空"];
  const { cities, cases, fleet } = input;
  if (!Array.isArray(cities) || cities.length < 2) {
    reasons.push("至少需要两个城市的到离站窗口");
  } else {
    for (const city of cities) {
      if (!city?.cityId) reasons.push("存在缺少 cityId 的城市");
      if (Number.isNaN(Date.parse(city?.arriveAfter)))
        reasons.push(`城市 ${city?.cityId ?? "?"} 的 arriveAfter 不是有效时间`);
      if (Number.isNaN(Date.parse(city?.departDeadline)))
        reasons.push(`城市 ${city?.cityId ?? "?"} 的 departDeadline 不是有效时间`);
      if (
        city?.arriveAfter &&
        city?.departDeadline &&
        Date.parse(city.departDeadline) <= Date.parse(city.arriveAfter)
      ) {
        reasons.push(`城市 ${city.cityId} 的离站/装台截止不晚于最早进站时间`);
      }
    }
  }
  if (!Array.isArray(cases) || cases.length === 0) {
    reasons.push("箱体台账为空");
  } else {
    const ids = new Set();
    for (const item of cases) {
      if (!item?.caseId) {
        reasons.push("存在缺少 caseId 的箱体");
        continue;
      }
      if (ids.has(item.caseId)) reasons.push(`箱体编号重复: ${item.caseId}`);
      ids.add(item.caseId);
      for (const field of ["lengthCm", "widthCm", "heightCm", "weightKg"]) {
        if (typeof item[field] !== "number" || item[field] <= 0) {
          reasons.push(`箱体 ${item.caseId} 的 ${field} 必须为正数`);
        }
      }
    }
  }
  if (!Array.isArray(fleet) || fleet.length === 0) {
    reasons.push("车队为空");
  } else {
    for (const vehicle of fleet) {
      if (!vehicle?.vehicleId) reasons.push("存在缺少 vehicleId 的车辆");
      if (!Array.isArray(vehicle?.compartments) || vehicle.compartments.length === 0) {
        reasons.push(`车辆 ${vehicle?.vehicleId ?? "?"} 没有舱位定义`);
      }
      if (
        typeof vehicle?.durationMinutes !== "number" &&
        (!vehicle?.durationMinutesByLeg || Object.keys(vehicle.durationMinutesByLeg).length === 0)
      ) {
        reasons.push(`车辆 ${vehicle?.vehicleId ?? "?"} 缺少 durationMinutes 或 durationMinutesByLeg`);
      }
    }
  }
  return reasons;
}
