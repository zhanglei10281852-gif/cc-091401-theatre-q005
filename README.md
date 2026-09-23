# 巡演物流服务

追踪戏剧巡演的箱体、封签、装载和异地交接。

## 运行

需要 Node.js 22 或更高版本。运行 `npm ci` 后使用 `npm start` 启动服务，默认监听 8000 端口；`npm test` 执行本地测试。也可以使用 `docker compose up --build` 启动容器。

数据以追加式事件日志持久化在 `.data/events.jsonl`（可用环境变量 `DATA_FILE` 覆盖），重启后自动重放恢复：未完成的交接、已触发的超时提醒、已固化的封舱清单都保持连续。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/vehicles` | 注册车辆及舱位（载重 kg / 容积 L） |
| POST | `/tours` | 创建巡演：多城市到离站窗口 + 各段车辆 |
| POST | `/cases` | 注册箱体：尺寸、重量、危险品类别、路线、内容物 |
| POST | `/tours/:id/plan` | 生成装载与换车计划（超重/相斥/时间窗冲突返回具体原因） |
| POST | `/tours/:id/replan` | 重排；保护已固化清单与已确认卸货位，`releaseSlots` 可显式释放 |
| GET | `/tours/:id/plan` | 查看当前计划 |
| POST | `/legs/:legId/manifest/seal` | 封舱：固化清单并生成 SHA-256 摘要，不可覆盖 |
| GET | `/legs/:legId/manifest` | 查看已固化清单与摘要 |
| POST | `/scans/sync` | 离线扫码批量恢复，按设备序列幂等合并 |
| POST | `/exceptions` | 追加例外：破封/暂扣/换箱/拆分，返回后续影响评估 |
| GET | `/exceptions` | 例外流水 |
| POST | `/handovers` | 创建交接（含时限 dueAt、交接序号 sequence） |
| POST | `/handovers/:id/confirm` | 确认交接；缺箱与封条不符自动生成例外，历史交接不可覆盖 |
| GET | `/handovers/pending` | 未完成交接及超时状态 |
| GET | `/reminders` | 超时提醒（每交接只触发一次） |
| POST | `/stations/:city/unloading-slots/confirm` | 确认卸货位，确认后不被抢占 |
| GET | `/cases/:id/tracking` | 扫箱号追踪：当前责任人、封签链、缺件状态 |

冲突统一返回 `409` 与 `error.reasons` 数组，每条含 `code` 与中文 `detail` 说明（如 `overweight`、`incompatible_hazmat`、`window_conflict`、`manifest_immutable`、`slot_protected`、`handover_immutable`）。
