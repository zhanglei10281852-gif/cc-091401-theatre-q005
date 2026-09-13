import { createApp } from "./app.js";
const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";
createApp().listen(port, host, () => console.log("巡演物流服务已启动"));
