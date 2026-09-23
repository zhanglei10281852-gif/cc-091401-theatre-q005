import { createServer } from "node:http";
import { EventStore } from "./storage/eventstore.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  createLogisticsService,
} from "./service.js";

/**
 * @param {object} [options]
 * @param {string} [options.dataDir] 事件日志目录（默认 .runtime，可用 LOGISTICS_DATA_DIR 覆盖）
 * @param {() => Date} [options.clock]
 */
export async function createApp(options = {}) {
  const dataDir =
    options.dataDir ?? process.env.LOGISTICS_DATA_DIR ?? ".runtime";
  const store = new EventStore(`${dataDir}/events.jsonl`);
  await store.open();
  const service = createLogisticsService(store, options.clock ?? (() => new Date()));
  await service.load();

  const server = createServer(async (request, response) => {
    try {
      await route(request, response, service);
    } catch (error) {
      sendError(response, error);
    }
  });

  // 进程退出时尽量落盘；容器场景 SIGTERM
  const shutdown = async () => {
    server.close();
    await store.close();
  };
  server.on("close", () => {});
  server.shutdown = shutdown;
  return server;
}

async function route(request, response, service) {
  const url = new URL(request.url, "http://localhost");
  const { pathname } = url;
  const method = request.method;

  if (method === "GET" && pathname === "/health") {
    return json(response, 200, { status: "ok", service: "touring-logistics" });
  }

  // /v1/cases
  if (method === "POST" && pathname === "/v1/cases") {
    const body = await readJson(request);
    return json(response, 201, await service.registerCases(body.cases));
  }
  if (method === "GET" && /^\/v1\/cases\/[^/]+$/.test(pathname)) {
    const caseId = decodeURIComponent(pathname.split("/").pop());
    return json(response, 200, service.trackCase(caseId));
  }

  // 规划
  if (method === "POST" && pathname === "/v1/plans") {
    const body = await readJson(request);
    return json(response, 201, await service.createPlan(body));
  }
  if (method === "GET" && /^\/v1\/plans\/[^/]+$/.test(pathname)) {
    const planId = decodeURIComponent(pathname.split("/").pop());
    return json(response, 200, service.getPlan(planId));
  }

  // 封舱清单
  if (method === "POST" && pathname === "/v1/manifests") {
    const body = await readJson(request);
    return json(response, 201, await service.sealManifest(body));
  }
  if (method === "GET" && /^\/v1\/manifests\/[^/]+$/.test(pathname)) {
    const manifestId = decodeURIComponent(pathname.split("/").pop());
    return json(response, 200, service.getManifest(manifestId));
  }
  const legManifests = pathname.match(/^\/v1\/legs\/([^/]+)\/manifests$/);
  if (method === "GET" && legManifests) {
    const legId = decodeURIComponent(legManifests[1]);
    return json(response, 200, { legId, versions: service.listManifestVersions(legId) });
  }

  // 交接
  if (method === "POST" && pathname === "/v1/handovers") {
    const body = await readJson(request);
    return json(response, 201, await service.startHandover(body));
  }
  if (method === "POST" && /^\/v1\/handovers\/[^/]+\/complete$/.test(pathname)) {
    const handoverId = decodeURIComponent(pathname.split("/")[3]);
    const body = await readJson(request);
    return json(response, 200, await service.completeHandover({ handoverId, ...body }));
  }

  // 离线扫码
  if (method === "POST" && pathname === "/v1/scans/batch") {
    const body = await readJson(request);
    return json(response, 202, await service.ingestScans(body));
  }

  // 例外
  if (method === "POST" && pathname === "/v1/exceptions") {
    const body = await readJson(request);
    return json(response, 201, await service.addException(body));
  }
  if (method === "POST" && /^\/v1\/exceptions\/[^/]+\/release$/.test(pathname)) {
    const exceptionId = decodeURIComponent(pathname.split("/")[3]);
    const body = await readJson(request);
    return json(response, 200, await service.releaseException({ exceptionId, ...body }));
  }

  // 告警
  if (method === "GET" && pathname === "/v1/alerts") {
    return json(response, 200, service.alerts());
  }

  return json(response, 404, { error: "not_found", path: pathname });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError("请求体不是合法 JSON");
  }
}

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendError(response, error) {
  if (error instanceof ValidationError) {
    return json(response, 400, { error: error.code, reasons: error.reasons });
  }
  if (error instanceof NotFoundError) {
    return json(response, 404, { error: "not_found", message: error.message });
  }
  if (error instanceof ConflictError) {
    const status = error.code === "plan_infeasible" ? 422 : 409;
    return json(response, status, { error: error.code, reasons: error.reasons });
  }
  console.error(error);
  return json(response, 500, { error: "internal", message: error.message });
}
