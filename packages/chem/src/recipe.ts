// From a real Belousov-Zhabotinsky recipe to the Oregonator's scaled
// parameters and its time scale in seconds.
//
// Field, "Oregonator", Scholarpedia 2, 1386 (2007), gives the scaled
// parameters eps = 9.9e-3, eps_prime = 1.98e-5, q = 7.62e-5 for
// [BrO3-] = 0.06 M, [CH2(COOH)2] = 0.02 M and [H+] = 0.8 M (FIELD_2007). The
// effective rate constants below reproduce those three numbers exactly at
// that acidity. How they change with acidity is an assumption, flagged as
// such: the usual proton orders, two for O1 and one for O2 and O3.

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

const REFERENCE_ACID = 0.8;

// Effective rate constants at [H+] = 0.8 M, in M^-1 s^-1.
export const RATE_CONSTANTS = {
  k1: 1.28, // BrO3- + Br- -> HBrO2 + HOBr
  k2: 3e6, // HBrO2 + Br- -> 2 HOBr
  k3: 33.6, // BrO3- + HBrO2 -> 2 HBrO2 + 2 oxidised catalyst
  k4: 3000, // 2 HBrO2 -> BrO3- + HOBr
  k5: 1, // malonic acid + oxidised catalyst -> (f/2) Br-
} as const;

export const RECIPE_SOURCE =
  "Field, Scholarpedia 2, 1386 (2007), at [H+] = 0.8 M; proton orders 2, 1, 1 assumed for other acidities";

// How the recipe sets the model, in words a model can reason with.
export const RECIPE_RELATIONS =
  "time_scale_s = 1 / (k5 malonic_acid), k5 = 1 /M/s; period in seconds = model period x time_scale_s; " +
  "eps = k5 malonic_acid / (k3 bromate); eps_prime = 2 k4 k5 malonic_acid / (k2 k3 bromate); " +
  "k3 = 33.6 and k2 = 3e6 at acid 0.8 M, each proportional to acid; k4 = 3000; q does not depend on the recipe.";

export function fromRecipe(r: Recipe): RecipeParams {
  for (const [k, v] of Object.entries(r)) {
    if (!Number.isFinite(v) || v <= 0) throw new RangeError(`the recipe needs a positive ${k}`);
  }
  const h = r.acid / REFERENCE_ACID;
  const k1 = RATE_CONSTANTS.k1 * h * h;
  const k2 = RATE_CONSTANTS.k2 * h;
  const k3 = RATE_CONSTANTS.k3 * h;
  const { k4, k5 } = RATE_CONSTANTS;
  const a = r.bromate;
  const b = r.malonic_acid;
  return {
    q: (2 * k1 * k4) / (k2 * k3),
    eps: (k5 * b) / (k3 * a),
    eps_prime: (2 * k4 * k5 * b) / (k2 * k3 * a),
    time_scale_s: 1 / (k5 * b),
  };
}
