// The process behind a tree, read from its log: who did what, in order.
// Muse proposes, predicts and explains; the engine computes, runs, refuses and
// decides; the person asks and changes values. Every step comes from a
// recorded event (or a recorded refusal), never from what the screen shows.

import type { CheckResult, IdeaEvent, IdeaTree, Usage } from "@vibloom/ideas";

export type Actor = "muse" | "engine" | "person";

export interface Step {
  seq: number;
  actor: Actor;
  stage: string;
  title: string;
  result?: string;
  tone?: "ok" | "fail" | "warn" | undefined;
  nodes: string[];
  detail: [string, string][];
}

const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
const num = (x: number) =>
  Math.abs(x) >= 1e4 || (Math.abs(x) < 1e-3 && x !== 0)
    ? x.toExponential(2)
    : String(+x.toPrecision(4));
const words = (s: string) => s.replace(/_/g, " ");

function usage(u: Usage): [string, string][] {
  return [
    ["Model", u.model],
    ["Tokens", `${String(u.input)} in (${String(u.cached)} cached), ${String(u.output)} out`],
    ["Cost", `$${u.cost.toFixed(4)}`],
  ];
}

const link = (e: IdeaEvent): [string, string] => [
  "Log",
  `#${String(e.seq)}, hash ${e.hash.slice(0, 10)}..., after ${e.prev.slice(0, 10)}...`,
];

function seconds(r: CheckResult): string {
  const ts = r.inputs.time_scale_s;
  const full = r.sim?.periods.full;
  if (full === undefined) return "";
  return ts === undefined ? `period ${num(full)}` : `period ${num(full * ts)} s`;
}

export function steps(tree: IdeaTree): Step[] {
  const out: Step[] = [];
  const title = (id: string) => tree.nodes.get(id)?.title ?? id;
  const values = new Map<string, { v: number; unit: string }>();
  // Formula checks right after a growth are one step, not dozens.
  let batch: Step | undefined;

  for (const e of tree.events) {
    const b = e.body;
    for (const r of tree.refused.filter((x) => x.at === e.seq)) {
      out.push({
        seq: e.seq,
        actor: "engine",
        stage: "Refused",
        title: r.reason,
        tone: "warn",
        nodes: [],
        detail: [
          ["What", r.what],
          ["Proposed by", r.actor],
        ],
      });
    }
    if (b.type !== "check") batch = undefined;
    switch (b.type) {
      case "goal":
        out.push({
          seq: e.seq,
          actor: "person",
          stage: "Question",
          title: b.text,
          ...(b.sketch ? { result: "written by hand; Muse read it" } : {}),
          nodes: ["goal"],
          detail: [link(e)],
        });
        break;
      case "grow": {
        for (const n of b.nodes)
          for (const p of n.params) values.set(p.name, { v: p.value, unit: p.unit });
        const checks = b.nodes.filter((n) => n.check).length;
        out.push({
          seq: e.seq,
          actor: "muse",
          stage: b.under === "goal" ? "Decomposition" : "Opened a root",
          title: `Muse grew ${String(b.nodes.length)} roots${b.under === "goal" ? "" : ` under ${title(b.under)}`}, ${String(checks)} with a check or an experiment`,
          result: b.summary.slice(0, 220),
          nodes: b.nodes.map((n) => n.id),
          detail: [
            ["Roots", b.nodes.map((n) => n.title).join("; ")],
            ["Engine", "admitted each root only if it followed the protocol"],
            ...usage(b.usage),
            link(e),
          ],
        });
        break;
      }
      case "check": {
        const spec = tree.nodes.get(b.node)?.check;
        const r = b.result;
        const verdict = "error" in r ? "could not conclude" : r.pass ? "holds" : "fails";
        const settles = tree.predictions.find((p) => p.run === e.seq);
        if (spec?.kind === "oregonator") {
          out.push({
            seq: e.seq,
            actor: "engine",
            stage: settles ? "Experiment, after the prediction" : "Experiment",
            title: `Ran the Oregonator for "${title(b.node)}"`,
            result:
              "error" in r
                ? r.error
                : `${verdict}${spec.question === "reduction_keeps_period" ? `: models differ by ${pct(r.value)} (tolerance ${pct(spec.tolerance)})` : ""}${seconds(r) ? `, ${seconds(r)}` : ""}`,
            tone: "error" in r ? "warn" : r.pass ? "ok" : "fail",
            nodes: [b.node],
            detail: [
              [
                "Inputs",
                Object.entries(r.inputs ?? {})
                  .map(([k, v]) => `${words(k)} ${num(v)}`)
                  .join(", "),
              ],
              [
                "Decided by",
                "stiff solver and the classification protocol, re-run in this browser",
              ],
              link(e),
            ],
          });
          if (settles && !("error" in r) && verdict !== settles.expect) {
            out.push({
              seq: e.seq,
              actor: "engine",
              stage: "Discrepancy",
              title: `Muse expected "${settles.expect}" (${pct(settles.confidence)}); the run ${verdict}`,
              result: "A surprise: Muse must now explain it before anything is learned.",
              tone: "fail",
              nodes: [b.node],
              detail: [["Prediction", settles.id], link(e)],
            });
          }
          break;
        }
        const line =
          "error" in r
            ? `could not evaluate: ${r.error}`
            : `${num(r.value)} ${r.op} ${num(r.limit)} ${r.unit}: ${verdict}`;
        if (batch && batch.stage === "Computation") {
          batch.nodes.push(b.node);
          batch.detail.push([title(b.node), line]);
          const fails = batch.detail.filter(([, v]) => v.endsWith("fails")).length;
          batch.title = `Computed ${String(batch.nodes.length)} checks`;
          batch.result = `${String(fails)} fail, ${String(batch.nodes.length - fails)} do not`;
          batch.tone = fails ? "fail" : "ok";
          break;
        }
        batch = {
          seq: e.seq,
          actor: "engine",
          stage: "Computation",
          title: `Computed "${title(b.node)}"`,
          result: line,
          tone: "error" in r ? "warn" : r.pass ? "ok" : "fail",
          nodes: [b.node],
          detail: [[title(b.node), line]],
        };
        out.push(batch);
        break;
      }
      case "set_param": {
        const old = values.get(b.name);
        values.set(b.name, { v: b.value, unit: old?.unit ?? "" });
        const owner = tree.owner(b.name);
        out.push({
          seq: e.seq,
          actor: "person",
          stage: "Change",
          title: `${words(b.name)}: ${old ? num(old.v) : "?"} -> ${num(b.value)} ${old?.unit ?? ""}`,
          result: Object.keys(tree.derived()).length
            ? "Everything that reads it is stale until the engine runs it again; the recipe's model parameters are re-derived."
            : "Everything that reads it is stale until the engine runs it again.",
          nodes: owner ? [owner.id] : [],
          detail: [["Source", b.source], link(e)],
        });
        break;
      }
      case "predict":
        out.push({
          seq: e.seq,
          actor: "muse",
          stage: "Prediction",
          title: `Before the run, Muse committed: it ${b.expect} (${pct(Math.min(0.99, Math.max(0.5, b.confidence)))})`,
          result: b.reason,
          nodes: [b.node],
          detail: [
            [
              "Values",
              Object.entries(b.inputs)
                .map(([k, v]) => `${words(k)} ${num(v)}`)
                .join(", "),
            ],
            ["Lessons used", b.uses.join(", ") || "none"],
            ...usage(b.usage),
            link(e),
          ],
        });
        break;
      case "hypotheses": {
        const l = tree.lessons.find((x) => x.id === b.id);
        out.push({
          seq: e.seq,
          actor: "muse",
          stage: "Hypotheses",
          title: "Two explanations, and the one run that tells them apart, written before it runs",
          result: b.candidates
            .map((c, i) => `${i ? "B" : "A"} (expects ${c.expect}): ${c.explanation}`)
            .join("\n"),
          nodes: l ? [l.node] : [],
          detail: [
            [
              "Test",
              `${words(b.test.param)} = ${num(b.test.value)} (${l?.intervention === "recipe" ? "recipe change: every model parameter follows" : l?.recipe ? "model change: no recipe is shown to realize it" : "one parameter changed"})`,
            ],
            ["Still open", b.open],
            [
              "Engine",
              "accepted them only after a contradicted prediction, with different expectations",
            ],
            ...usage(b.usage),
            link(e),
          ],
        });
        break;
      }
      case "test": {
        const l = tree.lessons.find((x) => x.id === b.hypotheses);
        const d = l ? tree.decided(l) : undefined;
        const r = b.result;
        out.push({
          seq: e.seq,
          actor: "engine",
          stage: "Test",
          title: `Ran the registered test: ${l ? `${words(l.test.param)} = ${num(l.test.value)}` : b.hypotheses}`,
          result:
            "error" in r
              ? r.error
              : `it ${r.pass ? "holds" : "fails"}${r.sim?.periods.reduced !== undefined ? ` (models differ by ${pct(r.value)})` : ""}`,
          tone: "error" in r ? "warn" : undefined,
          nodes: l ? [l.node] : [],
          detail: [link(e)],
        });
        if (l && d) {
          const kept = l.candidates[d.supported];
          out.push({
            seq: e.seq,
            actor: "engine",
            stage: "Lesson",
            title: `Consistent with ${d.supported ? "B" : "A"}, of the two considered; the other is contradicted`,
            result: kept?.explanation ?? "",
            tone: "ok",
            nodes: [l.node, ...tree.ancestors(l.node).map((a) => a.id)],
            detail: [
              ["State", tree.lessonState(l)],
              [
                "Learned at",
                Object.entries(l.basis)
                  .map(([k, v]) => `${words(k)} ${num(v)}`)
                  .join(", "),
              ],
              ["Still open", l.open],
              [
                "Rests on",
                [title(l.node), ...tree.ancestors(l.node).map((a) => a.title)].join(" <- "),
              ],
              ["Not proven", "one test separates two explanations; it does not prove a cause"],
            ],
          });
        }
        break;
      }
      case "view":
        out.push({
          seq: e.seq,
          actor: "muse",
          stage: "Drawing",
          title: `Drew the mechanism of "${title(b.node)}": ${b.title}`,
          nodes: [b.node],
          detail: [
            ["Runs", "in a sandboxed frame with no network or key"],
            ...usage(b.usage),
            link(e),
          ],
        });
        break;
      case "review":
        out.push({
          seq: e.seq,
          actor: "muse",
          stage: "Self-check (vision)",
          title: `Looked at a picture of its own drawing of "${title(b.node)}"`,
          result: b.ok ? "matches the data" : `found: ${b.problems.join("; ")}`,
          tone: b.ok ? "ok" : "warn",
          nodes: [b.node],
          detail: [["Engine", "allows one redraw at most"], ...usage(b.usage), link(e)],
        });
        break;
      case "formula":
        out.push({
          seq: e.seq,
          actor: "muse",
          stage: "Handwriting (vision)",
          title: `Read a handwritten formula for "${title(b.node)}"`,
          result: `${b.reading} -> ${b.check.value} ${b.check.op} ${b.check.limit}`,
          nodes: [b.node],
          detail: [
            ["Engine", "accepted it only in the tree's own names"],
            ...usage(b.usage),
            link(e),
          ],
        });
        break;
      case "repair":
        out.push({
          seq: e.seq,
          actor: "muse",
          stage: "Repair",
          title: `Fixed ${String(b.fixes.length)} formula(s) that did not evaluate`,
          nodes: b.fixes.map((f) => f.node),
          detail: [
            ["Engine", "accepts a misspelled name only, token for token"],
            ...usage(b.usage),
            link(e),
          ],
        });
        break;
      case "chat": {
        const c = tree.chat.find((x) => x.question === b.question && x.answer === b.answer);
        out.push({
          seq: e.seq,
          actor: "muse",
          stage: "Chat",
          title: b.question,
          result: b.answer,
          ...(c?.unsupported.length ? { tone: "warn" as const } : {}),
          nodes: b.cites,
          detail: [
            ["Numbers not in its data", c?.unsupported.join(", ") || "none"],
            ...usage(b.usage),
            link(e),
          ],
        });
        break;
      }
      case "accept":
      case "reject":
        out.push({
          seq: e.seq,
          actor: "person",
          stage: b.type === "accept" ? "Accepted" : "Rejected",
          title: title(b.node),
          nodes: [b.node],
          detail: [link(e)],
        });
        break;
    }
  }
  for (const r of tree.refused.filter((x) => x.at >= tree.events.length)) {
    out.push({
      seq: r.at,
      actor: "engine",
      stage: "Refused",
      title: r.reason,
      tone: "warn",
      nodes: [],
      detail: [
        ["What", r.what],
        ["Proposed by", r.actor],
      ],
    });
  }
  return out;
}
