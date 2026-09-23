import { badRequest } from "./errors.js";

export function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${label} 必须是对象`);
  }
  return value;
}

export function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`字段 ${field} 必须是非空字符串`);
  }
  return value.trim();
}

export function requireNumber(value, field, { min = 0, exclusiveMin = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw badRequest(`字段 ${field} 必须是数字`);
  }
  if (exclusiveMin ? value <= min : value < min) {
    throw badRequest(`字段 ${field} 必须大于${exclusiveMin ? "" : "等于"} ${min}`);
  }
  return value;
}

export function requireInteger(value, field, { min = 0 } = {}) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw badRequest(`字段 ${field} 必须是整数`);
  }
  if (value < min) {
    throw badRequest(`字段 ${field} 不能小于 ${min}`);
  }
  return value;
}

export function requireStringArray(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw badRequest(`字段 ${field} 必须是非空字符串数组`);
  }
  return value;
}
