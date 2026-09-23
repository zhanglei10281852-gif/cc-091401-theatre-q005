import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// 事件溯源存储：所有变更以追加方式写入 JSONL 日志，重启后按序重放恢复状态。
// 历史交接、封舱清单、例外因此天然不可被覆盖。

function freshState() {
  return {
    tours: new Map(), // tourId → {id, name, stops, legs}
    vehicles: new Map(), // vehicleId → {id, compartments}
    cases: new Map(), // caseId → 箱体
    plans: new Map(), // tourId → 当前装载计划
    manifests: new Map(), // legId → 已固化封舱清单
    scans: new Map(), // "deviceId:deviceSeq" → 扫码记录（幂等键）
    sealEvents: [], // 封签链事件 {caseId, sealId, action, at, by, source}
    exceptions: [], // 例外（破封/暂扣/换箱/拆分/缺箱/封签不符），只追加
    handovers: new Map(), // handoverId → 交接
    slots: new Map(), // "city:slotId" → 已确认卸货位
    reminders: new Map(), // handoverId → 已触发的超时提醒
    custody: new Map(), // caseId → {party, at, source} 当前责任人
    itemChecks: new Map(), // caseId → 最近一次清点 {foundItemIds, at, deviceId}
    eventCount: 0,
  };
}

const reducers = {
  tour_created(state, event) {
    state.tours.set(event.tour.id, event.tour);
  },
  tour_updated(state, event) {
    const tour = state.tours.get(event.tourId);
    if (tour) {
      tour.stops = event.stops;
      tour.legs = event.legs;
    }
  },
  vehicle_registered(state, event) {
    state.vehicles.set(event.vehicle.id, event.vehicle);
  },
  case_registered(state, event) {
    state.cases.set(event.caseItem.id, event.caseItem);
  },
  plan_created(state, event) {
    state.plans.set(event.plan.tourId, event.plan);
  },
  manifest_sealed(state, event) {
    const manifest = event.manifest;
    state.manifests.set(manifest.legId, manifest);
    for (const entry of manifest.entries) {
      state.sealEvents.push({
        caseId: entry.caseId,
        sealId: entry.sealId,
        action: "apply",
        at: manifest.sealedAt,
        by: manifest.sealedBy,
        source: "manifest",
      });
    }
  },
  scan_recorded(state, event) {
    const scan = event.scan;
    state.scans.set(`${scan.deviceId}:${scan.deviceSeq}`, scan);
    if (scan.action === "custody" && scan.party) {
      state.custody.set(scan.caseId, { party: scan.party, at: scan.at, source: "scan" });
    }
    if (scan.action === "item_check") {
      state.itemChecks.set(scan.caseId, { foundItemIds: scan.foundItemIds, at: scan.at, deviceId: scan.deviceId });
    }
    if (scan.action === "verify_seal" || scan.action === "break_seal") {
      state.sealEvents.push({
        caseId: scan.caseId,
        sealId: scan.sealId,
        action: scan.action === "verify_seal" ? "verify" : "break",
        at: scan.at,
        by: scan.actor ?? scan.deviceId,
        source: "scan",
      });
    }
  },
  exception_appended(state, event) {
    const exception = event.exception;
    state.exceptions.push(exception);
    const details = exception.details ?? {};
    // 换箱/拆分：新箱随例外事件注册，重放时保持一致
    const born = [];
    if (exception.type === "rebox" && details.newCase) born.push({ caseItem: details.newCase, sealId: details.newSealId ?? null });
    if (exception.type === "split" && Array.isArray(details.newCases)) {
      for (const nc of details.newCases) born.push({ caseItem: nc, sealId: nc.sealId ?? null });
    }
    for (const { caseItem, sealId } of born) {
      state.cases.set(caseItem.id, caseItem);
      if (sealId) {
        state.sealEvents.push({
          caseId: caseItem.id,
          sealId,
          action: "apply",
          at: exception.at,
          by: exception.actor,
          source: exception.type,
        });
      }
    }
  },
  handover_created(state, event) {
    state.handovers.set(event.handover.id, event.handover);
  },
  handover_confirmed(state, event) {
    const handover = state.handovers.get(event.handoverId);
    if (handover) {
      handover.status = "confirmed";
      handover.confirmedAt = event.confirmedAt;
      handover.confirmedBy = event.actor;
      handover.receivedCaseIds = event.receivedCaseIds;
      handover.discrepancies = event.discrepancies;
      for (const caseId of event.receivedCaseIds) {
        state.custody.set(caseId, { party: handover.toParty, at: event.confirmedAt, source: "handover", handoverId: event.handoverId });
      }
    }
  },
  slot_confirmed(state, event) {
    state.slots.set(`${event.slot.city}:${event.slot.slotId}`, event.slot);
  },
  slot_released(state, event) {
    state.slots.delete(`${event.city}:${event.slotId}`);
  },
  reminder_fired(state, event) {
    state.reminders.set(event.reminder.handoverId, event.reminder);
  },
};

export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = freshState();
    if (filePath !== ":memory:") {
      mkdirSync(dirname(filePath), { recursive: true });
    }
  }

  static open(filePath) {
    const store = new Store(filePath);
    if (filePath !== ":memory:" && existsSync(filePath)) {
      for (const line of readFileSync(filePath, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (trimmed) store.apply(JSON.parse(trimmed));
      }
    }
    return store;
  }

  // 追加事件：先落盘再应用，保证重启后状态连续
  record(event) {
    const stamped = { ...event, seq: this.state.eventCount + 1 };
    if (this.filePath !== ":memory:") {
      appendFileSync(this.filePath, JSON.stringify(stamped) + "\n");
    }
    this.apply(stamped);
    return stamped;
  }

  apply(event) {
    const reducer = reducers[event.type];
    if (reducer) reducer(this.state, event);
    this.state.eventCount += 1;
  }
}
