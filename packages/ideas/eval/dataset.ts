// The four evaluations as one open dataset: protocols, points and
// predictions in separate files, so a point is counted once however many
// times it was predicted, and repetitions are never mistaken for new cases.
// The build fails if any count or score differs from docs/evaluation.md;
// build-dataset.ts writes the files.

import { readFile } from "node:fs/promises";

type Outcome = "holds" | "fails";
interface RawRow {
  point: Record<string, number>;
  rep: number;
  truth: Outcome;
  expect?: Outcome;
  confidence?: number;
  uses?: string[];
  cost: number;
  error?: string;
  seen?: boolean;
  condition?: string;
  withLesson?: boolean;
  difference?: number;
  gap?: number;
}

export interface Protocol {
  id: string;
  file: string;
  question: "reduction_keeps_period";
  tolerance: number;
  model: "muse-spark-1.3";
  effort: "low";
  grid: string;
  frozen: string;
  lessons: string;
  conditions: Record<string, string>;
  repetitions: number;
}

const PROTOCOLS: Protocol[] = [
  {
    id: "e1",
    file: "predictions-2026-11-04.json",
    question: "reduction_keeps_period",
    tolerance: 0.05,
    model: "muse-spark-1.3",
    effort: "low",
    grid: "s in {0.75, 1, 1.5, 2} x eps_prime in {1e-5, 5e-5, 2e-4, 1e-3}, q 7.62e-5, eps 0.01",
    frozen: "defined in the evaluation script before the run; no separate commit",
    lessons: "packages/ideas/eval/lesson-session.json, lesson-1",
    conditions: {
      none: "no lesson",
      binary: "the lesson as outcomes, shown as invalidated at other values",
    },
    repetitions: 2,
  },
  {
    id: "e2",
    file: "predictions-2026-11-04-grid2.json",
    question: "reduction_keeps_period",
    tolerance: 0.05,
    model: "muse-spark-1.3",
    effort: "low",
    grid: "packages/ideas/eval/grid-2.json",
    frozen: "679008b",
    lessons: "packages/ideas/eval/lesson-session.json, lesson-1",
    conditions: {
      none: "no lesson",
      binary: "the lesson as outcomes only",
      quantitative: "the lesson with its measured contrast",
    },
    repetitions: 2,
  },
  {
    id: "e3",
    file: "predictions-2026-11-04-grid3.json",
    question: "reduction_keeps_period",
    tolerance: 0.05,
    model: "muse-spark-1.3",
    effort: "low",
    grid: "packages/ideas/eval/grid-3.json",
    frozen: "4480544",
    lessons: "packages/ideas/eval/lesson-session.json, lesson-1",
    conditions: {
      none: "no lesson",
      binary: "the lesson as outcomes only",
      quantitative: "the lesson with its measured contrast",
    },
    repetitions: 2,
  },
  {
    id: "e4",
    file: "predictions-2026-11-04-two-lessons.json",
    question: "reduction_keeps_period",
    tolerance: 0.05,
    model: "muse-spark-1.3",
    effort: "low",
    grid: "packages/ideas/eval/grid-4.json",
    frozen: "486eb21",
    lessons: "packages/ideas/eval/lesson-session-2.json, lesson-1 and lesson-2",
    conditions: {
      none: "no lesson",
      one: "the first lesson with its measured contrast",
      two: "both lessons with their measured contrasts",
    },
    repetitions: 2,
  },
];

// Right answers on new points, per condition, as docs/evaluation.md reports.
export const PUBLISHED: Record<string, Record<string, [right: number, of: number]>> = {
  e1: { none: [8, 28], binary: [15, 28] },
  e2: { none: [6, 28], binary: [22, 28], quantitative: [26, 28] },
  e3: { none: [40, 72], binary: [54, 72], quantitative: [60, 72] },
  e4: { none: [48, 72], one: [55, 72], two: [61, 72] },
};

const key = (v: Record<string, number>) =>
  ["q", "eps", "s", "eps_prime"].map((k) => String(v[k])).join(",");

export async function build(root: URL) {
  const points: Record<string, unknown>[] = [];
  const predictions: Record<string, unknown>[] = [];
  const counts: Record<string, Record<string, [number, number]>> = {};
  for (const p of PROTOCOLS) {
    const data = JSON.parse(await readFile(new URL(`docs/eval/${p.file}`, root), "utf8")) as {
      rows: RawRow[];
    };
    const ids = new Map<string, string>();
    for (const r of data.rows) {
      const k = key(r.point);
      if (!ids.has(k)) {
        const id = `${p.id}-p${String(ids.size + 1)}`;
        ids.set(k, id);
        points.push({
          evaluation: p.id,
          point: id,
          values: r.point,
          seen_in_lesson: r.seen ?? false,
          truth: r.truth,
          gap: r.difference ?? r.gap ?? null,
        });
      }
      const condition = r.condition ?? (r.withLesson ? "binary" : "none");
      predictions.push({
        evaluation: p.id,
        point: ids.get(k),
        condition,
        repetition: r.rep,
        expect: r.expect ?? null,
        confidence: r.confidence ?? null,
        right: r.expect === undefined ? null : r.expect === r.truth,
        cited_lessons: r.uses ?? [],
        cost_usd: r.cost,
        ...(r.error ? { error: r.error } : {}),
      });
      if (!r.seen) {
        const c = ((counts[p.id] ??= {})[condition] ??= [0, 0]);
        c[1]++;
        if (r.expect === r.truth) c[0]++;
      }
    }
  }
  return { protocols: PROTOCOLS, points, predictions, counts };
}

export function mismatches(counts: Record<string, Record<string, [number, number]>>): string[] {
  const out: string[] = [];
  for (const [e, conds] of Object.entries(PUBLISHED)) {
    for (const [c, [right, of]] of Object.entries(conds)) {
      const got = counts[e]?.[c];
      if (got?.[0] !== right || got[1] !== of)
        out.push(`${e} ${c}: published ${String(right)}/${String(of)}, data ${String(got)}`);
    }
  }
  return out;
}

export const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
