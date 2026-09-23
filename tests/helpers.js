import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/storage/eventstore.js";
import { createLogisticsService } from "../src/service.js";

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

/** 基于临时事件文件创建服务；返回 dir 可在"重启"后重放 */
export async function makeService(clock) {
  const dir = await mkdtemp(join(tmpdir(), "logistics-"));
  const store = new EventStore(join(dir, "events.jsonl"));
  await store.open();
  const service = createLogisticsService(store, clock ?? (() => new Date()));
  await service.load();
  return { service, store, dir };
}

/** 从同一目录重放（模拟重启） */
export async function reopenService(dir, clock) {
  const store = new EventStore(join(dir, "events.jsonl"));
  await store.open();
  const service = createLogisticsService(store, clock ?? (() => new Date()));
  await service.load();
  return { service, store };
}

export async function loadSeed() {
  const casesFile = await readJson("../reference/seed-cases.json");
  const fleetFile = await readJson("../reference/seed-fleet.json");
  const tour = await readJson("../reference/seed-tour.json");
  return { cases: casesFile.cases, fleet: fleetFile.fleet, tour };
}

/** 上海→西安→成都全链路播种（登记 + 规划） */
export async function seedTour(service, overrides = {}) {
  const seed = await loadSeed();
  const cases = overrides.cases ?? seed.cases;
  const fleet = overrides.fleet ?? seed.fleet;
  await service.registerCases(cases);
  const plan = await service.createPlan({
    planId: overrides.planId ?? seed.tour.planId,
    cities: overrides.cities ?? seed.tour.cities,
    caseIds: overrides.caseIds ?? cases.map((c) => c.caseId),
    fleet,
    unloadSequenceByLeg: overrides.unloadSequenceByLeg,
  });
  return { cases, fleet, cities: seed.tour.cities, plan };
}

/** 按封舱清单条目生成 seals 入参 */
export function sealsFor(manifest, start = 700900) {
  let next = start;
  return manifest.entries.map((entry) => ({
    caseId: entry.caseId,
    seal: `S-${next++}`,
  }));
}
