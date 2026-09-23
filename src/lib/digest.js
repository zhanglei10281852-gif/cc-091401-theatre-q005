import { createHash } from "node:crypto";

// 规范化序列化：对象键排序，保证同一内容得到同一摘要
export function canonicalize(value) {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalize(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function manifestDigest(payload) {
  return createHash("sha256").update(canonicalize(payload)).digest("hex");
}
