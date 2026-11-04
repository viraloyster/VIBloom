// From a real Belousov-Zhabotinsky recipe to the Oregonator's scaled
// parameters and its time scale in seconds.
//
// Field, "Oregonator", Scholarpedia 2, 1386 (2007): the FKN Oregonator steps
// with rate constants k1 = 2 [H+]^2, k2 = 3e6 [H+], k3 = 42 [H+], k4 = 3000
// [H+] and k5 = 1 (M, s), so at [H+] = 0.8 M k2 = 2.4e6 and k4 = 2400. For
// [BrO3-] = 0.06 M, [CH2(COOH)2] = 0.02 M and [H+] = 0.8 M they give
// eps = 9.9e-3, eps_prime = 1.98e-5, q = 7.62e-5 (FIELD_2007).

export interface Recipe {
  // Molar concentrations.
  bromate: number;
  malonic_acid: number;
  acid: number;
}

export interface RecipeParams {
  q: number;
  eps: number;
  eps_prime: number;
  // Seconds per unit of the model's slow time: 1 / (k5 [malonic acid]).
  time_scale_s: number;
}

// Rate constants as Field writes them: a coefficient times the proton
// concentration to the order shown, in M and s.
export const RATE_CONSTANTS = {
  k1: { k: 2, protons: 2 }, // BrO3- + Br- -> HBrO2 + HOBr
  k2: { k: 3e6, protons: 1 }, // HBrO2 + Br- -> 2 HOBr
  k3: { k: 42, protons: 1 }, // BrO3- + HBrO2 -> 2 HBrO2 + 2 oxidised catalyst
  k4: { k: 3000, protons: 1 }, // 2 HBrO2 -> BrO3- + HOBr
  k5: { k: 1, protons: 0 }, // malonic acid + oxidised catalyst -> (f/2) Br-
} as const;

// Bumped whenever the constants or relations change, and recorded with every
// run that used them, so evidence computed under an older version is known.
export const RECIPE_VERSION = 2;

export const RECIPE_SOURCE =
  "Field, Scholarpedia 2, 1386 (2007): k1 = 2 [H+]^2, k2 = 3e6 [H+], k3 = 42 [H+], k4 = 3000 [H+], k5 = 1";

// How the recipe sets the model, in words a model can reason with.
export const RECIPE_RELATIONS =
  "time_scale_s = 1 / (k5 malonic_acid), k5 = 1 /M/s; period in seconds = model period x time_scale_s; " +
  "eps = k5 malonic_acid / (k3 bromate); eps_prime = 2 k4 k5 malonic_acid / (k2 k3 bromate); " +
  "q = 2 k1 k4 / (k2 k3); k1 = 2 acid^2, k2 = 3e6 acid, k3 = 42 acid, k4 = 3000 acid, k5 = 1. " +
  "So q grows with acid, eps and eps_prime fall with acid, and q does not depend on bromate or malonic acid.";

export function fromRecipe(r: Recipe): RecipeParams {
  for (const [k, v] of Object.entries(r)) {
    if (!Number.isFinite(v) || v <= 0) throw new RangeError(`the recipe needs a positive ${k}`);
  }
  const at = (c: { k: number; protons: number }) => c.k * r.acid ** c.protons;
  const k1 = at(RATE_CONSTANTS.k1);
  const k2 = at(RATE_CONSTANTS.k2);
  const k3 = at(RATE_CONSTANTS.k3);
  const k4 = at(RATE_CONSTANTS.k4);
  const k5 = at(RATE_CONSTANTS.k5);
  const a = r.bromate;
  const b = r.malonic_acid;
  return {
    q: (2 * k1 * k4) / (k2 * k3),
    eps: (k5 * b) / (k3 * a),
    eps_prime: (2 * k4 * k5 * b) / (k2 * k3 * a),
    time_scale_s: 1 / (k5 * b),
  };
}
