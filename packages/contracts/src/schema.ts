// Small closed-schema checks for data that crosses a trust boundary: commands
// from people and decisions from models. Unknown fields are always rejected.

export class ParseError extends Error {}

export type Check = (v: unknown, path: string) => void;

export const fail = (path: string, message: string): never => {
  throw new ParseError(`${path}: ${message}`);
};

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const MAX_TEXT = 20_000;

export const str: Check = (v, path) => {
  if (typeof v !== "string" || v.trim().length === 0) fail(path, "must be a non-empty string");
  else if (v.length > MAX_TEXT) fail(path, "is too long");
};
export const text: Check = (v, path) => {
  if (typeof v !== "string") fail(path, "must be a string");
  else if (v.length > MAX_TEXT) fail(path, "is too long");
};
export const int =
  (min: number): Check =>
  (v, path) => {
    if (!Number.isSafeInteger(v) || (v as number) < min)
      fail(path, `must be an integer >= ${String(min)}`);
  };
export const num: Check = (v, path) => {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(path, "must be a finite number");
};
export const bool: Check = (v, path) => {
  if (typeof v !== "boolean") fail(path, "must be a boolean");
};
export const oneOf =
  (...values: string[]): Check =>
  (v, path) => {
    if (typeof v !== "string" || !values.includes(v))
      fail(path, `must be one of ${values.join(", ")}`);
  };
export const any: Check = () => undefined;

export function shape(
  required: Record<string, Check>,
  optional: Record<string, Check> = {},
): Check {
  return (v, path) => {
    if (!isObj(v)) return fail(path, "must be an object");
    for (const k of Object.keys(v)) {
      if (!Object.hasOwn(required, k) && !Object.hasOwn(optional, k))
        fail(`${path}.${k}`, "unknown field");
    }
    for (const [k, check] of Object.entries(required)) {
      if (!Object.hasOwn(v, k)) fail(`${path}.${k}`, "missing field");
      check(v[k], `${path}.${k}`);
    }
    for (const [k, check] of Object.entries(optional)) {
      if (Object.hasOwn(v, k) && v[k] !== undefined) check(v[k], `${path}.${k}`);
    }
  };
}

export const list =
  (item: Check, max: number): Check =>
  (v, path) => {
    if (!Array.isArray(v)) return fail(path, "must be an array");
    if (v.length > max) fail(path, `has more than ${String(max)} items`);
    v.forEach((x, i) => {
      item(x, `${path}[${String(i)}]`);
    });
  };

export const numbers: Check = (v, path) => {
  if (!isObj(v)) return fail(path, "must be an object");
  for (const [k, x] of Object.entries(v)) num(x, `${path}.${k}`);
};

export const pin = shape({ id: str, revision: int(1) });

export function check(
  validate: Check,
  input: unknown,
): { ok: true; value: unknown } | { ok: false; detail: string } {
  try {
    validate(input, "$");
    return { ok: true, value: structuredClone(input) };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, detail: e.message };
    return { ok: false, detail: "malformed input" };
  }
}
