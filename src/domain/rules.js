/**
 * 运输规则：危险品相斥、超重、舱位适配、时间窗冲突、装卸顺序。
 *
 * 所有校验函数返回原因字符串数组（空数组表示通过），原因必须具体到箱体/舱位/数值，
 * 供装载计划拒绝、例外影响评估与 API 错误响应直接展示。
 */

/**
 * 危险品类别相斥矩阵（对称）。
 * lithium_battery 易碎灯具的备用锂电；pyrotechnic 演出烟火；aerosol 喷雾（服装定型/道具效果）。
 */
export const INCOMPATIBLE_HAZARDS = {
  pyrotechnic: new Set(["aerosol", "lithium_battery"]),
  aerosol: new Set(["pyrotechnic"]),
  lithium_battery: new Set(["pyrotechnic"]),
};

/** 危险品（含第 9 类锂电）必须装载于带危险适装标记的舱位 */
export const HAZARD_CLASSES = new Set(["pyrotechnic", "aerosol", "lithium_battery"]);

/** 已知的箱体类别 */
export const CASE_CATEGORIES = new Set(["prop", "costume", "fragile_light", "rigging", "misc"]);

export function isHazard(kind) {
  return HAZARD_CLASSES.has(kind);
}

export function hazardLabel(kind) {
  return {
    pyrotechnic: "烟火制品(1.4G)",
    aerosol: "加压喷雾(2.1)",
    lithium_battery: "锂电池(第9类)",
  }[kind] ?? kind;
}

/** 同舱危险品相斥检查（对整批箱体两两判定，用于规划前的整体拒绝） */
export function checkHazardConflict(cases) {
  const reasons = [];
  for (const item of cases) {
    if (!isHazard(item.hazard)) continue;
    for (const other of cases) {
      if (other.caseId === item.caseId) continue;
      if (INCOMPATIBLE_HAZARDS[item.hazard]?.has(other.hazard)) {
        reasons.push(
          `危险品相斥: 箱体 ${item.caseId}(${hazardLabel(item.hazard)}) 不能与 ${other.caseId}(${hazardLabel(other.hazard)}) 同舱`,
        );
      }
    }
  }
  return [...new Set(reasons)];
}

/** 整车队级别的超重/超尺寸初判 */
export function checkOverweight(cases, compartments) {
  const reasons = [];
  const totalWeight = cases.reduce((sum, item) => sum + item.weightKg, 0);
  const fleetCapacity = compartments.reduce((sum, c) => sum + c.payloadKg, 0);
  if (totalWeight > fleetCapacity) {
    reasons.push(
      `超重: 货物总重 ${round(totalWeight)}kg 超过全部舱位载重合计 ${fleetCapacity}kg（超出 ${round(totalWeight - fleetCapacity)}kg）`,
    );
  }
  for (const item of cases) {
    const fits = compartments.some(
      (c) =>
        c.payloadKg >= item.weightKg &&
        c.lengthCm * c.widthCm * c.heightCm >= item.lengthCm * item.widthCm * item.heightCm,
    );
    if (!fits) {
      reasons.push(
        `超重/超尺寸: 箱体 ${item.caseId} 重 ${item.weightKg}kg、尺寸 ${item.lengthCm}x${item.widthCm}x${item.heightCm}cm，没有任何舱位可容纳`,
      );
    }
  }
  return reasons;
}

/** 单个舱位适装检查（危险品标记、载重、边长、体积） */
export function checkCompartmentFit(item, compartment) {
  const reasons = [];
  if (isHazard(item.hazard) && !compartment.hazardCapable) {
    reasons.push(
      `危险品规则: 箱体 ${item.caseId} 含${hazardLabel(item.hazard)}，舱位 ${compartment.compartmentId} 无危险品适装标记`,
    );
  }
  if (item.weightKg > compartment.payloadKg) {
    reasons.push(
      `超重: 箱体 ${item.caseId} 重 ${item.weightKg}kg，超过舱位 ${compartment.compartmentId} 载重上限 ${compartment.payloadKg}kg`,
    );
  }
  if (
    item.lengthCm > compartment.lengthCm ||
    item.widthCm > compartment.widthCm ||
    item.heightCm > compartment.heightCm
  ) {
    reasons.push(
      `超尺寸: 箱体 ${item.caseId}(${item.lengthCm}x${item.widthCm}x${item.heightCm}cm) 放不进舱位 ${compartment.compartmentId}(${compartment.lengthCm}x${compartment.widthCm}x${compartment.heightCm}cm)`,
    );
  }
  return reasons;
}

/**
 * 单城时间窗推演。
 *
 * 城市窗口：arriveAfter 为场地最早可进站时间（早到需等待），departDeadline 为必须离站
 * （末站为装台必须开始）时间。车辆到站后完成 workMinutes 分钟作业（卸货+转舱+装下一段）
 * 才能离站。
 *
 * @returns {{ reasons: string[], readyAt: number|null, departAt: number|null }}
 */
export function checkCityWindow({
  cityId,
  arrivalAt,
  arriveAfter,
  departDeadline,
  workMinutes,
  workLabel,
}) {
  const reasons = [];
  const openMs = Date.parse(arriveAfter);
  const deadlineMs = Date.parse(departDeadline);
  if (Number.isNaN(openMs) || Number.isNaN(deadlineMs)) {
    return {
      reasons: [`时间窗: 城市 ${cityId} 的窗口时间无效（${arriveAfter} ~ ${departDeadline}）`],
      readyAt: null,
      departAt: null,
    };
  }
  if (deadlineMs <= openMs) {
    reasons.push(
      `时间窗冲突: 城市 ${cityId} 的离站/装台截止 ${departDeadline} 不晚于最早进站 ${arriveAfter}`,
    );
  }
  const readyMs = arrivalAt === null ? openMs : Math.max(arrivalAt, openMs);
  const waitMinutes =
    arrivalAt !== null && arrivalAt < openMs ? Math.round((openMs - arrivalAt) / 60000) : 0;
  const departMs = readyMs + workMinutes * 60000;

  if (arrivalAt !== null && arrivalAt > deadlineMs) {
    reasons.push(
      `时间窗冲突: 车辆 ${Math.round((arrivalAt - deadlineMs) / 60000)} 分钟后才抵达 ${cityId}（${new Date(arrivalAt).toISOString()}），已错过截止 ${departDeadline}`,
    );
  } else if (departMs > deadlineMs) {
    reasons.push(
      `时间窗冲突: ${cityId} 站${waitMinutes > 0 ? `早到等待 ${waitMinutes} 分钟，` : ""}${workLabel}需 ${workMinutes} 分钟，最早 ${new Date(departMs).toISOString()} 才能离站/交付，比截止 ${departDeadline} 晚 ${Math.round((departMs - deadlineMs) / 60000)} 分钟`,
    );
  }
  return {
    reasons,
    readyAt: reasons.length === 0 ? readyMs : null,
    departAt: reasons.length === 0 ? departMs : null,
    waitMinutes,
  };
}

/**
 * 计算装车顺序：后卸先装（LIFO）。
 * @param unloadSequence 箱体在下一站的卸货序号（小者先卸）
 * @returns 装车序号列表（小者先装），未列入卸货计划的箱体排在最后
 */
export function loadingOrder(cases, unloadSequence = {}) {
  return [...cases]
    .map((item) => ({ caseId: item.caseId, unload: unloadSequence[item.caseId] ?? Infinity }))
    .sort((a, b) => {
      if (a.unload !== b.unload) return b.unload - a.unload; // 卸货序号大 → 先装
      return a.caseId.localeCompare(b.caseId);
    })
    .map((entry, index) => ({ caseId: entry.caseId, loadingSlot: index + 1 }));
}

/**
 * 将箱体按装车顺序贪心装入第一个载重/容积/危险品都满足的舱位。
 * 返回 { assignments, reasons }；reasons 非空表示整单不可装载。
 */
export function assignCompartments(cases, compartments, unloadSequence = {}) {
  const reasons = [];
  const order = loadingOrder(cases, unloadSequence);
  const orderIndex = new Map(order.map((entry) => [entry.caseId, entry.loadingSlot]));
  const loads = new Map(compartments.map((c) => [c.compartmentId, []]));

  for (const entry of order) {
    const item = cases.find((c) => c.caseId === entry.caseId);
    let placed = false;
    const tried = [];
    for (const compartment of compartments) {
      const inside = loads.get(compartment.compartmentId);
      const usedWeight = inside.reduce((sum, x) => sum + x.weightKg, 0);
      const usedVolume = inside.reduce(
        (sum, x) => sum + x.lengthCm * x.widthCm * x.heightCm,
        0,
      );
      const fitReasons = checkCompartmentFit(item, {
        ...compartment,
        payloadKg: compartment.payloadKg - usedWeight,
      });
      const volumeLeft =
        compartment.lengthCm * compartment.widthCm * compartment.heightCm - usedVolume;
      if (item.lengthCm * item.widthCm * item.heightCm > volumeLeft) {
        fitReasons.push(`舱位 ${compartment.compartmentId} 剩余容积不足`);
      }
      const hazardClash = inside.find((x) => INCOMPATIBLE_HAZARDS[item.hazard]?.has(x.hazard));
      if (hazardClash) {
        fitReasons.push(
          `危险品相斥: ${item.caseId}(${hazardLabel(item.hazard)}) 不能与已在舱位 ${compartment.compartmentId} 的 ${hazardClash.caseId}(${hazardLabel(hazardClash.hazard)}) 同舱`,
        );
      }
      if (fitReasons.length === 0) {
        inside.push(item);
        placed = true;
        break;
      }
      tried.push(`${compartment.compartmentId}（${fitReasons.join("；")}）`);
    }
    if (!placed) {
      reasons.push(
        `装载失败: 箱体 ${item.caseId} 在所有 ${compartments.length} 个舱位均不适配 — ${tried.join("；")}`,
      );
    }
  }

  const assignments = [];
  for (const compartment of compartments) {
    for (const item of loads.get(compartment.compartmentId)) {
      assignments.push({
        caseId: item.caseId,
        compartmentId: compartment.compartmentId,
        loadingSlot: orderIndex.get(item.caseId),
      });
    }
  }
  assignments.sort((a, b) => a.loadingSlot - b.loadingSlot);
  return { assignments, reasons };
}

function round(value) {
  return Math.round(value * 10) / 10;
}
