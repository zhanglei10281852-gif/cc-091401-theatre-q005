import { createApp } from "./app.js";
import { Store } from "./store.js";
import { sweepReminders } from "./domain/handovers.js";
import { nowIso } from "./lib/time.js";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";
const dataFile = process.env.DATA_FILE ?? ".data/events.jsonl";

// 启动时重放事件日志，恢复未完成的交接与超时提醒状态
const store = Store.open(dataFile);
const server = createApp(store);
server.listen(port, host, () => console.log("巡演物流服务已启动"));

// 周期性扫描超时交接；提醒触发记录同样落盘，重启后不会重复也不会丢失
const sweeper = setInterval(() => sweepReminders(store, nowIso()), 30_000);
sweeper.unref();
