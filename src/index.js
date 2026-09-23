import { createApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";

const server = await createApp();
server.listen(port, host, () => console.log(`巡演物流服务已启动: http://${host}:${port}`));

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    await server.shutdown();
    process.exit(0);
  });
}
