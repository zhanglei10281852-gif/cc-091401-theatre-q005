import assert from "node:assert/strict";
import test from "node:test";
import { api, seedTour, startServer } from "./helpers.js";

test("例外：暂扣只追加记录并评估后续影响", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  await seedTour(server.base);
  await api(server.base, "POST", "/tours/tour-1/plan", {});
  await api(server.base, "POST", "/handovers", {
    id: "HO-20", tourId: "tour-1", legId: "leg-1", city: "成都",
    fromParty: "车队A", toParty: "成都剧场", caseIds: ["prop-018"],
    dueAt: "2026-09-25T17:00:00+08:00",
  });

  const { status, body } = await api(server.base, "POST", "/exceptions", {
    type: "hold", caseId: "prop-018", actor: "安监", reason: "海关抽查暂扣",
    at: "2026-09-25T10:00:00+08:00",
  });
  assert.equal(status, 201);
  assert.equal(body.exception.type, "hold");
  // 影响评估：leg-1 已出发，关联交接被列出
  const leg1 = body.impact.affectedLegs.find((l) => l.legId === "leg-1");
  assert.equal(leg1.status, "already_departed");
  assert.deepEqual(body.impact.pendingHandovers.map((h) => h.handoverId), ["HO-20"]);

  const tracking = await api(server.base, "GET", "/cases/prop-018/tracking");
  assert.equal(tracking.body.status, "held");
});

test("例外：拆分校验内容物守恒，并评估后续舱位容量", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  await seedTour(server.base);
  await api(server.base, "POST", "/tours/tour-1/plan", {});

  // 内容物不守恒 → 拒绝
  const bad = await api(server.base, "POST", "/exceptions", {
    type: "split", caseId: "lamp-002", actor: "器材主管", reason: "灯具分装",
    at: "2026-09-25T10:00:00+08:00",
    details: { newCases: [{ id: "lamp-002a", contents: [] }, { id: "lamp-002b", contents: [] }] },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "bad_request");

  // 守恒但超重：两个新箱各 320kg，leg-2 舱位 B1 上限 600kg → 容量告警
  const split = await api(server.base, "POST", "/exceptions", {
    type: "split", caseId: "lamp-002", actor: "器材主管", reason: "灯具分装",
    at: "2026-09-25T10:00:00+08:00",
    details: {
      newCases: [
        { id: "lamp-002a", weightKg: 320, contents: [{ itemId: "lens-1", name: "透镜组" }], sealId: "S-700901" },
        { id: "lamp-002b", weightKg: 320, contents: [], sealId: "S-700902" },
      ],
    },
  });
  assert.equal(split.status, 201);
  const warning = split.body.impact.capacityWarnings.find((w) => w.code === "overweight_after_split");
  assert.ok(warning, "应包含拆分后超重告警");
  assert.equal(warning.legId, "leg-2");

  // 新箱已注册并可追踪，血缘链关联原箱
  const tracking = await api(server.base, "GET", "/cases/lamp-002a/tracking");
  assert.equal(tracking.status, 200);
  assert.ok(tracking.body.lineage.caseIds.includes("lamp-002"));
  assert.ok(tracking.body.sealChain.some((e) => e.sealId === "S-700901"));
});

test("例外：换箱后封签链跨箱延续", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  await seedTour(server.base);
  await api(server.base, "POST", "/tours/tour-1/plan", {});

  const rebox = await api(server.base, "POST", "/exceptions", {
    type: "rebox", caseId: "costume-003", actor: "服装师", reason: "原箱受潮换箱",
    at: "2026-09-25T10:00:00+08:00",
    details: { newCase: { id: "costume-003R" }, newSealId: "S-700950" },
  });
  assert.equal(rebox.status, 201);

  const tracking = await api(server.base, "GET", "/cases/costume-003R/tracking");
  assert.ok(tracking.body.lineage.caseIds.includes("costume-003"));
  assert.ok(tracking.body.sealChain.some((e) => e.sealId === "S-700950" && e.action === "apply"));
  // 新箱继承原箱内容物与路线
  assert.deepEqual(tracking.body.contents.expected.map((i) => i.itemId), ["robe-1"]);
  assert.equal(tracking.body.route.destination, "成都");
});
