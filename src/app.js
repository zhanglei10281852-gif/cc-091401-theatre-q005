import { createServer } from "node:http";
import { DomainError, badRequest, notFound } from "./lib/errors.js";
import { nowIso } from "./lib/time.js";
import { createTour, registerCase, registerVehicle } from "./domain/registration.js";
import { planTour } from "./domain/planning.js";
import { getManifest, sealManifest } from "./domain/manifest.js";
import { syncScans } from "./domain/scans.js";
import { appendException } from "./domain/exceptions.js";
import { confirmHandover, createHandover, listPendingHandovers, sweepReminders } from "./domain/handovers.js";
import { confirmUnloadingSlot } from "./domain/slots.js";
import { trackCase } from "./domain/tracking.js";

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw badRequest("请求体过大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw badRequest("请求体必须是合法 JSON");
  }
}

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

// 路由表：method + 路径模板 → 处理器，返回 {status, payload}
const routes = [
  ["GET", "/health", () => ({ status: 200, payload: { status: "ok", service: "touring-logistics" } })],
  ["POST", "/vehicles", ({ store, body }) => ({ status: 201, payload: { vehicle: registerVehicle(store, body) } })],
  ["POST", "/tours", ({ store, body }) => ({ status: 201, payload: { tour: createTour(store, body) } })],
  ["POST", "/cases", ({ store, body }) => ({ status: 201, payload: { caseItem: registerCase(store, body) } })],
  ["POST", "/tours/:tourId/plan", ({ store, params, body }) => ({ status: 201, payload: { plan: planTour(store, params.tourId, body, body.at ?? nowIso()) } })],
  ["POST", "/tours/:tourId/replan", ({ store, params, body }) => ({ status: 201, payload: { plan: planTour(store, params.tourId, body, body.at ?? nowIso()) } })],
  [
    "GET",
    "/tours/:tourId/plan",
    ({ store, params }) => {
      const plan = store.state.plans.get(params.tourId);
      if (!plan) throw notFound(`巡演 ${params.tourId} 的装载计划不存在`);
      return { status: 200, payload: { plan } };
    },
  ],
  ["POST", "/legs/:legId/manifest/seal", ({ store, params, body }) => ({ status: 201, payload: sealManifest(store, params.legId, body) })],
  ["GET", "/legs/:legId/manifest", ({ store, params }) => ({ status: 200, payload: { manifest: getManifest(store, params.legId) } })],
  ["POST", "/scans/sync", ({ store, body }) => ({ status: 200, payload: syncScans(store, body) })],
  ["POST", "/exceptions", ({ store, body }) => ({ status: 201, payload: appendException(store, body) })],
  ["GET", "/exceptions", ({ store }) => ({ status: 200, payload: { exceptions: store.state.exceptions } })],
  ["POST", "/handovers", ({ store, body }) => ({ status: 201, payload: { handover: createHandover(store, body) } })],
  ["GET", "/handovers/pending", ({ store, query }) => ({ status: 200, payload: { handovers: listPendingHandovers(store, query.get("now") ?? nowIso()) } })],
  ["POST", "/handovers/:handoverId/confirm", ({ store, params, body }) => ({ status: 200, payload: confirmHandover(store, params.handoverId, body) })],
  [
    "GET",
    "/reminders",
    ({ store, query }) => {
      sweepReminders(store, query.get("now") ?? nowIso());
      return { status: 200, payload: { reminders: [...store.state.reminders.values()] } };
    },
  ],
  ["POST", "/stations/:city/unloading-slots/confirm", ({ store, params, body }) => ({ status: 201, payload: confirmUnloadingSlot(store, params.city, body) })],
  ["GET", "/cases/:caseId/tracking", ({ store, params }) => ({ status: 200, payload: trackCase(store, params.caseId) })],
];

function matchRoute(method, pathname) {
  for (const [routeMethod, template, handler] of routes) {
    if (routeMethod !== method) continue;
    const templateParts = template.split("/").filter(Boolean);
    const pathParts = pathname.split("/").filter(Boolean);
    if (templateParts.length !== pathParts.length) continue;
    const params = {};
    let matched = true;
    for (let index = 0; index < templateParts.length; index++) {
      const part = templateParts[index];
      if (part.startsWith(":")) {
        params[part.slice(1)] = decodeURIComponent(pathParts[index]);
      } else if (part !== pathParts[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler, params };
  }
  return null;
}

export function createApp(store) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const matched = matchRoute(request.method, url.pathname);
      if (!matched) throw notFound("接口不存在");
      const body = request.method === "POST" || request.method === "PUT" ? await readJson(request) : {};
      const { status, payload } = await matched.handler({ store, body, params: matched.params, query: url.searchParams });
      send(response, status, payload);
    } catch (error) {
      if (error instanceof DomainError) {
        send(response, error.status, { error: { code: error.code, message: error.message, reasons: error.reasons } });
      } else {
        console.error(error);
        send(response, 500, { error: { code: "internal", message: "服务器内部错误" } });
      }
    }
  });
}
