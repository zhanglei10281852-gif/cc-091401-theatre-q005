/**
 * 只追加事件存储（JSONL）。
 *
 * 所有状态变更以不可变事件落盘，重启后整体重放还原；历史交接与封舱清单
 * 在物理上就没有被覆盖的路径。写入串行化，每行一个 JSON 事件。
 */
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export class EventStore {
  #file;
  #stream;
  #chain = Promise.resolve();

  constructor(file) {
    this.#file = file;
  }

  async open() {
    await mkdir(dirname(this.#file), { recursive: true });
    this.#stream = createWriteStream(this.#file, { flags: "a" });
    await new Promise((resolve, reject) => {
      this.#stream.once("open", resolve);
      this.#stream.once("error", reject);
    });
  }

  /** 追加一条事件，等待写入操作系统缓冲后返回（服务重启前数据已在文件中） */
  append(type, payload) {
    const event = {
      eventId: randomUUID(),
      type,
      at: new Date().toISOString(),
      payload,
    };
    const task = this.#chain.then(async () => {
      await new Promise((resolve, reject) => {
        this.#stream.write(`${JSON.stringify(event)}\n`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    });
    // 串行链不因单次失败而断裂
    this.#chain = task.catch(() => {});
    return task.then(() => event);
  }

  async replay(handleEvent) {
    try {
      await access(this.#file);
    } catch {
      return { count: 0 };
    }
    const stream = createReadStream(this.#file);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let count = 0;
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new Error(`事件文件第 ${lineNumber} 行损坏: ${error.message}`);
      }
      await handleEvent(event);
      count += 1;
    }
    return { count };
  }

  /** 归档当前日志（轮转后旧文件保留，不删除、不修改） */
  async rotate(suffix = new Date().toISOString().replace(/[:.]/g, "-")) {
    await this.close();
    await rename(this.#file, `${this.#file}.${suffix}`);
    await this.open();
  }

  async close() {
    if (!this.#stream) return;
    await new Promise((resolve, reject) => {
      this.#stream.end((error) => (error ? reject(error) : resolve()));
    });
    this.#stream = null;
  }
}
