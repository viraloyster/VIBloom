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
  VIEW,
  VIEW_SCHEMA,
  CHAT,
  CHAT_SCHEMA,
  estimate,
  runCheck,
  type IdeaEvent,
  type IdeaNode,
  type Mode,
  type Usage,
} from "@vibloom/ideas";
import { el } from "../dom";
import { mountChat } from "./chat";
import { mountMonitor, viewData } from "./monitor";
import { mountTreeView, type Ghost } from "./view";

const EXAMPLES = [
  "A commercial airliner made of cardboard to cut costs",
  "A tree that grows gold",
  "A chemical clock that changes colour every minute",
  "There are infinitely many twin primes",
];
const EFFORT = "low" as const;
const MAX_OUT = { decompose: 8000, expand: 5000, view: 9000, chat: 1500 };
const KEY_STORE = "vibloom.key";
const PROJECT_STORE = "vibloom.project";

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

function goalOf(events: IdeaEvent[]): string {
  const b = events[0]?.body;
  return b?.type === "goal" ? b.text.slice(0, 60) : "your last tree";
}

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
  let saved: { events: IdeaEvent[] } | undefined;
  try {
    saved = JSON.parse(localStorage.getItem(PROJECT_STORE) ?? "null") as typeof saved;
  } catch {
    saved = undefined;
  }
  const resume = saved?.events.length
    ? el("button", { class: "ghost-btn" }, `Continue: ${goalOf(saved.events)}`)
    : null;
  resume?.addEventListener("click", () => {
    if (!saved) return;
    try {
      load(saved.events);
    } catch (e) {
      note.textContent = `The saved project could not be restored: ${e instanceof Error ? e.message : String(e)}`;
    }
  });
  const file = el("input", { type: "file", accept: "application/json", hidden: true });
  const open = el("button", { class: "ghost-btn" }, "Open an exported tree");
  open.addEventListener("click", () => {
    file.click();
  });
  file.addEventListener("change", () => {
    const f = file.files?.[0];
    if (!f) return;
    void f.text().then((text) => {
      try {
        // Replay re-verifies the hash chain and every computed result.
        load((JSON.parse(text) as { events: IdeaEvent[] }).events);
      } catch (e) {
        note.textContent = `That file is not a valid tree: ${e instanceof Error ? e.message : String(e)}`;
      }
    });
  });

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
        el("img", { src: "crown.webp", alt: "", class: "hero-crown" }),
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
            "Your key stays in this tab and is sent only to api.meta.ai. Before each request the API counts its tokens and the session reserves the most it could cost; it stops at the budget.",
          ),
        ),
        note,
        el("div", { class: "row center" }, replay, resume, open, file),
      ),
    ),
  );
  goal.focus();
}

// The workspace: monitor and chat on the left, the tree on the right.
let view: ReturnType<typeof mountTreeView>;
let monitor: ReturnType<typeof mountMonitor>;
let chat: ReturnType<typeof mountChat>;
let hud: HTMLElement;
let ghosts: Ghost[] = [];
let selectedId: string | undefined;
let asking: string | undefined;

function workspace(goal: string) {
  const treeHost = el("section", { class: "tree-col", "aria-label": "Tree" });
  const monitorHost = el("section", { class: "monitor", "aria-label": "Monitor" });
  const chatHost = el("section", { class: "chat", "aria-label": "Chat" });
  hud = el("div", { class: "hud" });
  const back = el("button", { class: "ghost-btn" }, "New idea");
  back.addEventListener("click", () => {
    if (!busy) landing();
  });
  const save = el("button", { class: "ghost-btn" }, "Export");
  save.addEventListener("click", exportTree);
  app.replaceChildren(
    el(
      "main",
      { class: "workspace" },
      el(
        "div",
        { class: "left" },
        el(
          "header",
          { class: "top" },
          el("span", { class: "brand small" }, "VIBloom"),
          el("span", { class: "goal-title" }, goal),
          hud,
          save,
          back,
        ),
        monitorHost,
        chatHost,
      ),
      treeHost,
      gear(),
    ),
  );
  // A new workspace must not leave the previous tree animating behind it.
  if (typeof view !== "undefined") view.dispose();
  view = mountTreeView(treeHost, select);
  monitor = mountMonitor(monitorHost, {
    visualize: (id) => void visualize(id),
    expand: (id) => void grow(id, "expand"),
    setParam: (name, value, source) => {
      tree.append("person", { type: "set_param", name, value, source });
      recheck();
    },
    accept: (id) => {
      tree.append("person", { type: "accept", node: id });
      refresh();
    },
    reject: (id) => {
      tree.append("person", { type: "reject", node: id });
      selectedId = undefined;
      refresh();
    },
    estimate: (kind, id) =>
      kind === "view"
        ? estimate(modelFor(tree.mode), VIEW + JSON.stringify(nodeData(id)), MAX_OUT.view)
        : estimate(modelFor(tree.mode), EXPAND + tree.context(id), MAX_OUT.expand),
    busy: () => busy,
  });
  chat = mountChat(chatHost, {
    ask: (q) => void ask(q),
    select,
    busy: () => busy,
  });
  refresh();
}

// Settings stay reachable from the workspace: key, mode and budget.
function gear() {
  const b = el("button", { class: "gear", "aria-label": "Settings", title: "Settings" }, "\u2699");
  const panel = el("div", { class: "gear-panel", hidden: true });
  b.addEventListener("click", () => {
    const keyInput = el("input", {
      type: "password",
      class: "key",
      placeholder: "Meta Model API key",
      autocomplete: "off",
    });
    keyInput.value = key;
    keyInput.addEventListener("change", () => {
      key = keyInput.value.trim();
    });
    const cap = el("input", {
      type: "number",
      class: "cap",
      min: "0.05",
      step: "0.05",
      value: ledger.cap.toFixed(2),
    });
    cap.addEventListener("change", () => {
      ledger.cap = Math.max(0.05, Number(cap.value) || ledger.cap);
      refresh();
    });
    panel.replaceChildren(
      el("p", { class: "eyebrow" }, "Settings"),
      keyInput,
      el("label", { class: "cap-label" }, "Session budget $", cap),
      el(
        "p",
        { class: "fine" },
        `Mode: ${tree.mode}. The key stays in this tab and goes only to api.meta.ai.`,
      ),
    );
    panel.hidden = !panel.hidden;
  });
  return el("div", { class: "gear-wrap" }, panel, b);
}

function nodeData(id: string) {
  const n = tree.nodes.get(id);
  return n ? viewData(tree, n) : {};
}

// The project lives in this browser too, so a reload does not lose it. A
// recorded example is never saved over a person's own work.
function save() {
  if (recorded) return;
  try {
    localStorage.setItem(
      PROJECT_STORE,
      JSON.stringify({ format: "vibloom-ideas-1", events: tree.events }),
    );
  } catch {
    // Storage full or blocked: Export still works.
  }
}

function load(events: IdeaEvent[]) {
  const t = IdeaTree.replay(events);
  recorded = false;
  tree = t;
  chatUsage.length = 0;
  selectedId = undefined;
  for (const e of events) if ("usage" in e.body) ledger.entries.push(e.body.usage);
  workspace(tree.goal);
}

function refresh() {
  save();
  view.render(tree, ghosts);
  if (selectedId && !tree.nodes.has(selectedId)) selectedId = undefined;
  view.select(selectedId);
  monitor.render(tree, selectedId);
  chat.render(tree, asking, (i) => {
    const u = chatUsage[i];
    return u ? usd(u.cost) : "";
  });
  const spent = ledger.entries.reduce((s, u) => s + u.cost, 0);
  const cached = ledger.entries.reduce((s, u) => s + u.cached, 0);
  const input = ledger.entries.reduce((s, u) => s + u.input, 0);
  hud.replaceChildren(
    el(
      "span",
      { class: "spend" },
      recorded
        ? `${usd(spent)} when recorded`
        : `${usd(Math.max(spent, ledger.total))} / ${usd(ledger.cap)}`,
    ),
    el("span", {}, `${String(ledger.entries.length)} calls`),
    el("span", {}, input ? `${String(Math.round((100 * cached) / input))}% cached` : "0% cached"),
  );
}

const chatUsage: Usage[] = [];

function muse() {
  return new Muse(key ? { apiKey: key } : {}, ledger);
}

async function grow(under: string, kind: "decompose" | "expand") {
  if (busy) return;
  busy = true;
  view.busy(under);
  ghosts = [];
  monitor.status("Muse is thinking...", true);
  const first = tree.nodes.size === 1;
  if (first) view.seed("reading the goal...");
  let thought = "";
  try {
    const r = await muse().grow({
      instructions: kind === "decompose" ? DECOMPOSE : EXPAND,
      input: kind === "decompose" ? JSON.stringify({ goal: tree.goal }) : tree.context(under),
      mode: tree.mode,
      effort: EFFORT,
      maxOutput: MAX_OUT[kind],
      onThought: (t) => {
        thought = (thought + t).slice(-240);
        monitor.status(`Muse is thinking: ${thought}`, true);
        if (first && ghosts.length === 0) view.seed(thought.slice(-120));
      },
      onNode: (raw) => {
        const n = raw as { key?: unknown; title?: unknown };
        if (typeof n.key === "string" && typeof n.title === "string") {
          if (ghosts.length === 0) view.seed(undefined);
          ghosts.push({ key: n.key, under, title: n.title });
          view.render(tree, ghosts);
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
    for (const n of nodes) check(n);
    refresh();
    // Show the whole tree again with its new roots.
    view.refit();
    monitor.status(r.summary);
    await repair();
  } catch (e) {
    ghosts = [];
    monitor.status(`Stopped: ${explain(e)}`);
  } finally {
    busy = false;
    view.seed(undefined);
    view.busy(undefined);
    refresh();
  }
}

// Muse designs a visual of what a root tests; it runs in an isolated frame
// and draws only the numbers VIBloom hands it.
async function visualize(id: string) {
  if (busy) return;
  busy = true;
  refresh();
  monitor.status("Muse is designing a view...", true);
  try {
    const { value, usage } = await muse().ask(
      {
        instructions: VIEW,
        input: JSON.stringify({ data: nodeData(id) }),
        mode: tree.mode,
        effort: "low",
        maxOutput: MAX_OUT.view,
      },
      "view",
      VIEW_SCHEMA,
    );
    const v = value as { title?: unknown; html?: unknown };
    if (typeof v.html !== "string" || v.html.length > 40_000)
      throw new MuseError("bad_view", "no usable view");
    tree.append(`muse:${usage.model}`, {
      type: "view",
      node: id,
      title: typeof v.title === "string" ? v.title.slice(0, 80) : "View",
      html: v.html,
      usage,
    });
    monitor.status(`View ready (${usd(usage.cost)}).`);
  } catch (e) {
    monitor.status(`Stopped: ${explain(e)}`);
  } finally {
    busy = false;
    refresh();
  }
}

async function ask(question: string) {
  if (busy) return;
  busy = true;
  asking = question;
  refresh();
  const focus = selectedId ?? "goal";
  const asked = tree.scope();
  try {
    const { value, usage } = await muse().ask(
      {
        instructions: CHAT,
        // The selected branch in full, the rest as a one-line index, and the
        // last turns, so Muse answers about what the person is looking at.
        input: JSON.stringify({
          question,
          selected: nodeData(focus),
          branch: tree.context(focus),
          tree: [...tree.nodes.values()].map((n) => `${n.id} | ${n.title} | ${tree.status(n.id)}`),
          recent: tree.chat.slice(-4).map((c) => ({ q: c.question, a: c.answer })),
        }),
        mode: tree.mode,
        effort: "low",
        maxOutput: MAX_OUT.chat,
      },
      "chat",
      CHAT_SCHEMA,
    );
    const v = value as { answer?: unknown; cites?: unknown };
    // Only roots that exist may be cited.
    const cites = (Array.isArray(v.cites) ? v.cites : []).filter(
      (c): c is string => typeof c === "string" && tree.nodes.has(c),
    );
    tree.append(`muse:${usage.model}`, {
      type: "chat",
      focus,
      question,
      answer: typeof v.answer === "string" ? v.answer.slice(0, 1200) : "",
      cites: [...new Set(cites)].slice(0, 6),
      asked,
      usage,
    });
    chatUsage[tree.chat.length - 1] = usage;
  } catch (e) {
    monitor.status(`Stopped: ${explain(e)}`);
  } finally {
    busy = false;
    asking = undefined;
    refresh();
  }
}

function explain(e: unknown): string {
  if (e instanceof BudgetExceeded)
    return `session budget reached (${e.message}). Raise it in Settings.`;
  if (e instanceof MuseError) {
    if (e.code === "http_401" || e.code === "invalid_api_key") return "the key was rejected.";
    if (e.code === "max_output_tokens")
      return "Muse ran out of room for this answer; nothing was added.";
    return `Muse could not answer (${e.code}).`;
  }
  return e instanceof Error ? e.message : String(e);
}

// Muse fixes its own formulas that failed to evaluate: one request for all of
// them, once per growth, never in a loop.
async function repair() {
  const failing = tree.broken();
  if (failing.length === 0) return;
  monitor.status(`Muse is fixing ${String(failing.length)} formula(s)...`, true);
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
  const fixes = tree.admitFixes(
    (value as { fixes?: { id: string; value: string; limit: string }[] }).fixes ?? [],
  );
  tree.append(`muse:${usage.model}`, { type: "repair", fixes, usage });
  for (const f of fixes) {
    const n = tree.nodes.get(f.node);
    if (n) check(n);
  }
  monitor.status(`Muse repaired ${String(fixes.length)} of ${String(failing.length)} formula(s).`);
}

function check(n: IdeaNode) {
  if (!n.check) return;
  tree.append("engine", { type: "check", node: n.id, result: runCheck(n.check, tree.scope()) });
}

async function start(goal: string, mode: Mode) {
  recorded = false;
  tree = new IdeaTree();
  chatUsage.length = 0;
  tree.append("person", { type: "goal", text: goal, mode });
  selectedId = undefined;
  workspace(goal);
  await grow("goal", "decompose");
}

function select(id: string | undefined) {
  selectedId = id && tree.nodes.has(id) ? id : undefined;
  if (selectedId) view.focus(selectedId);
  refresh();
}

// After a person edits a number, every check that read it runs again.
function recheck() {
  for (const n of tree.nodes.values()) if (tree.status(n.id) === "stale") check(n);
  refresh();
}

function exportTree() {
  const blob = new Blob(
    [JSON.stringify({ format: "vibloom-ideas-1", events: tree.events }, null, 1)],
    { type: "application/json" },
  );
  const a = el("a", { href: URL.createObjectURL(blob), download: "vibloom-tree.json" });
  a.click();
}

// A recorded session replays event by event; checks are re-run here, in this
// browser, so the reds are computed now rather than shown from the recording.
async function playRecorded() {
  const res = await fetch("examples/cardboard-airliner.json");
  const data = (await res.json()) as { events: IdeaEvent[] };
  const full = IdeaTree.replay(data.events);
  recorded = true;
  tree = new IdeaTree();
  chatUsage.length = 0;
  selectedId = undefined;
  const first = data.events[0];
  if (first?.body.type !== "goal") return;
  tree.append(first.actor, first.body);
  workspace(full.goal);
  for (const e of data.events.slice(1)) {
    const b = e.body;
    if (b.type === "check") continue;
    if (b.type === "grow") {
      monitor.status(`Recorded Muse session: ${b.summary}`);
      for (const n of b.nodes) {
        ghosts.push({ key: n.id, under: b.under, title: n.title });
        view.render(tree, ghosts);
        await sleep(380);
      }
      ghosts = [];
      tree.append(e.actor, b);
      ledger.entries.push(b.usage);
      for (const n of b.nodes) check(n);
      refresh();
      await sleep(900);
    } else if (b.type === "repair") {
      tree.append(e.actor, b);
      ledger.entries.push(b.usage);
      for (const f of b.fixes) {
        const n = tree.nodes.get(f.node);
        if (n) check(n);
      }
      refresh();
    } else if (b.type === "view") {
      tree.append(e.actor, b);
      ledger.entries.push(b.usage);
      select(b.node);
      await sleep(1500);
    } else if (b.type === "chat") {
      tree.append(e.actor, b);
      ledger.entries.push(b.usage);
      chatUsage[tree.chat.length - 1] = b.usage;
      refresh();
    } else {
      tree.append(e.actor, b);
      if (b.type === "set_param") recheck();
    }
  }
  refresh();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

landing();
