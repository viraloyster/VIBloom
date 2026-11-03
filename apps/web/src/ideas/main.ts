// "What do you want to build?": Muse grows the roots of any goal, a person
// opens the ones that matter, and code checks what can be computed. The key
// stays in this tab and goes only to api.meta.ai.

import {
  BudgetExceeded,
  DECOMPOSE,
  EXPAND,
  IdeaTree,
  Ledger,
  Muse,
  MuseError,
  modelFor,
  REPAIR,
  REPAIR_SCHEMA,
  worstCase,
  type IdeaEvent,
  type IdeaNode,
  type Mode,
} from "@vibloom/ideas";
import { el } from "../dom";
import { runCheck } from "./sandbox";
import { mountTreeView, statusLabel, type Ghost } from "./view";

const EXAMPLES = [
  "A commercial airliner made of cardboard to cut costs",
  "A tree that grows gold",
  "A chemical clock that changes colour every minute",
  "There are infinitely many twin primes",
];
const EFFORT = "low" as const;
const MAX_OUT = { decompose: 8000, expand: 5000 };
const KEY_STORE = "vibloom.key";

const app = document.getElementById("app") ?? document.body;
let key = "";
try {
  key = localStorage.getItem(KEY_STORE) ?? "";
} catch {
  // Storage blocked: the key lives only in memory.
}
const ledger = new Ledger(0.5);
let tree = new IdeaTree();
let busy = false;
let recorded = false;

const usd = (x: number) => (x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(3)}`);

function landing() {
  const goal = el("textarea", {
    class: "goal-input",
    rows: 2,
    placeholder: "A cardboard airliner, a proof, a reaction, a business...",
    "aria-label": "What do you want to build?",
  });
  const keyInput = el("input", {
    type: "password",
    class: "key",
    placeholder: "Meta Model API key",
    autocomplete: "off",
    spellcheck: "false",
  });
  keyInput.value = key;
  const remember = el("input", { type: "checkbox" });
  remember.checked = key !== "";
  const mode = el(
    "select",
    { class: "mode", "aria-label": "Mode" },
    el("option", { value: "standard" }, "Standard - not used for training"),
    el("option", { value: "contributor" }, "Contributor - about 20x cheaper, Meta may train on it"),
  );
  const cap = el("input", {
    type: "number",
    class: "cap",
    min: "0.05",
    step: "0.05",
    value: "0.50",
  });
  const grow = el("button", { class: "grow" }, "Grow the roots");
  const note = el("p", { class: "note" });
  const chips = el(
    "div",
    { class: "examples" },
    ...EXAMPLES.map((t) => {
      const b = el("button", { class: "example" }, t);
      b.addEventListener("click", () => {
        goal.value = t;
        goal.focus();
      });
      return b;
    }),
  );
  const replay = el("button", { class: "ghost-btn" }, "Watch a recorded example - no key needed");
  replay.addEventListener("click", () => void playRecorded());

  grow.addEventListener("click", () => {
    const text = goal.value.trim();
    key = keyInput.value.trim();
    if (!text) {
      goal.focus();
      return;
    }
    if (!key) {
      note.textContent = "Add your Meta Model API key, or watch the recorded example.";
      return;
    }
    try {
      if (remember.checked && key) localStorage.setItem(KEY_STORE, key);
      else localStorage.removeItem(KEY_STORE);
    } catch {
      // Not remembered; fine.
    }
    ledger.cap = Math.max(0.05, Number(cap.value) || 0.5);
    void start(text, mode.value as Mode);
  });
  goal.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) grow.click();
  });

  app.replaceChildren(
    el(
      "main",
      { class: "landing" },
      el("div", { class: "aurora" }),
      el(
        "section",
        { class: "hero" },
        el("img", { src: "/crown.webp", alt: "", class: "hero-crown" }),
        el("p", { class: "brand" }, "VIBloom"),
        el("h1", {}, "What do you want to build?"),
        el(
          "p",
          { class: "lede" },
          "Muse grows the assumptions it rests on, down to first principles. Code checks what can be computed. Red means a calculation says it fails.",
        ),
        el("div", { class: "composer" }, goal, grow),
        chips,
        el(
          "details",
          { class: "settings", open: key === "" },
          el("summary", {}, "Key, mode and budget"),
          el(
            "div",
            { class: "row" },
            keyInput,
            el("label", { class: "remember" }, remember, "Remember on this device"),
          ),
          el(
            "div",
            { class: "row" },
            mode,
            el("label", { class: "cap-label" }, "Session budget $", cap),
          ),
          el(
            "p",
            { class: "fine" },
            "Your key stays in this tab and is sent only to api.meta.ai. Every request reserves its worst-case cost first; the session stops at the budget.",
          ),
        ),
        note,
        replay,
      ),
    ),
  );
  goal.focus();
}

// The workspace: tree, side panel, cost and what Muse is thinking.
let view: ReturnType<typeof mountTreeView>;
let panel: HTMLElement;
let hud: HTMLElement;
let thinking: HTMLElement;
let ghosts: Ghost[] = [];

function workspace(goal: string) {
  const host = el("div", { class: "tree-host" });
  panel = el("aside", { class: "panel", hidden: true });
  hud = el("div", { class: "hud" });
  thinking = el("div", { class: "thinking", hidden: true });
  const back = el("button", { class: "ghost-btn back" }, "New idea");
  back.addEventListener("click", () => {
    if (!busy) landing();
  });
  const save = el("button", { class: "ghost-btn" }, "Export");
  save.addEventListener("click", exportTree);
  app.replaceChildren(
    el(
      "main",
      { class: "workspace" },
      el("div", { class: "aurora dim" }),
      el(
        "header",
        { class: "top" },
        el("span", { class: "brand small" }, "VIBloom"),
        el("span", { class: "goal-title" }, goal),
        hud,
        save,
        back,
      ),
      host,
      thinking,
      legend(),
      panel,
    ),
  );
  view = mountTreeView(host, (id) => {
    select(id);
  });
  refresh();
}

function legend() {
  const items: [string, string][] = [
    ["broken", "fails a calculation"],
    ["affected", "a premise broke"],
    ["at_risk", "at risk, argued"],
    ["holds", "passes a calculation"],
    ["argued", "argued"],
    ["bedrock", "bedrock"],
  ];
  return el(
    "div",
    { class: "legend" },
    ...items.map(([c, t]) => el("span", { class: `key-item ${c}` }, el("i", {}), t)),
  );
}

function refresh() {
  view.render(tree, ghosts);
  const calls = ledger.entries.length;
  const cached = ledger.entries.reduce((s, u) => s + u.cached, 0);
  const input = ledger.entries.reduce((s, u) => s + u.input, 0);
  const spent = ledger.entries.reduce((s, u) => s + u.cost, 0);
  hud.replaceChildren(
    el(
      "span",
      { class: "spend" },
      recorded
        ? `${usd(spent)} when recorded`
        : `${usd(Math.max(spent, ledger.total))} of ${usd(ledger.cap)}`,
    ),
    el("span", {}, `${String(calls)} call${calls === 1 ? "" : "s"}`),
    el("span", {}, input ? `${String(Math.round((100 * cached) / input))}% cached` : "0% cached"),
  );
}

function muse() {
  return new Muse(key ? { apiKey: key } : {}, ledger);
}

async function grow(under: string, kind: "decompose" | "expand") {
  if (busy) return;
  busy = true;
  view.busy(under);
  ghosts = [];
  thinking.hidden = false;
  thinking.replaceChildren(el("b", {}, "Muse is thinking"), el("span", { class: "thought" }));
  const thought = thinking.querySelector(".thought");
  try {
    const r = await muse().grow({
      instructions: kind === "decompose" ? DECOMPOSE : EXPAND,
      input: kind === "decompose" ? JSON.stringify({ goal: tree.goal }) : tree.context(under),
      mode: tree.mode,
      effort: EFFORT,
      maxOutput: MAX_OUT[kind],
      onThought: (t) => {
        if (thought) thought.textContent = (thought.textContent + t).slice(-220);
      },
      onNode: (raw) => {
        const n = raw as { key?: unknown; title?: unknown };
        if (typeof n.key === "string" && typeof n.title === "string") {
          ghosts.push({ key: n.key, under, title: n.title });
          refresh();
        }
      },
    });
    ghosts = [];
    const nodes = tree.admit(under, r.nodes);
    tree.append(`muse:${r.usage.model}`, {
      type: "grow",
      under,
      nodes,
      summary: r.summary,
      usage: r.usage,
    });
    refresh();
    if (thought) thought.textContent = r.summary;
    for (const n of nodes) await check(n);
    refresh();
    await repair();
  } catch (e) {
    ghosts = [];
    refresh();
    thinking.replaceChildren(el("b", {}, "Stopped"), el("span", { class: "thought" }, explain(e)));
  } finally {
    busy = false;
    view.busy(undefined);
    if (selectedId) select(selectedId);
  }
}

function explain(e: unknown): string {
  if (e instanceof BudgetExceeded)
    return `Session budget reached: ${e.message}. Raise it from a new idea.`;
  if (e instanceof MuseError) {
    if (e.code === "http_401" || e.code === "invalid_api_key") return "The key was rejected.";
    if (e.code === "max_output_tokens")
      return "Muse ran out of room for this answer; nothing was added.";
    return `Muse could not answer (${e.code}).`;
  }
  return e instanceof Error ? e.message : String(e);
}

// Muse fixes its own calculations that failed to run: one request for all of
// them, once per growth, never in a loop.
async function repair() {
  const failing = tree.broken();
  if (failing.length === 0) return;
  thinking.replaceChildren(
    el("b", {}, "Muse is fixing its calculations"),
    el("span", { class: "thought" }, `${String(failing.length)} did not run`),
  );
  const { value, usage } = await muse().ask(
    {
      instructions: REPAIR,
      input: JSON.stringify(failing),
      mode: tree.mode,
      effort: "low",
      maxOutput: 3000,
    },
    "repair",
    REPAIR_SCHEMA,
  );
  const fixes = tree.admitFixes((value as { fixes?: { id: string; code: string }[] }).fixes ?? []);
  tree.append(`muse:${usage.model}`, { type: "repair", fixes, usage });
  for (const f of fixes) {
    const n = tree.nodes.get(f.node);
    if (n) await check(n);
  }
  refresh();
  thinking.replaceChildren(
    el("b", {}, "Muse fixed its calculations"),
    el(
      "span",
      { class: "thought" },
      `${String(fixes.length)} of ${String(failing.length)} repaired and re-run`,
    ),
  );
}

async function check(n: IdeaNode) {
  if (!n.check) return;
  const result = await runCheck(n.check.code, tree.scope(n.id));
  tree.append("engine", { type: "check", node: n.id, result });
}

async function start(goal: string, mode: Mode) {
  recorded = false;
  tree = new IdeaTree();
  tree.append("person", { type: "goal", text: goal, mode });
  selectedId = undefined;
  workspace(goal);
  await grow("goal", "decompose");
}

let selectedId: string | undefined;

function select(id: string) {
  const n = tree.nodes.get(id);
  if (!n) return;
  selectedId = id;
  view.select(id);
  view.focus(id);
  const status = tree.status(id);
  const result = tree.results.get(id);
  const assumed = tree.assumedInputs(id);
  const est = worstCase(modelFor(tree.mode), EXPAND + tree.context(id), MAX_OUT.expand);

  const params = n.params.map((p) => {
    const input = el("input", {
      type: "number",
      value: String(p.value),
      step: "any",
      "aria-label": p.name,
    });
    input.addEventListener("change", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || v === p.value) return;
      tree.append("person", { type: "set_param", node: id, name: p.name, value: v });
      void recheck();
    });
    return el(
      "tr",
      {},
      el("td", { class: "pname" }, p.name.replace(/_/g, " ")),
      el("td", {}, input),
      el("td", { class: "unit" }, p.unit),
      el(
        "td",
        {},
        el(
          "span",
          { class: `origin ${p.origin}`, title: p.source || "chosen without a named source" },
          p.origin === "reference" ? "reference" : "assumed",
        ),
      ),
    );
  });

  const expand = el(
    "button",
    { class: "primary", disabled: busy || n.expanded },
    n.expanded ? "Expanded" : "Open with Muse",
  );
  expand.title = `Reserves up to ${usd(est)}; usually much less.`;
  expand.addEventListener("click", () => void grow(id, "expand"));

  const proposal = n.proposed
    ? el(
        "div",
        { class: "row" },
        button("Accept proposal", () => {
          tree.append("person", { type: "accept", node: id });
          refresh();
          select(id);
        }),
        button("Reject", () => {
          tree.append("person", { type: "reject", node: id });
          panel.hidden = true;
          refresh();
        }),
      )
    : null;

  panel.hidden = false;
  const parts: (Node | null)[] = [
    el("button", { class: "close", "aria-label": "Close" }, "x"),
    el("p", { class: `status ${status}` }, statusLabel(status)),
    el("h2", {}, n.title),
    el("p", { class: "statement" }, n.statement),
    el(
      "div",
      { class: "tags" },
      el("span", {}, n.axis),
      el("span", {}, n.criticality),
      el("span", {}, `risk ${n.risk}`),
      el("span", {}, `${String(tree.weight(id))} above it`),
    ),
    n.rationale ? el("p", { class: "rationale" }, n.rationale) : null,
    result
      ? "error" in result
        ? el("div", { class: "result error" }, `Check could not run: ${result.error}`)
        : gauge(result.value, result.limit, result.unit, result.pass, result.detail, assumed.length)
      : n.check
        ? null
        : el(
            "p",
            { class: "fine" },
            n.role === "goal" ? "" : "No calculation: this one is argued, not computed.",
          ),
    params.length ? el("table", { class: "params" }, el("tbody", {}, ...params)) : null,
    n.check
      ? el(
          "details",
          { class: "code" },
          el("summary", {}, "Calculation written by Muse"),
          el("pre", {}, n.check.code),
        )
      : null,
    proposal,
    n.role === "goal"
      ? null
      : el("div", { class: "row" }, expand, el("span", { class: "fine" }, `up to ${usd(est)}`)),
  ];
  panel.replaceChildren(...parts.filter((x): x is Node => x !== null));
  panel.querySelector(".close")?.addEventListener("click", () => {
    panel.hidden = true;
    view.select(undefined);
    selectedId = undefined;
  });
}

function button(label: string, f: () => void) {
  const b = el("button", {}, label);
  b.addEventListener("click", f);
  return b;
}

function gauge(
  value: number,
  limit: number,
  unit: string,
  pass: boolean,
  detail: string,
  assumed: number,
) {
  const ratio = limit === 0 ? 1 : Math.abs(value / limit);
  const fill = Math.min(1, ratio / 2);
  const bar = el(
    "div",
    { class: "bar" },
    el("i", { style: `width:${String(fill * 100)}%` }),
    el("b", { style: "left:50%" }),
  );
  return el(
    "div",
    { class: `result ${pass ? "pass" : "fail"}` },
    el("p", { class: "verdict" }, pass ? "Passes the calculation" : "Fails the calculation"),
    el("p", { class: "nums" }, `${fmt(value)} vs limit ${fmt(limit)} ${unit}`),
    bar,
    el("p", { class: "fine" }, detail),
    assumed
      ? el(
          "p",
          { class: "fine warn" },
          `Rests on ${String(assumed)} assumed value${assumed === 1 ? "" : "s"}; edit them below to test another case.`,
        )
      : null,
  );
}

const fmt = (x: number) =>
  Math.abs(x) >= 1e5 || (Math.abs(x) < 1e-2 && x !== 0)
    ? x.toExponential(2)
    : String(Math.round(x * 1000) / 1000);

// After a person edits a number, every check that read it runs again.
async function recheck() {
  for (const n of tree.nodes.values()) if (tree.status(n.id) === "stale") await check(n);
  refresh();
  if (selectedId) select(selectedId);
}

function exportTree() {
  const blob = new Blob(
    [JSON.stringify({ format: "vibloom-ideas-1", events: tree.events }, null, 1)],
    {
      type: "application/json",
    },
  );
  const a = el("a", { href: URL.createObjectURL(blob), download: "vibloom-tree.json" });
  a.click();
}

// A recorded session replays event by event; checks are re-run here, in this
// browser, so the reds are computed now rather than shown from the recording.
async function playRecorded() {
  const res = await fetch("/examples/cardboard-airliner.json");
  const data = (await res.json()) as { events: IdeaEvent[] };
  const full = IdeaTree.replay(data.events);
  recorded = true;
  tree = new IdeaTree();
  const first = data.events[0];
  if (first?.body.type !== "goal") return;
  tree.append(first.actor, first.body);
  workspace(full.goal);
  for (const e of data.events.slice(1)) {
    if (e.body.type === "check") continue;
    if (e.body.type === "grow") {
      const g = e.body;
      thinking.hidden = false;
      thinking.replaceChildren(
        el("b", {}, "Recorded Muse session"),
        el("span", { class: "thought" }, g.summary),
      );
      for (const n of g.nodes) {
        ghosts.push({ key: n.id, under: g.under, title: n.title });
        refresh();
        await sleep(420);
      }
      ghosts = [];
      tree.append(e.actor, g);
      ledger.entries.push(g.usage);
      refresh();
      for (const n of g.nodes) await check(n);
      refresh();
      await sleep(900);
    } else if (e.body.type === "repair") {
      tree.append(e.actor, e.body);
      ledger.entries.push(e.body.usage);
      for (const f of e.body.fixes) {
        const n = tree.nodes.get(f.node);
        if (n) await check(n);
      }
      refresh();
    } else tree.append(e.actor, e.body);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

landing();
