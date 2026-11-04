// Every number in docs/study.md, computed from the study's calls.jsonl and
// grid.json; nothing is typed by hand.
//
//   npx vite-node packages/ideas/eval/study-report.ts -- study-dir > summary.json

import { readFile } from "node:fs/promises";

interface Row {
  part: string;
  case: string;
  rep: number;
  setting?: string;
  ok: boolean;
  score?: number | boolean | null;
  usage?: { input: number; cached: number; output: number; reasoning: number; cost: number };
  ms: number;
  error?: string;
  detail?: Record<string, unknown>;
}

const dir = process.argv[2] ?? "study-out";
// The main log, and the later diagnosis of Muse's own wrong predictions.
const rows = [
  await readFile(`${dir}/calls.jsonl`, "utf8"),
  await readFile(`${dir}/diagnose-own.jsonl`, "utf8").catch(() => ""),
]
  .join("\n")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Row);

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : NaN);
const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN) : NaN;
};
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const num = (s: Row["score"]) =>
  typeof s === "boolean" ? (s ? 1 : 0) : typeof s === "number" ? s : NaN;

// Calls, cost, tokens and latency per part.
const parts = [...new Set(rows.map((r) => r.part))];
const overview = Object.fromEntries(
  parts.map((p) => {
    const rs = rows.filter((r) => r.part === p);
    const ok = rs.filter((r) => r.ok && r.usage);
    const u = (k: "input" | "cached" | "output" | "reasoning" | "cost") =>
      sum(ok.map((r) => r.usage?.[k] ?? 0));
    return [
      p,
      {
        calls: rs.length,
        failed: rs.length - ok.length,
        failures: [...new Set(rs.filter((r) => !r.ok).map((r) => r.error ?? ""))].slice(0, 4),
        cost: r3(u("cost")),
        cost_per_call: r3((u("cost") / Math.max(1, ok.length)) * 1000) / 1000,
        input_tokens: u("input"),
        cached_share: r3(u("cached") / Math.max(1, u("input"))),
        output_tokens: u("output"),
        reasoning_share_of_output: r3(u("reasoning") / Math.max(1, u("output"))),
        latency_s: {
          p50: r3(
            q(
              ok.map((r) => r.ms),
              0.5,
            ) / 1000,
          ),
          p90: r3(
            q(
              ok.map((r) => r.ms),
              0.9,
            ) / 1000,
          ),
        },
        mean_score: r3(mean(ok.map((r) => num(r.score)).filter(Number.isFinite))),
      },
    ];
  }),
);

// Decomposition, per goal.
const decompose = Object.fromEntries(
  [...new Set(rows.filter((r) => r.part === "decompose").map((r) => r.case))].map((g) => {
    const rs = rows.filter((r) => r.part === "decompose" && r.case === g && r.ok);
    const d = (k: string) => rs.map((r) => r.detail?.[k]);
    const n = (k: string) => d(k).map((x) => Number(x));
    return [
      g,
      {
        runs: rs.length,
        proposed: r3(mean(n("proposed"))),
        admitted: r3(mean(n("admitted"))),
        checks: r3(mean(n("checks"))),
        computable_share: r3(sum(n("computable")) / Math.max(1, sum(n("checks")))),
        experiments: d("experiments"),
        recipe_named: d("recipe_named").filter(Boolean).length,
        eps_set_by_muse: d("eps_set_by_muse").filter(Boolean).length,
        refused: [...new Set(d("refused").flat())].slice(0, 5),
      },
    ];
  }),
);

// Predictions: accuracy, Brier, calibration, agreement across repetitions.
interface P {
  question: string;
  lessons: number;
  values: Record<string, number>;
  truth: string;
  expect: string;
  confidence: number;
}
const preds = rows
  .filter((r) => (r.part === "predict" || r.part === "settings") && r.ok && r.detail)
  .map((r) => ({ ...(r.detail as unknown as P), rep: r.rep, setting: r.setting ?? "default" }));
const pHolds = (p: P) => (p.expect === "holds" ? p.confidence : 1 - p.confidence);
function scoreSet(ps: P[]) {
  const right = ps.filter((p) => p.expect === p.truth).length;
  const brier = mean(ps.map((p) => (pHolds(p) - (p.truth === "holds" ? 1 : 0)) ** 2));
  // Expected calibration error over five confidence bins of the stated answer.
  const bins = [0.5, 0.6, 0.7, 0.8, 0.9, 1.01];
  let ece = 0;
  const table: { bin: string; n: number; confidence: number; accuracy: number }[] = [];
  for (let i = 0; i < bins.length - 1; i++) {
    const lo = bins[i] ?? 0;
    const hi = bins[i + 1] ?? 1;
    const inBin = ps.filter((p) => p.confidence >= lo && p.confidence < hi);
    if (!inBin.length) continue;
    const c = mean(inBin.map((p) => p.confidence));
    const a = inBin.filter((p) => p.expect === p.truth).length / inBin.length;
    ece += (inBin.length / ps.length) * Math.abs(c - a);
    table.push({
      bin: `${String(lo)}-${String(Math.min(1, hi))}`,
      n: inBin.length,
      confidence: r3(c),
      accuracy: r3(a),
    });
  }
  const holds = ps.filter((p) => p.truth === "holds").length / Math.max(1, ps.length);
  const saidHolds = ps.filter((p) => p.expect === "holds").length / Math.max(1, ps.length);
  return {
    n: ps.length,
    accuracy: r3(right / Math.max(1, ps.length)),
    majority_baseline: r3(Math.max(holds, 1 - holds)),
    brier: r3(brier),
    ece: r3(ece),
    said_holds: r3(saidHolds),
    truth_holds: r3(holds),
    mean_confidence: r3(mean(ps.map((p) => p.confidence))),
    calibration: table,
  };
}
const key = (p: P) => `${p.question}|${String(p.lessons)}|${JSON.stringify(p.values)}`;
function agreement(ps: (P & { rep: number })[]) {
  const by = new Map<string, string[]>();
  for (const p of ps) by.set(key(p), [...(by.get(key(p)) ?? []), p.expect]);
  const full = [...by.values()].filter((v) => v.length >= 3);
  return r3(full.filter((v) => v.every((x) => x === v[0])).length / Math.max(1, full.length));
}
const def = preds.filter((p) => p.setting === "default");
type Group = [string, (P & { rep: number; setting: string })[]];
const predictGroups: Group[] = [
  ["oscillates, no lesson", def.filter((p) => p.question === "oscillates")],
  ["reduced_oscillates, no lesson", def.filter((p) => p.question === "reduced_oscillates")],
  [
    "reduction, no lesson",
    def.filter((p) => p.question === "reduction_keeps_period" && p.lessons === 0),
  ],
  [
    "reduction, one lesson",
    def.filter((p) => p.question === "reduction_keeps_period" && p.lessons === 1),
  ],
  [
    "reduction, two lessons",
    def.filter((p) => p.question === "reduction_keeps_period" && p.lessons === 2),
  ],
];
const predict = Object.fromEntries(
  predictGroups.map(([name, ps]) => [
    name,
    { ...scoreSet(ps), same_answer_all_reps: agreement(ps) },
  ]),
);
// The same 60 points, first repetition, no lesson: low effort vs medium vs contributor.
const sixty = new Set(
  preds.filter((p) => p.setting === "effort-medium").map((p) => JSON.stringify(p.values)),
);
const settingGroups: Group[] = [
  [
    "standard, effort low",
    def.filter(
      (p) =>
        p.question === "reduction_keeps_period" &&
        p.lessons === 0 &&
        p.rep === 0 &&
        sixty.has(JSON.stringify(p.values)),
    ),
  ],
  ["standard, effort medium", preds.filter((p) => p.setting === "effort-medium")],
  ["contributor, effort low", preds.filter((p) => p.setting === "contributor")],
];
const settings = Object.fromEntries(settingGroups.map(([name, ps]) => [name, scoreSet(ps)]));
const settingCost = Object.fromEntries(
  ["effort-medium", "contributor"].map((s) => {
    const rs = rows.filter((r) => r.setting === s && r.ok);
    return [
      s,
      {
        cost_per_call: r3(mean(rs.map((r) => r.usage?.cost ?? 0)) * 1000) / 1000,
        latency_p50_s: r3(
          q(
            rs.map((r) => r.ms),
            0.5,
          ) / 1000,
        ),
      },
    ];
  }),
);

// The three lesson conditions on exactly the same points and repetitions.
const reduction = def.filter((p) => p.question === "reduction_keeps_period");
const pairKey = (p: P & { rep: number }) => `${String(p.rep)}|${JSON.stringify(p.values)}`;
const byLessons = [0, 1, 2].map(
  (l) => new Map(reduction.filter((p) => p.lessons === l).map((p) => [pairKey(p), p])),
);
const shared = [...(byLessons[0]?.keys() ?? [])].filter((k) => byLessons.every((m) => m.has(k)));
const right = (l: number, k: string) => {
  const p = byLessons[l]?.get(k);
  return p ? p.expect === p.truth : false;
};
const paired = {
  n: shared.length,
  points: new Set(shared.map((k) => k.split("|")[1])).size,
  accuracy: [0, 1, 2].map((l) => r3(shared.filter((k) => right(l, k)).length / shared.length)),
  wrong_to_right_with_one: shared.filter((k) => !right(0, k) && right(1, k)).length,
  right_to_wrong_with_one: shared.filter((k) => right(0, k) && !right(1, k)).length,
  wrong_to_right_two_vs_one: shared.filter((k) => !right(1, k) && right(2, k)).length,
  right_to_wrong_two_vs_one: shared.filter((k) => right(1, k) && !right(2, k)).length,
};

// Diagnosis after a surprise: a supplied wrong prediction (diagnose) or
// Muse's own (diagnose-own).
const diagnosis = (part: string) => {
  const dg = rows.filter((r) => r.part === part && r.ok);
  return {
    runs: dg.length,
    accepted_by_engine: dg.filter((r) => r.detail?.accepted).length,
    rejected_reasons: [
      ...new Set(dg.filter((r) => !r.detail?.accepted).map((r) => String(r.detail?.reason))),
    ],
    test_decided_one: dg.filter((r) => r.detail?.decided === "one consistent").length,
    outcomes: Object.fromEntries(
      [...new Set(dg.map((r) => String(r.detail?.decided)))].map((d) => [
        d,
        dg.filter((r) => String(r.detail?.decided) === d).length,
      ]),
    ),
    test_parameters: Object.fromEntries(
      [
        ...new Set(
          dg.map((r) => String((r.detail?.test as { param?: string } | undefined)?.param)),
        ),
      ].map((p) => [
        p,
        dg.filter((r) => String((r.detail?.test as { param?: string } | undefined)?.param) === p)
          .length,
      ]),
    ),
    with_unsupported_numbers: dg.filter(
      (r) => ((r.detail?.unsupported as string[] | undefined) ?? []).length > 0,
    ).length,
  };
};
const diagnose = { supplied: diagnosis("diagnose"), own: diagnosis("diagnose-own") };

// Chat and vision, per case.
const perCase = (part: string) =>
  Object.fromEntries(
    [...new Set(rows.filter((r) => r.part === part).map((r) => r.case))].map((c) => {
      const rs = rows.filter((r) => r.part === part && r.case === c);
      return [
        c,
        {
          runs: rs.length,
          failed: rs.filter((r) => !r.ok).length,
          mean_score: r3(mean(rs.filter((r) => r.ok).map((r) => num(r.score)))),
        },
      ];
    }),
  );
const formula = rows.filter((r) => r.part === "vision-formula" && r.ok);
const vision = {
  formulas_mapped_right: `${String(formula.filter((r) => r.case.startsWith("f") && r.score === true).length)}/${String(formula.filter((r) => r.case.startsWith("f")).length)}`,
  unknown_symbols_flagged: `${String(formula.filter((r) => r.case.startsWith("u") && r.score === true).length)}/${String(formula.filter((r) => r.case.startsWith("u")).length)}`,
  recipe_values_read: r3(
    mean(rows.filter((r) => r.part === "vision-recipe" && r.ok).map((r) => num(r.score))),
  ),
  review_right: `${String(rows.filter((r) => r.part === "vision-review" && r.ok && r.score === true).length)}/${String(rows.filter((r) => r.part === "vision-review" && r.ok).length)}`,
  review_planted_mismatch_caught: `${String(rows.filter((r) => r.part === "vision-review" && r.ok && r.detail?.expected_ok === false && r.score === true).length)}/${String(rows.filter((r) => r.part === "vision-review" && r.ok && r.detail?.expected_ok === false).length)}`,
  review_false_alarms: `${String(rows.filter((r) => r.part === "vision-review" && r.ok && r.detail?.expected_ok === true && r.score === false).length)}/${String(rows.filter((r) => r.part === "vision-review" && r.ok && r.detail?.expected_ok === true).length)}`,
  formula_cases: perCase("vision-formula"),
  review_cases: perCase("vision-review"),
};

const run = JSON.parse(await readFile(`${dir}/run.json`, "utf8").catch(() => "{}")) as Record<
  string,
  unknown
>;
console.log(
  JSON.stringify(
    {
      run,
      total: {
        calls: rows.length,
        failed: rows.filter((r) => !r.ok).length,
        cost: r3(sum(rows.map((r) => r.usage?.cost ?? 0))),
      },
      overview,
      decompose,
      predict,
      paired,
      settings,
      settingCost,
      diagnose,
      chat: perCase("chat"),
      vision,
    },
    null,
    1,
  ),
);
