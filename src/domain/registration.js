import { badRequest, conflict, notFound } from "../lib/errors.js";
import { requireNumber, requireObject, requireString } from "../lib/validate.js";
import { HAZMAT_CLASSES } from "./hazmat.js";
import { normalizeLegs, normalizeStops, validateWindows } from "./planning.js";

export function registerVehicle(store, body) {
  requireObject(body, "请求体");
  const id = requireString(body.id, "id");
  if (store.state.vehicles.has(id)) {
    throw conflict("vehicle_exists", `车辆 ${id} 已注册`, [{ code: "duplicate_vehicle", vehicleId: id }]);
  }
  if (!Array.isArray(body.compartments) || body.compartments.length === 0) {
    throw badRequest("车辆至少需要一个舱位 compartments");
  }
  const compartments = body.compartments.map((raw, index) => {
    requireObject(raw, `compartments[${index}]`);
    return {
      id: requireString(raw.id, `compartments[${index}].id`),
      maxWeightKg: requireNumber(raw.maxWeightKg, `compartments[${index}].maxWeightKg`, { exclusiveMin: true }),
      maxVolumeL: requireNumber(raw.maxVolumeL, `compartments[${index}].maxVolumeL`, { exclusiveMin: true }),
    };
  });
  const vehicle = { id, compartments };
  store.record({ type: "vehicle_registered", vehicle });
  return vehicle;
}

export function createTour(store, body) {
  requireObject(body, "请求体");
  const id = requireString(body.id, "id");
  if (store.state.tours.has(id)) {
    throw conflict("tour_exists", `巡演 ${id} 已存在`, [{ code: "duplicate_tour", tourId: id }]);
  }
  const stops = normalizeStops(body.stops);
  const legs = normalizeLegs(body.legs, stops);
  const windowReasons = validateWindows(stops);
  if (windowReasons.length > 0) {
    throw conflict("window_conflict", "到离站时间窗冲突", windowReasons);
  }
  const tour = { id, name: body.name ?? id, stops, legs };
  store.record({ type: "tour_created", tour });
  return tour;
}

export function registerCase(store, body) {
  requireObject(body, "请求体");
  const id = requireString(body.id, "id");
  if (store.state.cases.has(id)) {
    throw conflict("case_exists", `箱 ${id} 已注册`, [{ code: "duplicate_case", caseId: id }]);
  }
  const tourId = requireString(body.tourId, "tourId");
  if (!store.state.tours.has(tourId)) {
    throw notFound(`巡演 ${tourId} 不存在`);
  }
  requireObject(body.dimsCm, "dimsCm");
  const dimsCm = {
    l: requireNumber(body.dimsCm.l, "dimsCm.l", { exclusiveMin: true }),
    w: requireNumber(body.dimsCm.w, "dimsCm.w", { exclusiveMin: true }),
    h: requireNumber(body.dimsCm.h, "dimsCm.h", { exclusiveMin: true }),
  };
  const hazmatClass = body.hazmatClass ?? "none";
  if (!HAZMAT_CLASSES.includes(hazmatClass)) {
    throw badRequest(`危险品类别 hazmatClass 必须是 ${HAZMAT_CLASSES.join("/")} 之一`);
  }
  requireObject(body.route, "route");
  const route = { origin: requireString(body.route.origin, "route.origin"), destination: requireString(body.route.destination, "route.destination") };
  const contents = Array.isArray(body.contents)
    ? body.contents.map((item, index) => {
        requireObject(item, `contents[${index}]`);
        return { itemId: requireString(item.itemId, `contents[${index}].itemId`), name: item.name ?? item.itemId };
      })
    : [];
  const caseItem = {
    id,
    tourId,
    kind: requireString(body.kind, "kind"),
    dimsCm,
    weightKg: requireNumber(body.weightKg, "weightKg", { exclusiveMin: true }),
    fragile: body.fragile === true,
    hazmatClass,
    route,
    contents,
  };
  store.record({ type: "case_registered", caseItem });
  return caseItem;
}
