// Oregonator models in slow time tau (docs/science.md):
//   eps x' = q y - x y + x (1 - x)
//   eps_prime y' = -q y - x y + s z
//   z' = x - z
// The reduced model sets eps_prime y' = 0, so y = s z / (q + x).

import type { OdeSystem, Vec } from "./solver";

export interface OregonatorParams {
  q: number;
  eps: number;
  eps_prime: number;
  s: number;
}

export type OregonatorModel = "full" | "reduced";
export type InitialCondition = "far" | "mid" | "near";

// Field, Scholarpedia 2, 1386 (2007).
export const FIELD_2007 = { q: 7.62e-5, eps: 9.9e-3, eps_prime: 1.98e-5 } as const;
// Brizard and Berry, arXiv:2105.01234, with (eps, eps_prime) = (d, d e).
export const BRIZARD_BERRY_2021 = { q: 7.62e-5, eps: 1e-3, eps_prime: 2e-6 } as const;

// Concentrations are non-negative; the positive orthant is invariant.
const nonNegative = (u: readonly number[]) => u.every((v) => v >= 0);

export function fullModel({ q, eps, eps_prime, s }: OregonatorParams): OdeSystem {
  return {
    rhs: ([x = 0, y = 0, z = 0]) => [
      (q * y - x * y + x * (1 - x)) / eps,
      (-q * y - x * y + s * z) / eps_prime,
      x - z,
    ],
    jac: ([x = 0, y = 0]) => [
      [(1 - 2 * x - y) / eps, (q - x) / eps, 0],
      [-y / eps_prime, -(q + x) / eps_prime, s / eps_prime],
      [1, 0, -1],
    ],
    inDomain: nonNegative,
  };
}

export function reducedModel({ q, eps, s }: OregonatorParams): OdeSystem {
  return {
    rhs: ([x = 0, z = 0]) => [(x * (1 - x) - (s * z * (x - q)) / (x + q)) / eps, x - z],
    jac: ([x = 0, z = 0]) => [
      [(1 - 2 * x - (2 * q * s * z) / (x + q) ** 2) / eps, (-s * (x - q)) / (x + q) / eps],
      [1, -1],
    ],
    inDomain: nonNegative,
  };
}

export function model(kind: OregonatorModel, p: OregonatorParams): OdeSystem {
  return kind === "full" ? fullModel(p) : reducedModel(p);
}

// Positive root of x^2 + (s + q - 1) x - q (1 + s) = 0; z equals x there.
export function steadyStateX({ q, s }: OregonatorParams): number {
  const b = s + q - 1;
  return (-b + Math.sqrt(b * b + 4 * q * (1 + s))) / 2;
}

export function initialState(
  kind: OregonatorModel,
  p: OregonatorParams,
  ic: InitialCondition,
): Vec {
  const xs = steadyStateX(p);
  const [x0, z0] = ic === "far" ? [0.5, 0.5] : ic === "mid" ? [0.05, 0.2] : [1.01 * xs, xs];
  // The full model starts on the slow manifold so both models start alike.
  return kind === "full" ? [x0, (p.s * z0) / (p.q + x0), z0] : [x0, z0];
}
