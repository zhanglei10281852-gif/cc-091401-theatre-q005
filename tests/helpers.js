import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";

export function tempDataFile() {
  return join(mkdtempSync(join(tmpdir(), "touring-")), "events.jsonl");
}

export async function startServer(dataFile = ":memory:") {
  const store = Store.open(dataFile);
  const server = createApp(store);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    store,
    base,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function api(base, method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

// 场景：上海 → 成都 → 西安；第一段车 A，第二段车 B（成都换车）
export const STOPS = [
  { city: "上海", departWindow: { start: "2026-09-24T08:00:00+08:00", end: "2026-09-24T12:00:00+08:00" } },
  {
    city: "成都",
    arriveWindow: { start: "2026-09-25T09:00:00+08:00", end: "2026-09-25T18:00:00+08:00" },
    departWindow: { start: "2026-09-26T08:00:00+08:00", end: "2026-09-26T12:00:00+08:00" },
  },
  { city: "西安", arriveWindow: { start: "2026-09-27T09:00:00+08:00", end: "2026-09-27T20:00:00+08:00" } },
];

export const LEGS = [
  { id: "leg-1", vehicleId: "veh-a" },
  { id: "leg-2", vehicleId: "veh-b" },
];

export const VEHICLE_A = {
  id: "veh-a",
  compartments: [
    { id: "A1", maxWeightKg: 500, maxVolumeL: 3000 },
    { id: "A2", maxWeightKg: 300, maxVolumeL: 1500 },
  ],
};

export const VEHICLE_B = { id: "veh-b", compartments: [{ id: "B1", maxWeightKg: 600, maxVolumeL: 4000 }] };

export const CASES = [
  {
    id: "prop-018",
    tourId: "tour-1",
    kind: "prop",
    dimsCm: { l: 120, w: 80, h: 100 },
    weightKg: 100,
    route: { origin: "上海", destination: "成都" },
    contents: [
      { itemId: "sword-1", name: "道具剑" },
      { itemId: "shield-2", name: "道具盾" },
    ],
  },
  {
    id: "costume-003",
    tourId: "tour-1",
    kind: "costume",
    dimsCm: { l: 100, w: 60, h: 80 },
    weightKg: 60,
    route: { origin: "上海", destination: "成都" },
    contents: [{ itemId: "robe-1", name: "长袍" }],
  },
  {
    id: "lamp-002",
    tourId: "tour-1",
    kind: "lighting",
    dimsCm: { l: 80, w: 60, h: 60 },
    weightKg: 40,
    fragile: true,
    hazmatClass: "battery_lithium",
    route: { origin: "上海", destination: "西安" },
    contents: [{ itemId: "lens-1", name: "透镜组" }],
  },
];

export async function seedTour(base, { cases = CASES, stops = STOPS, legs = LEGS } = {}) {
  await api(base, "POST", "/vehicles", VEHICLE_A);
  await api(base, "POST", "/vehicles", VEHICLE_B);
  const tour = await api(base, "POST", "/tours", { id: "tour-1", name: "秋季巡演", stops, legs });
  for (const caseItem of cases) {
    await api(base, "POST", "/cases", caseItem);
  }
  return tour;
}
