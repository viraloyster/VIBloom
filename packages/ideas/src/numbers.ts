// A heuristic detector on what Muse writes: every number in its prose should
// come from the data it was given. The prompt asks for that; this flags a
// figure that only sounds measured. It is a detector, not a proof: a number
// can be in the data by coincidence, and words carry no numbers.

// Numbers as written: 0.55, 3.9e-5, 55%, 1,200. Not digits inside names
// (eps_prime2, s1) and not the counts and ordinals prose needs (two, 1st).
const NUMBER = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?|\.\d+)(?:e([+-]?\d+))?(%?)(?![\w.])/gi;

export function numbersIn(
  text: string,
): { raw: string; value: number; percent: boolean; end: number }[] {
  const out = [];
  for (const m of text.matchAll(NUMBER)) {
    const base = Number((m[1] ?? "").replace(/,/g, ""));
    const value = m[2] ? base * 10 ** Number(m[2]) : base;
    if (Number.isFinite(value))
      out.push({ raw: m[0], value, percent: m[3] === "%", end: m.index + m[0].length });
  }
  return out;
}

// A number is supported if it is a given one rounded to the places it is
// written with (a 55.014% gap may be quoted as 55%), or within 1% of it,
// directly or as a percentage of a fraction. A small whole number counting
// things passes ("3 runs", "2 explanations"); with a unit it is a quantity
// and must be supported ("5 s", "2 M", "3x").
const UNIT =
  /^\s*(?:s|sec|seconds?|min|minutes?|h|hours?|ms|m?M|mol|g|kg|m|cm|mm|K|C|x|times|fold|%)(?![a-z])/i;

export function unsupportedNumbers(text: string, allowed: number[]): string[] {
  const given = allowed.filter(Number.isFinite);
  return numbersIn(text)
    .filter(({ raw, value, percent, end }) => {
      if (!percent && Number.isInteger(value) && value <= 10 && !UNIT.test(text.slice(end)))
        return false;
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
