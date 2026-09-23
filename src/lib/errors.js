export class DomainError extends Error {
  constructor(code, message, { status = 409, reasons = [] } = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
    this.reasons = reasons;
  }
}

export function conflict(code, message, reasons = []) {
  return new DomainError(code, message, { status: 409, reasons });
}

export function notFound(message) {
  return new DomainError("not_found", message, { status: 404 });
}

export function badRequest(message, reasons = []) {
  return new DomainError("bad_request", message, { status: 400, reasons });
}
