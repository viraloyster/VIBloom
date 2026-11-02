// The first project: does the two-variable Oregonator keep the period of the
// three-variable model? See docs/science.md.

import type { Contract } from "@vibloom/contracts";
import type { Op } from "@vibloom/engine";

export const CONTRACT: Contract = {
  version: "oregonator-v1",
  models: { full: { params: ["s", "eps_prime"] }, reduced: { params: ["s"] } },
  domain: {
    s: { min: 0.4, max: 2.8, scale: "linear" },
    eps_prime: { min: 1e-6, max: 1e-2, scale: "log" },
  },
  initialConditions: ["far", "mid", "near"],
};

export const SEED_OPS: Op[] = [
  {
    op: "add_node",
    node: {
      kind: "assumption",
      id: "field-parameters",
      title: "Parameters of Field (2007)",
      statement: "q = 7.62e-5, eps = 9.9e-3",
      scope: "both models",
      state: "adopted",
      protected: true,
    },
  },
  {
    op: "add_node",
    node: {
      kind: "assumption",
      id: "quasi-steady-bromide",
      title: "Bromide is quasi-steady",
      statement: "eps_prime y' = 0, so y = s z / (q + x)",
      scope: "two-variable model",
      state: "adopted",
      protected: false,
    },
  },
  {
    op: "add_node",
    node: {
      kind: "invariant",
      id: "non-negative-concentrations",
      title: "Concentrations stay non-negative",
      check: "non_negative_state",
      version: "1",
      scope: "every integration",
    },
  },
  {
    op: "add_node",
    node: {
      kind: "model",
      id: "oregonator",
      title: "Oregonator, slow time",
      name: "oregonator",
      version: "1",
      equations: "eps x' = q y - x y + x (1 - x); eps_prime y' = -q y - x y + s z; z' = x - z",
      params: { q: 7.62e-5, eps: 9.9e-3 },
      scaling: "tau = d t",
    },
  },
  {
    op: "add_node",
    node: {
      kind: "claim",
      id: "reduction-keeps-period",
      title: "The reduction keeps the period within 5%",
      version: 1,
      text: "For s in [0.6, 2.3] and eps_prime = 1e-4, both models agree on oscillation and their periods differ by at most 5%.",
      predicate: {
        kind: "FOR_ALL",
        region: { s: { min: 0.6, max: 2.3 } },
        fixed: { eps_prime: 1e-4 },
        ic: "far",
        body: {
          kind: "AGREE_AND_PERIOD_WITHIN",
          reference: "full",
          reduced: "reduced",
          tolerance: 0.05,
        },
      },
      protocol: "robust-v1",
    },
  },
  {
    op: "add_node",
    node: {
      kind: "experiment",
      id: "point-runs",
      title: "Point runs of both models",
      spec: {
        model: { id: "oregonator", revision: 1 },
        claim: { id: "reduction-keeps-period", revision: 1 },
        solver: "seulex-v1",
        detector: "peaks-v1",
        protocol: "robust-v1",
      },
      results: [],
    },
  },
  {
    op: "add_edge",
    edge: { from: "oregonator", to: "field-parameters", origin: "human", state: "confirmed" },
  },
  {
    op: "add_edge",
    edge: {
      from: "reduction-keeps-period",
      to: "quasi-steady-bromide",
      origin: "human",
      state: "confirmed",
    },
  },
];
