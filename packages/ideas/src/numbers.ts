// A guard on what Muse writes: every number in its prose must come from the
// data it was given. The prompt asks for that; this checks it, so a figure
// that only sounds measured is flagged instead of trusted.

// Numbers as written: 0.55, 3.9e-5, 55%, 1,200. Not digits inside names
// (eps_prime2, s1) and not the counts and ordinals prose needs (two, 1st).
const NUMBER = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?|\.\d+)(?:e([+-]?\d+))?(%?)(?![\w.])/gi;

export function numbersIn(text: string): { raw: string; value: number; percent: boolean }[] {
  const out = [];
  for (const m of text.matchAll(NUMBER)) {
    const base = Number((m[1] ?? "").replace(/,/g, ""));
    const value = m[2] ? base * 10 ** Number(m[2]) : base;
    if (Number.isFinite(value)) out.push({ raw: m[0], value, percent: m[3] === "%" });
  }
  return out;
}

// A number is supported if it is a given one rounded to the places it is
// written with (a 55.014% gap may be quoted as 55%), or within 1% of it,
// directly or as a percentage of a fraction. Small whole numbers pass: "two
// explanations", "one parameter", "3 runs" are not claims about the data.
export function unsupportedNumbers(text: string, allowed: number[]): string[] {
  const given = allowed.filter(Number.isFinite);
  return numbersIn(text)
    .filter(({ raw, value, percent }) => {
      if (!percent && Number.isInteger(value) && value <= 10) return false;
      const [mantissa = "", exp = "0"] = raw.replace(/[%,]/g, "").toLowerCase().split("e");
      const places = mantissa.split(".")[1]?.length ?? 0;
      const half = 0.5 * 10 ** (Number(exp) - places);
      const near = (g: number) =>
        Math.abs(value - g) <= Math.max(half, 0.01 * Math.abs(g)) * (1 + 1e-9);
      return !given.some((g) => near(g) || near(g * 100) || (percent && near(g)));
    })
    .map((n) => n.raw);
}

// Every number in a value, however deeply nested.
export function numbersOf(x: unknown, out: number[] = []): number[] {
  if (typeof x === "number") out.push(x);
  else if (typeof x === "string") for (const n of numbersIn(x)) out.push(n.value);
  else if (Array.isArray(x)) for (const v of x) numbersOf(v, out);
  else if (x && typeof x === "object") for (const v of Object.values(x)) numbersOf(v, out);
  return out;
}
