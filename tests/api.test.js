import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), "logistics-api-"));
  const server = await createApp({ dataDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const jsonBody = await response.json();
    return { status: response.status, body: jsonBody };
  };
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await server.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  };
  return { call, close, dataDir };
}

const cases = JSON.parse(await readFile(new URL("../reference/seed-cases.json", import.meta.url), "utf8")).cases;
const fleet = JSON.parse(await readFile(new URL("../reference/seed-fleet.json", import.meta.url), "utf8")).fleet;
const tour = JSON.parse(await readFile(new URL("../reference/seed-tour.json", import.meta.url), "utf8"));

test("端到端：登记→规划→两段封舱→交接→离线扫码合并→签收→追踪", async () => {
  const app = await harness();
  const { call, close } = app;
  try {
    const registered = await call("POST", "/v1/cases", { cases });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.total, 10);

    const plan = await call("POST", "/v1/plans", {
      planId: tour.planId,
      cities: tour.cities,
      caseIds: cases.map((c) => c.caseId),
      fleet,
    });
    assert.equal(plan.status, 201, JSON.stringify(plan.body));
    assert.equal(plan.body.legs.length, 2);
    assert.equal(plan.body.legs[0].vehicleId, "truck-A");

    // 上海→西安封舱
    const leg1 = plan.body.legs[0].legId;
    const seals1 = plan.body.legs[0].assignments.map((a, i) => ({
      caseId: a.caseId,
      seal: `S-7008${String(11 + i).padStart(2, "0")}`,
    }));
    const manifest1 = await call("POST", "/v1/manifests", {
      planId: plan.body.planId,
      legId: leg1,
      seals: seals1,
      sealedBy: "crew-wu",
    });
    assert.equal(manifest1.status, 201);
    assert.equal(manifest1.body.summary.caseCount, 10);

    // 开始上海→西安交接
    const handover1 = await call("POST", "/v1/handovers", {
      legId: leg1,
      fromParty: "stage-shanghai",
      toParty: "carrier-dafa",
      dueAt: "2026-09-25T18:00:00+08:00",
    });
    assert.equal(handover1.status, 201);

    // 离线扫码批量恢复（样例文件格式）
    const scanSample = JSON.parse(
      await readFile(new URL("../reference/scan-sample.json", import.meta.url), "utf8"),
    );
    // 样例封签号与本次清单不同，仅验证设备幂等：改用清单封签号
    scanSample.scans = scanSample.scans.map((scan, i) => ({
      ...scan,
      seal: seals1.find((s) => s.caseId === scan.caseId)?.seal ?? scan.seal,
      seq: i + 1,
    }));
    scanSample.handoverId = handover1.body.handoverId;
    const ingest = await call("POST", "/v1/scans/batch", scanSample);
    assert.equal(ingest.status, 202);
    assert.deepEqual(ingest.body.accepted.length, 10);

    // 重复批次：幂等
    const ingestAgain = await call("POST", "/v1/scans/batch", scanSample);
    assert.equal(ingestAgain.status, 202);
    assert.deepEqual(ingestAgain.body.duplicates.length, 10);

    const complete1 = await call("POST", `/v1/handovers/${handover1.body.handoverId}/complete`, {
      receivedBy: "driver-zhang",
    });
    assert.equal(complete1.status, 200, JSON.stringify(complete1.body));
    assert.equal(complete1.body.status, "completed");

    // 器材主管扫码查箱：责任人、封签链、缺件状态
    const tracked = await call("GET", "/v1/cases/light-002");
    assert.equal(tracked.status, 200);
    assert.equal(tracked.body.currentResponsible.party, "carrier-dafa");
    assert.equal(tracked.body.sealChain.length, 1);
    assert.equal(tracked.body.shortage.missing, false);
    assert.ok(tracked.body.lastScans.some((s) => s.deviceId === "PDA-SH-07"));

    // 西安→成都段封舱（换一批新封签）
    const leg2 = plan.body.legs[1].legId;
    const seals2 = plan.body.legs[1].assignments.map((a, i) => ({
      caseId: a.caseId,
      seal: `S-7009${String(11 + i).padStart(2, "0")}`,
    }));
    const manifest2 = await call("POST", "/v1/manifests", {
      planId: plan.body.planId,
      legId: leg2,
      seals: seals2,
      sealedBy: "crew-li",
    });
    assert.equal(manifest2.status, 201);
    assert.match(manifest2.body.manifestId, /-V1$/);

    const tracked2 = await call("GET", "/v1/cases/light-002");
    assert.equal(tracked2.body.sealChain.length, 2);
  } finally {
    await close();
  }
});

test("不可行规划返回 422 与具体原因；请求体错误返回 400；未知路径 404", async () => {
  const app = await harness();
  const { call, close } = app;
  try {
    await call("POST", "/v1/cases", { cases });
    const bad = await call("POST", "/v1/plans", {
      planId: "infeasible",
      cities: tour.cities,
      caseIds: cases.map((c) => c.caseId),
      fleet: [
        {
          vehicleId: "mini",
          durationMinutes: 200,
          compartments: [
            { compartmentId: "tiny", lengthCm: 100, widthCm: 100, heightCm: 100, payloadKg: 100, hazardCapable: false },
          ],
        },
      ],
    });
    assert.equal(bad.status, 422);
    assert.ok(Array.isArray(bad.body.reasons));
    assert.ok(bad.body.reasons.join().length > 20, "原因必须具体");

    const invalid = await call("POST", "/v1/plans", { cities: tour.cities });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.reasons.join(), /caseIds/);

    const missing = await call("GET", "/v1/cases/no-such-case");
    assert.equal(missing.status, 404);

    const unknown = await call("GET", "/v1/nothing");
    assert.equal(unknown.status, 404);
  } finally {
    await close();
  }
});

test("非 JSON 请求体返回 400", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "logistics-api-raw-"));
  const server = await createApp({ dataDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/cases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.reasons.join(), /JSON/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await server.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});
