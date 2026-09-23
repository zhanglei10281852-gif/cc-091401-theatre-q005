import { badRequest } from "./errors.js";

// 领域约定：时间字段必须是带偏移量的 ISO 8601 字符串
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;

export function parseIso(value, field) {
  if (typeof value !== "string" || !ISO_WITH_OFFSET.test(value)) {
    throw badRequest(`字段 ${field} 必须是带偏移量的 ISO 8601 时间（如 2026-09-25T09:00:00+08:00）`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw badRequest(`字段 ${field} 不是有效时间`);
  }
  return ms;
}

export function parseWindow(value, field) {
  if (!value || typeof value !== "object") {
    throw badRequest(`字段 ${field} 必须是 {start, end} 对象`);
  }
  const startMs = parseIso(value.start, `${field}.start`);
  const endMs = parseIso(value.end, `${field}.end`);
  if (endMs < startMs) {
    throw badRequest(`字段 ${field} 的结束时间早于开始时间`);
  }
  return { startMs, endMs };
}

export function nowIso() {
  return new Date().toISOString();
}
