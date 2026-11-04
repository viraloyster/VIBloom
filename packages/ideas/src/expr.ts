// A small arithmetic language for checks. The model writes expressions over
// named parameters; nothing it writes is ever executed as code.

const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  log: Math.log,
  log10: Math.log10,
  exp: Math.exp,
  pow: Math.pow,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };
export const MAX_EXPR = 400;

type Tok = { k: "num"; v: number } | { k: "id"; v: string } | { k: "op"; v: string };

function lex(text: string): Tok[] {
  if (text.length > MAX_EXPR) throw new Error("expression too long");
  // Models trained on JavaScript sometimes write p.name; the name is what counts.
  const src = text.replace(/\bp\./g, "");
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (/\s/.test(c)) i++;
    else if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new Error(`bad number at ${String(i)}`);
      out.push({ k: "num", v: Number(m[0]) });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const name = /^[A-Za-z_]\w*/.exec(src.slice(i))?.[0] ?? c;
      out.push({ k: "id", v: name });
      i += name.length;
    } else if ("+-*/^(),".includes(c)) {
      out.push({ k: "op", v: c });
      i++;
    } else throw new Error(`unexpected "${c}"`);
  }
  return out;
}

// Recursive descent: sum -> product -> power -> unary -> atom.
export function evaluate(
  src: string,
  scope: Record<string, number>,
  read: Record<string, number> = {},
): number {
  const t = lex(src);
  let i = 0;
  const peek = () => t[i];
  const isOp = (v: string) => {
    const x = peek();
    return x?.k === "op" && x.v === v;
  };
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`expected "${v}"`);
    i++;
  };
  const sum = (): number => {
    let v = product();
    while (isOp("+") || isOp("-")) v = (t[i++]?.v === "+" ? 1 : -1) * product() + v;
    return v;
  };
  const product = (): number => {
    let v = power();
    while (isOp("*") || isOp("/")) v = t[i++]?.v === "*" ? v * power() : v / power();
    return v;
  };
  const power = (): number => {
    const b = unary();
    if (isOp("^")) {
      i++;
      return b ** power();
    }
    return b;
  };
  const unary = (): number => {
    if (isOp("-")) {
      i++;
      return -unary();
    }
    if (isOp("+")) {
      i++;
      return unary();
    }
    return atom();
  };
  const atom = (): number => {
    const x = t[i++];
    if (!x) throw new Error("unexpected end");
    if (x.k === "num") return x.v;
    if (x.k === "op") {
      if (x.v !== "(") throw new Error(`unexpected "${x.v}"`);
      const v = sum();
      expect(")");
      return v;
    }
    const f = Object.hasOwn(FUNCS, x.v) ? FUNCS[x.v] : undefined;
    if (f && isOp("(")) {
      i++;
      const args = [sum()];
      while (isOp(",")) {
        i++;
        args.push(sum());
      }
      expect(")");
      return f(...args);
    }
    if (Object.hasOwn(scope, x.v)) {
      const v = scope[x.v] ?? NaN;
      read[x.v] = v;
      return v;
    }
    const c = Object.hasOwn(CONSTS, x.v) ? CONSTS[x.v] : undefined;
    if (c !== undefined) return c;
    throw new Error(`unknown name "${x.v}"`);
  };
  const v = sum();
  if (i < t.length) throw new Error("unexpected input after the expression");
  return v;
}

export type Op = "<" | "<=" | ">" | ">=";
export const OPS: readonly Op[] = ["<", "<=", ">", ">="];

export function compare(a: number, op: Op, b: number): boolean {
  switch (op) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
  }
}

// The parameter names an expression refers to, without evaluating it.
export function names(src: string): string[] {
  const out = new Set<string>();
  for (const t of lex(src)) {
    if (t.k === "id" && !Object.hasOwn(FUNCS, t.v) && !Object.hasOwn(CONSTS, t.v)) out.add(t.v);
  }
  return [...out].sort();
}

// The expression as a sequence of tokens, for comparing structure.
export function tokens(src: string): string[] {
  return lex(src).map((t) => (t.k === "num" ? `#${String(t.v)}` : `${t.k}:${t.v}`));
}

// Replaces whole identifiers, never parts of longer names.
export function rename(src: string, from: string, to: string): string {
  return src.replace(new RegExp(`(?<![\\w.])${from}(?!\\w)`, "g"), to);
}

// True when the expression is a single parameter name and nothing else.
export function bare(src: string): string | undefined {
  try {
    const t = lex(src);
    return t.length === 1 && t[0]?.k === "id" ? t[0].v : undefined;
  } catch {
    return undefined;
  }
}
