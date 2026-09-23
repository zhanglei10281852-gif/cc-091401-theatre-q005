import { createHash } from "node:crypto";

/** 转成带偏移量的 ISO 8601 字符串 */
export function iso(value) {
  if (value instanceof Date) return value.toISOString();
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new TypeError(`无效的时间值: ${String(value)}`);
  }
  return new Date(ms).toISOString();
}

export function parseTime(value, field = "time") {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new TypeError(`字段 ${field} 不是有效的 ISO 8601 时间: ${String(value)}`);
  }
  return ms;
}

export function minutesBetween(later, earlier) {
  return (parseTime(later) - parseTime(earlier)) / 60000;
}

/** 键按字典序递归排序后的 JSON 文本，用作摘要输入 */
export function canonicalize(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function digest(value) {
  return sha256(canonicalize(value));
}
