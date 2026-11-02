// Closed grammar for executable claims. A model proposes a claim as JSON; this
// code decides whether it is well formed and inside the scientific contract.

export interface ParameterDomain {
  min: number;
  max: number;
  scale: "linear" | "log";
}

export interface Contract {
  version: string;
  models: Record<string, { params: string[] }>;
  domain: Record<string, ParameterDomain>;
  initialConditions: string[];
}

export type Point = Record<string, number>;
export interface Range {
  min: number;
  max: number;
}

export type PointClaim =
  | { kind: "OSCILLATES"; model: string; point: Point; ic: string }
  | { kind: "AGREE_ON_OSCILLATION"; reference: string; reduced: string; point: Point; ic: string }
  | {
      kind: "PERIOD_WITHIN";
      reference: string;
      reduced: string;
      point: Point;
      ic: string;
      tolerance: number;
    };

export type RegionBody =
  | { kind: "OSCILLATES"; model: string }
  | { kind: "AGREE_ON_OSCILLATION"; reference: string; reduced: string }
  | { kind: "AGREE_AND_PERIOD_WITHIN"; reference: string; reduced: string; tolerance: number };

export interface RegionClaim {
  kind: "FOR_ALL";
  region: Record<string, Range>;
  fixed: Point;
  ic: string;
  body: RegionBody;
}

export type Claim = PointClaim | RegionClaim;

export interface Problem {
  path: string;
  message: string;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

class Checker {
  readonly problems: Problem[] = [];
  readonly contract: Contract;

  constructor(contract: Contract) {
    this.contract = contract;
  }

  add(path: string, message: string) {
    this.problems.push({ path, message });
  }

  fields(o: Obj, allowed: string[], path: string) {
    for (const k of Object.keys(o))
      if (!allowed.includes(k)) this.add(`${path}.${k}`, "unknown field");
    for (const k of allowed) if (!has(o, k)) this.add(`${path}.${k}`, "missing field");
  }

  model(v: unknown, path: string): string | undefined {
    if (typeof v === "string" && has(this.contract.models, v)) return v;
    this.add(path, "unknown model");
    return undefined;
  }

  pair(o: Obj, path: string): string[] {
    const models = [
      this.model(o.reference, `${path}.reference`),
      this.model(o.reduced, `${path}.reduced`),
    ];
    if (o.reference === o.reduced) this.add(`${path}.reduced`, "must differ from reference");
    return models.filter((m) => m !== undefined);
  }

  ic(v: unknown, path: string) {
    if (typeof v !== "string" || !this.contract.initialConditions.includes(v)) {
      this.add(path, "unknown initial condition");
    }
  }

  tolerance(v: unknown, path: string) {
    if (typeof v !== "number" || !(v > 0 && v < 1)) this.add(path, "must be a fraction in (0, 1)");
  }

  domain(name: string, path: string): ParameterDomain | undefined {
    const d = has(this.contract.domain, name) ? this.contract.domain[name] : undefined;
    if (!d) this.add(path, "parameter not in contract");
    return d;
  }

  point(v: unknown, path: string): string[] {
    if (!isObj(v)) {
      this.add(path, "must be an object");
      return [];
    }
    for (const [k, x] of Object.entries(v)) {
      const d = this.domain(k, `${path}.${k}`);
      if (!d) continue;
      if (typeof x !== "number" || !Number.isFinite(x))
        this.add(`${path}.${k}`, "must be a finite number");
      else if (x < d.min || x > d.max) this.add(`${path}.${k}`, outside(d));
    }
    return Object.keys(v);
  }

  region(v: unknown, path: string): string[] {
    if (!isObj(v) || Object.keys(v).length === 0) {
      this.add(path, "needs at least one dimension");
      return [];
    }
    for (const [k, r] of Object.entries(v)) {
      const d = this.domain(k, `${path}.${k}`);
      if (!d) continue;
      if (!isObj(r) || typeof r.min !== "number" || typeof r.max !== "number" || !(r.min < r.max)) {
        this.add(`${path}.${k}`, "needs numeric min < max");
      } else if (r.min < d.min || r.max > d.max) {
        this.add(`${path}.${k}`, outside(d));
      }
    }
    return Object.keys(v);
  }

  // A claim must set exactly the parameters of the models it compares.
  coverage(models: string[], given: string[], path: string) {
    const needed = new Set(models.flatMap((m) => this.contract.models[m]?.params ?? []));
    for (const p of needed) if (!given.includes(p)) this.add(path, `parameter ${p} is not set`);
    for (const p of given)
      if (!needed.has(p)) this.add(`${path}.${p}`, "not a parameter of the models");
  }

  body(v: unknown, path: string): string[] {
    if (!isObj(v)) {
      this.add(path, "must be an object");
      return [];
    }
    switch (v.kind) {
      case "OSCILLATES": {
        this.fields(v, ["kind", "model"], path);
        const m = this.model(v.model, `${path}.model`);
        return m ? [m] : [];
      }
      case "AGREE_ON_OSCILLATION":
        this.fields(v, ["kind", "reference", "reduced"], path);
        return this.pair(v, path);
      case "AGREE_AND_PERIOD_WITHIN":
        this.fields(v, ["kind", "reference", "reduced", "tolerance"], path);
        this.tolerance(v.tolerance, `${path}.tolerance`);
        return this.pair(v, path);
      default:
        // A bare period comparison is undefined where a model does not oscillate.
        this.add(`${path}.kind`, "unknown region body; use AGREE_AND_PERIOD_WITHIN for periods");
        return [];
    }
  }
}

function outside(d: ParameterDomain) {
  return `outside admissible domain [${String(d.min)}, ${String(d.max)}]`;
}

export function validateClaim(contract: Contract, input: unknown): Problem[] {
  const c = new Checker(contract);
  if (!isObj(input)) return [{ path: "$", message: "must be an object" }];

  switch (input.kind) {
    case "OSCILLATES": {
      c.fields(input, ["kind", "model", "point", "ic"], "$");
      const m = c.model(input.model, "$.model");
      const given = c.point(input.point, "$.point");
      c.ic(input.ic, "$.ic");
      if (m) c.coverage([m], given, "$.point");
      break;
    }
    case "AGREE_ON_OSCILLATION":
    case "PERIOD_WITHIN": {
      const extra = input.kind === "PERIOD_WITHIN" ? ["tolerance"] : [];
      c.fields(input, ["kind", "reference", "reduced", "point", "ic", ...extra], "$");
      const models = c.pair(input, "$");
      const given = c.point(input.point, "$.point");
      c.ic(input.ic, "$.ic");
      if (extra.length > 0) c.tolerance(input.tolerance, "$.tolerance");
      c.coverage(models, given, "$.point");
      break;
    }
    case "FOR_ALL": {
      c.fields(input, ["kind", "region", "fixed", "ic", "body"], "$");
      const swept = c.region(input.region, "$.region");
      const fixed = c.point(input.fixed, "$.fixed");
      for (const p of fixed) if (swept.includes(p)) c.add(`$.fixed.${p}`, "both fixed and swept");
      c.ic(input.ic, "$.ic");
      const models = c.body(input.body, "$.body");
      if (models.length > 0) c.coverage(models, [...swept, ...fixed], "$");
      break;
    }
    default:
      c.add("$.kind", "unknown claim kind");
  }
  return c.problems;
}

export function parseClaim(
  contract: Contract,
  input: unknown,
): { ok: true; claim: Claim } | { ok: false; problems: Problem[] } {
  const problems = validateClaim(contract, input);
  return problems.length === 0 ? { ok: true, claim: input as Claim } : { ok: false, problems };
}
