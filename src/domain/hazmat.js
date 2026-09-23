// 危险品类别与同舱相斥规则。灯具箱常见锂电池，易燃品（喷漆、酒精）与多类相斥。
export const HAZMAT_CLASSES = ["none", "battery_lithium", "flammable", "compressed_gas", "oxidizer"];

const INCOMPATIBLE_PAIRS = [
  ["flammable", "compressed_gas"],
  ["flammable", "oxidizer"],
  ["flammable", "battery_lithium"],
  ["compressed_gas", "oxidizer"],
];

const INCOMPATIBLE = new Map();
for (const [a, b] of INCOMPATIBLE_PAIRS) {
  if (!INCOMPATIBLE.has(a)) INCOMPATIBLE.set(a, new Set());
  if (!INCOMPATIBLE.has(b)) INCOMPATIBLE.set(b, new Set());
  INCOMPATIBLE.get(a).add(b);
  INCOMPATIBLE.get(b).add(a);
}

export function hazmatConflict(classA, classB) {
  if (!classA || !classB || classA === "none" || classB === "none") return false;
  if (classA === classB) return false;
  return INCOMPATIBLE.get(classA)?.has(classB) ?? false;
}
