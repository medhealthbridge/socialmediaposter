export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
