// "What do you want to build?": a person, or an AI they connect, grows the
// roots of any goal; code checks what can be computed. The AI is optional and
// any provider works: the key stays in this browser and goes only to the
// provider the person chose.

import {
  BudgetExceeded,
  DECOMPOSE,
  EXPAND,
  IdeaTree,
  Ledger,
  AXES,
  Model,
  ModelError,
  PROVIDERS,
  used,
  REPAIR,
  REPAIR_SCHEMA,
  VIEW,
  VIEW_SCHEMA,
  CHAT,
  CHAT_SCHEMA,
  ROUTE,
  ROUTE_SCHEMA,
  PREDICT,
  PREDICT_SCHEMA,
  DIAGNOSE,
  DIAGNOSE_SCHEMA,
  REVIEW,
  REVIEW_SCHEMA,
  READ_SKETCH,
  READ_SKETCH_SCHEMA,
  READ_FORMULA,
  READ_FORMULA_SCHEMA,
  SIM_PARAMS,
  RECIPE_PARAMS,
  estimate,
  mapSetup,
  numbersIn,
  recipeEffects,
  runCheck,
  type IdeaEvent,
  type Refusal,
  type IdeaNode,
  type GrownNode,
  type Provider,
  type Usage,
  type RouteIntent,
} from "@vibloom/ideas";
import { RECIPE_RELATIONS, RECIPE_SOURCE } from "@vibloom/chem";
import { el } from "../dom";
import { mountChat } from "./chat";
import { simulate } from "./chem";
import { mountMonitor, viewData } from "./monitor";
import { openPad } from "./pad";
import { steps } from "./process";
import { mountTreeView, type Ghost } from "./view";

// The domain whose experiments the engine can run today.
const SPECIALISATION =
  "chemistry - oscillating reactions (Belousov-Zhabotinsky, Oregonator model, stiff solver)";

const EXAMPLES = [
  "A BZ oscillator with a 60 s period, predicted by the two-variable model",
  "A commercial airliner made of cardboard to cut costs",
  "A tree that grows gold",
  "There are infinitely many twin primes",
];
const MAX_OUT = {
  decompose: 8000,
  expand: 5000,
  view: 9000,
  // Models that reason before answering need room; 1500 left a third unfinished.
  chat: 4000,
  route: 3000,
  review: 3000,
  read: 4000,
};
const AI_STORE = "vibloom.ai";
const PROJECT_STORE = "vibloom.project";

const app = document.getElementById("app") ?? document.body;
// The AI connection. Without a model the app works by hand: same engine,
// same checks, same log.
interface AiSettings {
  provider: Provider;
  model: string;
  key: string;
  baseUrl: string;
  remember: boolean;
}
let ai_: AiSettings = { provider: "anthropic", model: "", key: "", baseUrl: "", remember: false };
try {
  const raw = localStorage.getItem(AI_STORE);
  if (raw) ai_ = { ...ai_, ...(JSON.parse(raw) as Partial<AiSettings>) };
} catch {
  // Storage blocked: settings live only in memory.
}
function saveAi() {
  try {
    // The key is stored only when the person asks; the rest always.
    localStorage.setItem(AI_STORE, JSON.stringify({ ...ai_, key: ai_.remember ? ai_.key : "" }));
  } catch {
    // Not remembered; fine.
  }
}
const hasAi = () => ai_.model.trim() !== "" && (ai_.key.trim() !== "" || ai_.provider === "local");
const ledger = new Ledger(1_000_000);
let tree = new IdeaTree();
let busy = false;
let recorded = false;

const tok = (x: number) =>
  x >= 1e6
    ? `${(x / 1e6).toFixed(2)}M tokens`
    : x >= 1e3
      ? `${(x / 1e3).toFixed(1)}k tokens`
      : `${String(x)} tokens`;

// A project's name in the header: its first sentence, cut at a word. The
// whole question stays in the tooltip and on the goal root.
function shortTitle(goal: string): string {
  // A sentence ends at a stop followed by a space or the end, not at 0.06.
  const first = (goal.split(/[.?!](?=\s|$)|\n/)[0] ?? goal).trim();
  if (first.length <= 44) return first;
  return `${first.slice(0, 42).replace(/\s+\S*$/, "")}...`;
}

function goalOf(events: IdeaEvent[]): string {
  const b = events[0]?.body;
  return b?.type === "goal" ? b.text.slice(0, 60) : "your last tree";
}

// The AI connection, shared by the landing page and the settings panel.
function aiSettings(onChange: () => void): HTMLElement {
  const provider = el(
    "select",
    { class: "mode", "aria-label": "Provider" },
    ...Object.entries(PROVIDERS).map(([id, p]) => el("option", { value: id }, p.label)),
  );
  provider.value = ai_.provider;
  const model = el("input", {
    class: "key",
    placeholder: "Model name, for example claude-sonnet-5-5",
    spellcheck: "false",
  });
  model.value = ai_.model;
  const keyInput = el("input", {
    type: "password",
    class: "key",
    placeholder: "API key (not needed for a local model)",
    autocomplete: "off",
    spellcheck: "false",
  });
  keyInput.value = ai_.key;
  const base = el("input", {
    class: "key",
    placeholder: "Base URL (optional)",
    spellcheck: "false",
  });
  base.value = ai_.baseUrl;
  const remember = el("input", { type: "checkbox" });
  remember.checked = ai_.remember;
  const cap = el("input", {
    type: "number",
    class: "cap",
    min: "10000",
    step: "50000",
    value: String(ledger.cap),
  });
  const update = () => {
    const changed = provider.value !== ai_.provider;
    ai_ = {
      provider: provider.value as Provider,
      model: model.value.trim(),
      key: keyInput.value.trim(),
      baseUrl: base.value.trim(),
      remember: remember.checked,
    };
    if (changed && !model.value.trim()) model.value = PROVIDERS[ai_.provider].model;
    ai_.model = model.value.trim();
    ledger.cap = Math.max(10_000, Number(cap.value) || ledger.cap);
    saveAi();
    onChange();
  };
  for (const x of [provider, model, keyInput, base, remember, cap])
    x.addEventListener("change", update);
  return el(
    "div",
    {},
    el("div", { class: "row" }, provider, model),
    el("div", { class: "row" }, keyInput, base),
    el(
      "div",
      { class: "row" },
      el("label", { class: "remember" }, remember, "Remember the key on this device"),
      el("label", { class: "cap-label" }, "Session budget, tokens", cap),
    ),
    el(
      "p",
      { class: "fine" },
      "Optional. Without an AI you build the roots and make the predictions yourself; the engine, the checks and the record are the same. The key stays in this browser and is sent only to the provider you choose.",
    ),
  );
}

function landing() {
  const goal = el("textarea", {
    class: "goal-input",
    rows: 2,
    placeholder: "A cardboard airliner, a proof, a reaction, a business...",
    "aria-label": "What do you want to build?",
  });
  const grow = el("button", { class: "grow" });
  const sketch = el(
    "button",
    { class: "sketch", title: "Write or sketch it by hand, or use a photo of paper" },
    "Write it by hand",
  );
  const note = el("p", { class: "note" });
  const label = () => {
    grow.textContent = hasAi() ? "Grow the roots" : "Start by hand";
    sketch.hidden = !hasAi();
  };
  label();
  // The handwriting the goal was read from, kept with it in the record.
  let sketched: string | undefined;
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
  let saved: { events: IdeaEvent[]; refused?: Refusal[] } | undefined;
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
      load(saved.events, saved.refused);
    } catch (e) {
      note.textContent = `The saved project could not be restored: ${e instanceof Error ? e.message : String(e)}`;
    }
  });
  const file = el("input", { type: "file", accept: "application/json", hidden: true });
  const open = el("button", { class: "ghost-btn" }, "Open an exported tree");
  const replayFile = el("button", { class: "ghost-btn" }, "Replay one step by step");
  let replaying = false;
  open.addEventListener("click", () => {
    replaying = false;
    file.click();
  });
  replayFile.addEventListener("click", () => {
    replaying = true;
    file.click();
  });
  file.addEventListener("change", () => {
    const f = file.files?.[0];
    if (!f) return;
    void f.text().then((text) => {
      try {
        // Replay re-verifies the hash chain and every computed result.
        const data = JSON.parse(text) as { events: IdeaEvent[]; refused?: Refusal[] };
        if (replaying) void replayLog(data);
        else load(data.events, data.refused);
      } catch (e) {
        note.textContent = `That file is not a valid tree: ${e instanceof Error ? e.message : String(e)}`;
      }
    });
  });

  grow.addEventListener("click", () => {
    const text = goal.value.trim();
    if (!text) {
      goal.focus();
      return;
    }
    void start(text, sketched);
  });
  goal.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) grow.click();
  });
  // An AI reads handwriting (words, sketches, formulas) into the goal; the
  // person reads the transcription before anything grows from it.
  sketch.addEventListener("click", () => {
    openPad({
      title: "Write or sketch your idea",
      hint: "Words, a drawing, formulas or functions. The AI transcribes it; you check it before growing.",
      action: "Read it with the AI",
      onRead: async (image) => {
        const { value, usage } = await ai().ask(
          {
            instructions: READ_SKETCH,
            input: "Transcribe this.",
            images: [image],
            maxOutput: MAX_OUT.read,
          },
          "sketch",
          READ_SKETCH_SCHEMA,
        );
        const v = value as {
          goal: string;
          formulas: { written: string; meaning: string }[];
          unclear: string;
        };
        goal.value = [
          v.goal,
          ...v.formulas.map((x) => `${x.written}${x.meaning ? ` (${x.meaning})` : ""}`),
        ]
          .join("\n")
          .slice(0, 1200);
        sketched = image;
        note.textContent = `The AI read your handwriting (${tok(used(usage))})${v.unclear ? `; unclear: ${v.unclear}` : ""}. Check it, then grow the roots.`;
        goal.focus();
      },
    });
  });

  app.replaceChildren(
    el(
      "main",
      { class: "landing" },
      el("div", { class: "aurora" }),
      el(
        "section",
        { class: "hero" },
        el("p", { class: "brand" }, "VIBloom"),
        el("h1", {}, "What do you want to build?"),
        el(
          "p",
          { class: "specialisation" },
          el("span", {}, "Specialisation:"),
          ` ${SPECIALISATION}`,
        ),
        el(
          "p",
          { class: "lede" },
          "Every goal rests on assumptions. Map them, down to first principles; code checks what can be computed, and a red root means a calculation says it fails.",
        ),
        el(
          "div",
          { class: "composer" },
          goal,
          el("div", { class: "composer-actions" }, sketch, grow),
        ),
        chips,
        el(
          "details",
          { class: "settings", open: !hasAi() },
          el("summary", {}, "AI (optional)"),
          aiSettings(label),
        ),
        note,
        el("div", { class: "row center" }, resume, open, replayFile, file),
      ),
    ),
  );
  goal.focus();
}

// The workspace: monitor and chat on the left, the tree on the right.
let view: ReturnType<typeof mountTreeView>;
let monitor: ReturnType<typeof mountMonitor>;
let chat: ReturnType<typeof mountChat>;
let chatHost: HTMLElement;
let hud: HTMLElement;
let ghosts: Ghost[] = [];
let selectedId: string | undefined;
let asking: string | undefined;
// The process view replaces the monitor's root view while open.
let processOpen = false;
// A recorded session is replaying: its steps appear in the process view.
let playing = false;
let processButton: HTMLButtonElement;

function workspace(goal: string) {
  const treeHost = el("section", { class: "tree-col", "aria-label": "Tree" });
  const monitorHost = el("section", { class: "monitor", "aria-label": "Monitor" });
  chatHost = el("section", { class: "chat", "aria-label": "Chat" });
  hud = el("div", { class: "hud" });
  const back = el("button", { class: "ghost-btn" }, "New idea");
  back.addEventListener("click", () => {
    if (busy) return;
    stopPlayback();
    landing();
  });
  const exportBtn = el("button", { class: "ghost-btn" }, "Export");
  exportBtn.addEventListener("click", exportTree);
  processButton = el("button", { class: "ghost-btn process-btn" }, "Process");
  processButton.addEventListener("click", () => {
    processOpen = !processOpen;
    refresh();
  });
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
          el("span", { class: "goal-title", title: goal }, shortTitle(goal)),
          hud,
          processButton,
          exportBtn,
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
    handwrite: (id) => {
      handwrite(id);
    },
    investigate: (id) => void investigate(id),
    expand: (id) => void grow(id, "expand"),
    setParam: (name, value, source) => {
      tree.append("person", { type: "set_param", name, value, source });
      recheck();
    },
    // A recipe chosen from the map: the person's change, then the engine's
    // run that the map computed for it, kept as evidence.
    useRecipe: (recipe, run) => {
      if (busy) return;
      for (const [name, value] of Object.entries(recipe)) {
        if (tree.scope()[name] !== value)
          tree.append("person", { type: "set_param", name, value, source: "recipe map" });
      }
      const setup = mapSetup(tree);
      if (typeof setup !== "string") {
        try {
          const seq = tree.append("engine", {
            type: "check",
            node: setup.node.id,
            result: run,
            via: "map",
          }).seq;
          tree.confirm(seq, run);
        } catch (e) {
          monitor.status(`The map's run was not kept: ${explain(e)}`);
        }
      }
      recheck();
    },
    // A finished map, once per identical result; a replay in progress owns
    // the log, so nothing is added while it plays.
    recordMap: (body) => {
      if (playing) return;
      const same = JSON.stringify(body);
      if (tree.events.some((e) => e.body.type === "map" && JSON.stringify(e.body) === same)) return;
      tree.append("engine", body);
      save();
      if (processOpen) refresh();
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
        ? estimate(VIEW + JSON.stringify(nodeData(id)), MAX_OUT.view)
        : estimate(EXPAND + tree.context(id), MAX_OUT.expand),
    ai: hasAi,
    addRoot: (id) => {
      addByHand(id);
    },
    busy: () => busy,
  });
  chat = mountChat(chatHost, {
    ask: (q) => void ask(q),
    select,
    busy: () => busy,
  });
  refresh();
}

// Settings stay reachable from the workspace.
function gear() {
  const b = el("button", { class: "gear", "aria-label": "Settings", title: "Settings" }, "\u2699");
  const panel = el("div", { class: "gear-panel", hidden: true });
  b.addEventListener("click", () => {
    panel.replaceChildren(el("p", { class: "eyebrow" }, "AI (optional)"), aiSettings(refresh));
    panel.hidden = !panel.hidden;
  });
  return el("div", { class: "gear-wrap" }, panel, b);
}

function nodeData(id: string) {
  const n = tree.nodes.get(id);
  return n ? { ...viewData(tree, n), lessons: tree.lessonsForModel(id) } : {};
}

// The project lives in this browser too, so a reload does not lose it. A
// recorded example is never saved over a person's own work.
function save() {
  if (recorded) return;
  try {
    localStorage.setItem(
      PROJECT_STORE,
      JSON.stringify({ format: "vibloom-ideas-1", events: tree.events, refused: tree.refused }),
    );
  } catch {
    // Storage full or blocked: Export still works.
  }
}

function load(events: IdeaEvent[], refused: Refusal[] = []) {
  const t = IdeaTree.replay(events);
  stopPlayback();
  // The audit of refusals travels beside the log; it changes no state.
  t.refused.push(...refused.filter((r) => typeof r.reason === "string"));
  recorded = false;
  tree = t;
  chatUsage.length = 0;
  selectedId = undefined;
  workspace(tree.goal);
  void confirmExperiments();
}

function refresh() {
  save();
  view.render(tree, ghosts);
  if (selectedId && !tree.nodes.has(selectedId)) selectedId = undefined;
  view.select(selectedId);
  processButton.classList.toggle("on", processOpen);
  if (processOpen) {
    monitor.process(
      steps(tree),
      (ids) => {
        view.mark(ids);
      },
      { recorded, playing, paused: player.paused, ...playback },
    );
  } else {
    view.mark([]);
    monitor.render(tree, selectedId);
  }
  // The chat needs an AI; a tree that already holds one stays readable.
  chatHost.hidden = !hasAi() && tree.chat.length === 0;
  chat.render(
    tree,
    asking,
    (i) => {
      const u = chatUsage[i];
      return u ? tok(used(u)) : "";
    },
    selectedId ?? "goal",
  );
  // A recording shows what it cost when it was made; it calls nobody now.
  // Otherwise the meter is this tab's real spend against its budget.
  const calls = recorded
    ? tree.events.flatMap((e) => ("usage" in e.body ? [e.body.usage] : []))
    : ledger.entries;
  const spent = calls.reduce((s, u) => s + used(u), 0);
  const cached = calls.reduce((s, u) => s + u.cached, 0);
  const input = calls.reduce((s, u) => s + u.input, 0);
  hud.replaceChildren(
    el(
      "span",
      { class: "spend" },
      recorded
        ? `${tok(spent)} when recorded`
        : hasAi()
          ? `${tok(ledger.total)} of ${tok(ledger.cap)}`
          : "No AI: working by hand",
    ),
    el("span", {}, `${String(calls.length)} ${recorded ? "recorded calls" : "calls"}`),
    el("span", {}, input ? `${String(Math.round((100 * cached) / input))}% cached` : "0% cached"),
  );
}

const chatUsage: Usage[] = [];

function ai() {
  return new Model(
    {
      provider: ai_.provider,
      model: ai_.model,
      ...(ai_.key ? { apiKey: ai_.key } : {}),
      ...(ai_.baseUrl ? { baseUrl: ai_.baseUrl } : {}),
    },
    ledger,
  );
}

async function grow(under: string, kind: "decompose" | "expand") {
  if (busy) return;
  busy = true;
  view.busy(under);
  ghosts = [];
  monitor.status("The AI is thinking...", true);
  const first = tree.nodes.size === 1;
  if (first) view.seed("reading the goal...");
  try {
    const r = await ai().grow({
      instructions: kind === "decompose" ? DECOMPOSE : EXPAND,
      input: kind === "decompose" ? JSON.stringify({ goal: tree.goal }) : tree.context(under),
      maxOutput: MAX_OUT[kind],
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
    tree.append(`ai:${r.usage.model}`, {
      type: "grow",
      under,
      nodes,
      summary: r.summary,
      usage: r.usage,
    });
    for (const n of nodes) await check(n);
    // The camera follows new roots only while the person has not framed it.
    refresh();
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

// The AI designs a visual of what a root tests; it runs in an isolated frame
// and draws only the numbers VIBloom hands it.
async function visualize(id: string) {
  if (busy) return;
  busy = true;
  refresh();
  try {
    let feedback: string[] = [];
    // One drawing, the AI looks at it, and at most one redraw: never a loop.
    for (let attempt = 0; attempt < 2; attempt++) {
      monitor.status(
        attempt ? "The AI is redrawing what it found wrong..." : "The AI is designing a view...",
        true,
      );
      const { value, usage } = await ai().ask(
        {
          instructions: VIEW,
          input: JSON.stringify({
            data: nodeData(id),
            ...(feedback.length ? { fix_what_you_saw: feedback } : {}),
          }),
          maxOutput: MAX_OUT.view,
        },
        "view",
        VIEW_SCHEMA,
      );
      const v = value as { title?: unknown; html?: unknown };
      if (typeof v.html !== "string" || v.html.length > 40_000)
        throw new ModelError("bad_view", "no usable view");
      tree.append(`ai:${usage.model}`, {
        type: "view",
        node: id,
        title: typeof v.title === "string" ? v.title.slice(0, 80) : "View",
        html: v.html,
        usage,
      });
      refresh();
      feedback = await review(id);
      if (!feedback.length) break;
    }
    monitor.status("");
  } catch (e) {
    monitor.status(`Stopped: ${explain(e)}`);
  } finally {
    busy = false;
    refresh();
  }
}

// The AI looks at a picture of the monitor, as the person sees it, and says
// whether its drawing matches the data. Returns what it found wrong.
async function review(id: string): Promise<string[]> {
  monitor.status("The AI is looking at its drawing...", true);
  // Let the frame load and the drawing settle before the picture.
  await sleep(2500);
  const image = await monitor.snapshot();
  if (!image) return [];
  const { value, usage } = await ai().ask(
    {
      instructions: REVIEW,
      input: JSON.stringify({ data: nodeData(id) }),
      images: [image],
      maxOutput: MAX_OUT.review,
    },
    "review",
    REVIEW_SCHEMA,
  );
  const v = value as { ok: boolean; problems: string[] };
  tree.append(`ai:${usage.model}`, {
    type: "review",
    node: id,
    ok: v.ok,
    problems: v.ok ? [] : v.problems,
    usage,
  });
  refresh();
  return v.ok ? [] : v.problems.slice(0, 3);
}

// A formula written by hand on a root: The AI reads it into the tree's names,
// the person confirms the reading, and the engine decides if it computes.
function handwrite(id: string) {
  const n = tree.nodes.get(id);
  if (!n || busy) return;
  const params = Object.keys(tree.scope()).map((name) => {
    const p = tree.param(name);
    return `${name}${p ? ` (${p.unit || "no unit"})` : ""}`;
  });
  openPad({
    title: `A formula for "${n.title}"`,
    hint: "Write the comparison that would make this assumption hold, with symbols or words. The AI maps it to the tree's parameters; the engine computes it.",
    action: "Read it with the AI",
    onRead: async (image) => {
      busy = true;
      refresh();
      try {
        const { value, usage } = await ai().ask(
          {
            instructions: READ_FORMULA,
            input: JSON.stringify({ assumption: n.statement, parameters: params }),
            images: [image],
            maxOutput: MAX_OUT.read,
          },
          "formula",
          READ_FORMULA_SCHEMA,
        );
        const v = value as {
          reading: string;
          value: string;
          op: string;
          limit: string;
          unit: string;
          unmatched: string[];
        };
        if (v.unmatched.length) {
          throw new Error(
            `The AI read "${v.reading}" but found no parameter for ${v.unmatched.join(", ")}. Nothing was changed.`,
          );
        }
        const ok = confirm(
          `The AI read: ${v.reading}\n\nAs a check: ${v.value} ${v.op} ${v.limit} ${v.unit}\n\nUse it for this root?`,
        );
        if (!ok) return;
        tree.append(`ai:${usage.model}`, {
          type: "formula",
          node: id,
          reading: v.reading.slice(0, 300),
          image,
          check: { value: v.value, op: v.op, limit: v.limit, unit: v.unit },
          usage,
        });
        const node = tree.nodes.get(id);
        if (node) await check(node);
        recheck();
        monitor.status(`Your formula is now this root's check (read for ${tok(used(usage))}).`);
      } finally {
        busy = false;
        refresh();
      }
    },
  });
}

// Everything typed in the chat is read by the AI first, as JSON: what it is
// asking for and which roots it needs. The engine checks every id and value,
// then the request goes where it belongs: an answer from the record, a recipe
// run the person confirms, or the recipe map.
async function ask(question: string) {
  if (busy) return;
  busy = true;
  asking = question;
  refresh();
  const focus = selectedId ?? "goal";
  try {
    monitor.status("The AI is reading the request...", true);
    const route = await routeOf(question, focus);
    if (route?.intent === "map") {
      const setup = mapSetup(tree);
      if (typeof setup !== "string") {
        select(setup.node.id);
        openTab("Recipe map");
        monitor.status(`The AI: ${route.why} The engine is running the recipe map.`);
        return;
      }
    }
    if (route?.intent === "run" && Object.keys(route.values).length) {
      const list = Object.entries(route.values)
        .map(([k, v]) => `${k.replace(/_/g, " ")} ${String(v)}`)
        .join(", ");
      if (
        confirm(`The AI read this as: run ${list}.\n\n${route.why}\n\nChange the tree and run it?`)
      ) {
        for (const [name, value] of Object.entries(route.values))
          if (tree.scope()[name] !== value)
            tree.append("person", {
              type: "set_param",
              name,
              value,
              source: "chat, read by the AI",
            });
        await recheckAndWait();
      }
    }
    await answer(question, focus, route?.nodes ?? []);
  } catch (e) {
    monitor.status(`Stopped: ${explain(e)}`);
  } finally {
    busy = false;
    asking = undefined;
    refresh();
  }
}

function openTab(name: string) {
  const b = [...document.querySelectorAll<HTMLButtonElement>("button.tab")].find(
    (x) => x.textContent === name,
  );
  b?.click();
}

// The first, cheap read. A failed read is not fatal: the answer still gets
// the selected root and every run.
async function routeOf(question: string, focus: string) {
  const params = Object.keys(tree.scope()).filter((k) => tree.param(k));
  try {
    const { value, usage } = await ai().ask(
      {
        instructions: ROUTE,
        input: JSON.stringify({
          request: question,
          selected: focus,
          roots: [...tree.nodes.values()].map(
            (n) =>
              `${n.id} | ${n.title} | ${tree.status(n.id)} | runs ${String(tree.runs.filter((r) => r.node === n.id).length)}`,
          ),
          runs: tree.runs.map(
            (r) =>
              `#${String(r.seq)} ${r.node} ${r.purpose} ${RECIPE_PARAMS.map((k) => `${k}=${String(r.recipe?.[k] ?? "-")}`).join(" ")} ${"error" in r.result ? r.result.error : r.result.pass ? "holds" : "fails"}`,
          ),
          params,
        }),
        maxOutput: MAX_OUT.route,
      },
      "route",
      ROUTE_SCHEMA,
    );
    const v = value as {
      intent: RouteIntent;
      nodes: string[];
      values: { name: string; value: number }[];
      why: string;
    };
    // What the engine keeps: known ids, named parameters, positive values.
    const nodes = [...new Set(v.nodes)]
      .filter((id) => tree.nodes.has(id) && id !== focus)
      .slice(0, 4);
    const values = Object.fromEntries(
      v.values
        .filter((x) => params.includes(x.name) && Number.isFinite(x.value) && x.value > 0)
        .map((x) => [x.name, x.value]),
    );
    const body = {
      type: "route" as const,
      question,
      focus,
      intent: ["answer", "run", "map"].includes(v.intent) ? v.intent : "answer",
      nodes,
      values,
      why: v.why.slice(0, 240),
      usage,
    };
    tree.append(`ai:${usage.model}`, body);
    return body;
  } catch (e) {
    if (e instanceof BudgetExceeded) throw e;
    return undefined;
  }
}

async function answer(question: string, focus: string, routed: string[]) {
  const asked = tree.scope();
  // Roots whose runs were at values the question names are consulted too,
  // whatever the read chose: evidence is never left out by a routing miss.
  const said = numbersIn(question).map((x) => x.value);
  const named = tree.runs
    .filter((r) => RECIPE_PARAMS.some((k) => said.includes(r.recipe?.[k] ?? NaN)))
    .map((r) => r.node);
  const consulted = [...new Set([...routed, ...named])]
    .filter((id) => id !== focus && tree.nodes.has(id))
    .slice(0, 5);
  monitor.status(
    consulted.length
      ? `The AI is answering from ${[focus, ...consulted].map((id) => tree.nodes.get(id)?.title ?? id).join(", ")}...`
      : "The AI is answering...",
    true,
  );
  // The AI sees the monitor as the person does when it shows its drawing.
  const image = tree.views.has(focus) ? await monitor.snapshot() : undefined;
  const brief = (id: string) => ({
    id,
    ...nodeData(id),
    ...(tree.staleText(id).length ? { written_for: tree.staleText(id) } : {}),
  });
  const { value, usage } = await ai().ask(
    {
      instructions: CHAT,
      input: JSON.stringify({
        question,
        selected: brief(focus),
        branch: tree.context(focus),
        branches: consulted.map(brief),
        tree: [...tree.nodes.values()].map((n) => `${n.id} | ${n.title} | ${tree.status(n.id)}`),
        recent: tree.chat.slice(-4).map((c) => ({ q: c.question, a: c.answer })),
        // The runs of the roots this answer is about and of the values the
        // question names first, then recent ones; omitted says how many
        // were left out, so absence is never read as evidence.
        ...(() => {
          const x = tree.runIndex([focus, ...consulted], question);
          return {
            runs: x.runs,
            runs_not_shown: x.omitted,
            ...(x.named_values_found === undefined
              ? {}
              : { a_run_at_a_value_the_question_names: x.named_values_found }),
          };
        })(),
        ...recipeContext(),
        ...(image ? { image: "what the monitor shows the person right now" } : {}),
      }),
      ...(image ? { images: [image] } : {}),
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
  tree.append(`ai:${usage.model}`, {
    type: "chat",
    focus,
    question,
    answer: typeof v.answer === "string" ? v.answer.slice(0, 1200) : "",
    cites: [...new Set(cites)].slice(0, 6),
    asked,
    consulted,
    usage,
  });
  chatUsage[tree.chat.length - 1] = usage;
  monitor.status("");
}

// When the tree holds a recipe, what the engine knows about how it sets the
// model, so the AI can reason about which change does what.
function recipeContext() {
  const derived = tree.derived();
  const scope = tree.scope();
  const recipe = Object.fromEntries(RECIPE_PARAMS.map((k) => [k, scope[k] ?? NaN]));
  return Object.keys(derived).length
    ? {
        recipe_model: {
          recipe_now: recipe,
          derived,
          // Computed by the engine: state directions from this, not memory.
          effects: recipeEffects(scope),
          relations: RECIPE_RELATIONS,
          source: RECIPE_SOURCE,
        },
      }
    : {};
}

function explain(e: unknown): string {
  if (e instanceof BudgetExceeded)
    return `session budget reached (${e.message}). Raise it in Settings.`;
  if (e instanceof ModelError) {
    if (e.code === "rejected_401" || e.code === "rejected_403")
      return "the provider rejected the key.";
    if (e.code === "length") return "the AI ran out of room for this answer; nothing was added.";
    if (e.code === "no_model") return "choose a model in Settings.";
    return `the AI could not answer (${e.code}: ${e.message.slice(0, 120)}).`;
  }
  return e instanceof Error ? e.message : String(e);
}

// The anticipation loop, around every experiment while the AI is connected:
// The AI commits to an outcome before the run, the engine runs, and a surprise
// makes the AI propose two explanations that one more run tells apart. The
// engine decides which one the evidence fits.
async function experiment(n: IdeaNode) {
  const spec = n.check;
  if (spec?.kind !== "oregonator") return;
  const t = tree;
  const scope = t.scope();
  const inputs = Object.fromEntries(SIM_PARAMS.map((k) => [k, scope[k] ?? NaN]));
  let made: { id: string; expect: "holds" | "fails"; by?: "person" } | undefined;
  // A question already settled at these values (by the recipe map, a test
  // or another node) is run without asking the AI: it could not be blind.
  const settled = t.settledBy(n.id, inputs);
  if (!recorded && !settled) {
    try {
      made = hasAi() ? await foresee(n, inputs) : foreseeByHand(n, inputs);
    } catch (e) {
      // No prediction (budget, network): the run still happens, unscored.
      monitor.status(`Running without a prediction: ${explain(e)}`);
    }
    if (tree !== t) return;
  }
  monitor.status(
    made
      ? `${made.by === "person" ? "You predict" : "The AI predicts"} ${n.title} ${made.expect}. Running the experiment...`
      : settled
        ? `Running ${n.title}; its outcome is already settled by ${settled.purpose === "map" ? "the recipe map" : "run"} #${String(settled.seq)}, so the AI is not asked to predict it.`
        : `Running the Oregonator experiment for ${n.title}...`,
    true,
  );
  const result = await simulate(spec, scope);
  // The project changed while this ran: the result belongs to another tree.
  if (tree !== t) return;
  const run = t.append("engine", { type: "check", node: n.id, result });
  t.confirm(run.seq, result);
  refresh();
  if (!made || "error" in result) {
    monitor.status(
      "error" in result
        ? `The experiment could not conclude: ${result.error}`
        : `Experiment done for ${n.title}.`,
    );
    return;
  }
  const observed = result.pass ? "holds" : "fails";
  if (observed === made.expect) {
    monitor.status(
      `As ${made.by === "person" ? "you" : "the AI"} predicted, ${n.title} ${observed}.`,
    );
    return;
  }
  // Explaining a surprise is a proposal; without an AI the person writes it
  // next to the run, and the record keeps both.
  if (!hasAi()) {
    monitor.status(
      `Surprise: you expected ${made.expect}, the run ${observed}. That gap is the lesson: change one value and run again to find out why.`,
    );
    return;
  }
  try {
    await learn(n, made.id, inputs, result);
  } catch (e) {
    monitor.status(`Stopped: ${explain(e)}`);
  }
}

async function foresee(n: IdeaNode, inputs: Record<string, number>) {
  const spec = n.check;
  if (spec?.kind !== "oregonator") return undefined;
  monitor.status(`The AI is predicting ${n.title} before the run...`, true);
  const pr = await ai().ask(
    {
      instructions: PREDICT,
      // Never a result: only the claim, its question and the values.
      input: JSON.stringify({
        assumption: n.statement,
        question: spec.question,
        tolerance: spec.tolerance,
        values: inputs,
        lessons: tree.lessonsForModel(n.id),
        // The recipe these values come from, so the reasoning is about it.
        ...recipeContext(),
      }),
      maxOutput: 4000,
    },
    "prediction",
    PREDICT_SCHEMA,
  );
  const pv = pr.value as {
    expect: "holds" | "fails";
    confidence: number;
    reason: string;
    uses: string[];
  };
  const id = `p${String(tree.predictions.length + 1)}`;
  tree.append(`ai:${pr.usage.model}`, {
    type: "predict",
    id,
    node: n.id,
    inputs,
    expect: pv.expect,
    confidence: pv.confidence,
    reason: pv.reason,
    uses: pv.uses,
    usage: pr.usage,
  });
  refresh();
  return { id, expect: pv.expect, confidence: pv.confidence, reason: pv.reason };
}

async function learn(
  n: IdeaNode,
  pid: string,
  inputs: Record<string, number>,
  result: Exclude<Awaited<ReturnType<typeof simulate>>, { error: string }>,
) {
  const spec = n.check;
  const p = tree.predictions.find((x) => x.id === pid);
  if (spec?.kind !== "oregonator" || !p) return;
  const t = tree;
  const observed = result.pass ? "holds" : "fails";
  monitor.status(
    `Surprise: The AI expected ${p.expect}, the run ${observed}. The AI is proposing explanations...`,
    true,
  );
  const dg = await ai().ask(
    {
      instructions: DIAGNOSE,
      input: JSON.stringify({
        assumption: n.statement,
        question: spec.question,
        tolerance: spec.tolerance,
        values: inputs,
        predicted: { expect: p.expect, confidence: p.confidence, reason: p.reason },
        observed,
        measured: {
          ...result.sim?.periods,
          relative_difference: result.value,
          definition: "|full - reduced| / reduced",
        },
        ...recipeContext(),
        lessons: tree.lessonsForModel(n.id),
      }),
      maxOutput: 8000,
    },
    "diagnosis",
    DIAGNOSE_SCHEMA,
  );
  if (tree !== t) return;
  const dv = dg.value as {
    candidates: { explanation: string; scope: string; expect: "holds" | "fails" }[];
    test: { param: string; value: number };
    open: string;
  };
  // The explanations go into the log before their test runs.
  const hid = `lesson-${String(tree.lessons.length + 1)}`;
  tree.append(`ai:${dg.usage.model}`, {
    type: "hypotheses",
    id: hid,
    prediction: pid,
    candidates: dv.candidates.slice(0, 2),
    test: dv.test,
    open: dv.open,
    usage: dg.usage,
  });
  refresh();
  monitor.status(
    `Testing ${dv.test.param} = ${String(dv.test.value)} to tell the explanations apart...`,
    true,
  );
  const lesson = tree.lessons.find((l) => l.id === hid);
  if (!lesson) return;
  const r = await simulate(spec, tree.testScope(lesson));
  if (tree !== t) return;
  const tested = tree.append("engine", { type: "test", hypotheses: hid, result: r });
  tree.confirm(tested.seq, r);
  monitor.status(
    "error" in r
      ? `The discriminating run could not conclude (${r.error}); nothing was decided.`
      : "The run decided which explanation the evidence fits.",
  );
}

// Asked from the monitor: predict and run again at the current values. If a
// run of them is already in the log, the prediction is kept but not scored.
async function investigate(id: string) {
  const n = tree.nodes.get(id);
  if (!n || n.check?.kind !== "oregonator" || busy) return;
  busy = true;
  refresh();
  try {
    await experiment(n);
  } finally {
    busy = false;
    refresh();
  }
}

// The AI fixes its own formulas that failed to evaluate: one request for all of
// them, once per growth, never in a loop.
async function repair() {
  const failing = tree.broken();
  if (failing.length === 0) return;
  monitor.status(`The AI is fixing ${String(failing.length)} formula(s)...`, true);
  const { value, usage } = await ai().ask(
    {
      instructions: REPAIR,
      input: JSON.stringify(failing),
      maxOutput: 3000,
    },
    "repair",
    REPAIR_SCHEMA,
  );
  const fixes = tree.admitFixes(
    (value as { fixes?: { id: string; value: string; limit: string }[] }).fixes ?? [],
  );
  tree.append(`ai:${usage.model}`, { type: "repair", fixes, usage });
  for (const f of fixes) {
    const n = tree.nodes.get(f.node);
    if (n) await check(n);
  }
  monitor.status(
    `The AI repaired ${String(fixes.length)} of ${String(failing.length)} formula(s).`,
  );
}

// Formulas are evaluated on the spot; experiments run in a worker, and the
// result is recorded as the engine's and confirmed as re-run here.
async function check(n: IdeaNode) {
  if (!n.check) return;
  if (n.check.kind === "oregonator") {
    await experiment(n);
    refresh();
    return;
  }
  tree.append("engine", { type: "check", node: n.id, result: runCheck(n.check, tree.scope()) });
}

// Experiments read from a log count only once they reproduce in this browser.
async function confirmExperiments() {
  const t = tree;
  for (const run of t.runsToConfirm()) {
    const spec = t.nodes.get(run.node)?.check;
    if (!spec) continue;
    monitor.status("Re-running a recorded experiment in your browser...", true);
    // The past is checked with its own inputs; the present gets a new run
    // through the usual staleness check.
    const again = await simulate(spec, { ...t.scope(), ...(run.result.inputs ?? {}) });
    if (tree !== t) return;
    t.confirm(run.seq, again);
    refresh();
  }
  monitor.status("");
  recheck();
}

async function start(goal: string, sketch?: string) {
  stopPlayback();
  recorded = false;
  tree = new IdeaTree();
  chatUsage.length = 0;
  tree.append("person", { type: "goal", text: goal, ...(sketch ? { sketch } : {}) });
  selectedId = undefined;
  workspace(goal);
  if (hasAi()) await grow("goal", "decompose");
  else {
    select("goal");
    monitor.status("Add the first assumptions this goal rests on: Add a root by hand.");
  }
}

// Without an AI, a person makes the prediction before the run, through the
// same record: it is scored the same way, and a surprise teaches the same.
function foreseeByHand(n: IdeaNode, inputs: Record<string, number>) {
  const answer = prompt(
    `Before the run: will "${n.title}" hold at these values?\nType holds or fails, and a confidence from 50 to 99 (for example: holds 70). Leave it empty to run without predicting.`,
  );
  const m = /^\s*(holds|fails)\s*(\d{2})?/i.exec(answer ?? "");
  if (!m?.[1]) return undefined;
  const expect = m[1].toLowerCase() as "holds" | "fails";
  const confidence = Math.min(99, Math.max(50, Number(m[2] ?? "60"))) / 100;
  const id = `p${String(tree.predictions.length + 1)}`;
  tree.append("person", {
    type: "predict",
    id,
    node: n.id,
    inputs,
    expect,
    confidence,
    reason: "by hand",
    uses: [],
    usage: BY_HAND,
  });
  refresh();
  return { id, expect, by: "person" as const };
}

const BY_HAND = { model: "person", input: 0, cached: 0, output: 0, reasoning: 0 };

// A root written by a person: it goes through the same protocol check as one
// an AI proposes, and the engine checks it the same way.
function addByHand(under: string) {
  if (busy || !tree.nodes.has(under)) return;
  const title = prompt("A new root under this one. Its title:")?.trim();
  if (!title) return;
  const statement =
    prompt("The assumption, as one sentence that could be false:", title)?.trim() || title;
  const names = [...tree.nodes.values()].flatMap((n) => n.params.map((p) => p.name));
  const formula = prompt(
    `Optional: a check the engine can compute, as value op limit unit, using numbers${
      names.length ? ` or these names: ${names.join(", ")}` : ""
    } (for example: 45 <= 50 kg). Leave it empty for none.`,
  )?.trim();
  const m = formula ? /^(.+?)\s*(<=|>=|<|>|==)\s*(\S+)\s*(.*)$/.exec(formula) : null;
  const node: GrownNode = {
    key: title,
    title: title.slice(0, 80),
    statement,
    axis: AXES[0],
    role: "assumption",
    criticality: "major",
    risk: "medium",
    rationale: "written by hand",
    params: [],
    check: {
      description: m ? (formula ?? "") : "not computable yet",
      value: m?.[1]?.trim() ?? "",
      op: m?.[2] ?? "<=",
      limit: m?.[3] ?? "",
      unit: m?.[4]?.trim() ?? "",
    },
    basis: [],
  };
  const nodes = tree.admit(under, [node]);
  if (!nodes.length) {
    monitor.status("That root could not be added; see the refusals in the Process view.");
    return;
  }
  tree.append("person", { type: "grow", under, nodes, summary: "", usage: BY_HAND });
  for (const n of nodes) void check(n).then(refresh);
  select(nodes[0]?.id);
}

function select(id: string | undefined) {
  selectedId = id && tree.nodes.has(id) ? id : undefined;
  // Choosing a root shows the root.
  if (selectedId && !playing) processOpen = false;
  if (selectedId) view.focus(selectedId);
  refresh();
}

// After a person edits a number, every check that read it runs again, and
// then whatever read those results, until nothing is stale.
function recheck() {
  void recheckAndWait();
}

async function recheckAndWait() {
  const t = tree;
  const own = !busy;
  if (own) busy = true;
  await (async () => {
    try {
      for (let pass = 0; pass < 4; pass++) {
        const stale = [...t.nodes.values()].filter((n) => t.status(n.id) === "stale");
        if (stale.length === 0) break;
        for (const n of stale) {
          if (tree !== t) return;
          await check(n);
        }
      }
    } finally {
      if (own) busy = false;
      if (tree === t) refresh();
    }
  })();
}

function exportTree() {
  const blob = new Blob(
    [
      JSON.stringify(
        { format: "vibloom-ideas-1", events: tree.events, refused: tree.refused },
        null,
        1,
      ),
    ],
    { type: "application/json" },
  );
  const a = el("a", { href: URL.createObjectURL(blob), download: "vibloom-tree.json" });
  a.click();
}

// An exported tree can replay its own log, event by event, exactly as it was
// recorded: same order, same hashes. What this browser adds is separate:
// every experiment is run again here and its run is marked as reproduced or
// not, beside the recorded result. Nothing new is appended to the log.
async function replayLog(data: { events: IdeaEvent[]; refused?: Refusal[] }) {
  const my = ++player.epoch;
  player.paused = false;
  player.data = data;
  const refusals = [...(data.refused ?? [])];
  const full = IdeaTree.replay(data.events);
  const first = data.events[0];
  if (first?.body.type !== "goal") return;
  const t = new IdeaTree();
  recorded = true;
  playing = true;
  processOpen = true;
  tree = t;
  chatUsage.length = 0;
  selectedId = undefined;
  ghosts = [];
  workspace(full.goal);
  const live = () => my === player.epoch && tree === t;
  try {
    for (const e of data.events) {
      while (refusals[0] && refusals[0].at <= t.events.length) {
        const r = refusals.shift();
        if (r) t.refused.push(r);
      }
      const b = e.body;
      if (b.type === "grow") {
        if (b.summary) monitor.status(`Replaying: ${b.summary}`);
        for (const n of b.nodes) {
          ghosts.push({ key: n.id, under: b.under, title: n.title });
          view.render(t, ghosts);
          if (!(await beat(380, my))) return;
        }
        ghosts = [];
      }
      const got = t.append(e.actor, b);
      if (got.hash !== e.hash)
        throw new Error(`event ${String(e.seq)} does not match the recording`);
      if (b.type === "chat") chatUsage[t.chat.length - 1] = b.usage;
      if (b.type === "check" || b.type === "test") {
        const run = t.runs.find((r) => r.seq === got.seq);
        const spec = run && t.nodes.get(run.node)?.check;
        if (run && spec?.kind === "oregonator") {
          monitor.status("Re-running the recorded experiment in your browser...", true);
          const l = b.type === "test" ? t.lessons.find((x) => x.id === b.hypotheses) : undefined;
          const again = await simulate(
            spec,
            l ? t.testScope(l) : { ...t.scope(), ...(run.result.inputs ?? {}) },
          );
          if (!live()) return;
          t.confirm(run.seq, again);
          monitor.status("");
        }
      }
      if (b.type === "view") select(b.node);
      else if (b.type === "predict") select(b.node);
      else if (b.type === "hypotheses") select(t.lessons.at(-1)?.node ?? "");
      else refresh();
      const pause =
        b.type === "grow"
          ? 900
          : b.type === "view"
            ? 1500
            : b.type === "predict" || b.type === "hypotheses"
              ? 1200
              : 450;
      if (!(await beat(pause, my))) return;
    }
    // Land where the session's story is: a lesson first, then an experiment.
    const exp =
      t.lessons.at(-1)?.node ??
      [...t.nodes.values()].find((n) => n.check?.kind === "oregonator")?.id;
    if (exp && !t.views.size) select(exp);
  } catch (err) {
    if (live()) monitor.status(`The recording stops here: ${explain(err)}`);
  } finally {
    if (my === player.epoch) {
      playing = false;
      player.paused = false;
      if (tree === t) refresh();
    }
  }
}

// Recorded playback can be paused, stepped and cancelled. A newer playback,
// a new idea or an opened project bumps the epoch, and the old one stops at
// its next step without touching the new project.
const player = {
  epoch: 0,
  paused: false,
  data: undefined as { events: IdeaEvent[]; refused?: Refusal[] } | undefined,
  step: false,
  wake: undefined as (() => void) | undefined,
};

async function beat(ms: number, my: number): Promise<boolean> {
  await sleep(ms);
  while (player.paused && !player.step && my === player.epoch) {
    await new Promise<void>((r) => (player.wake = r));
  }
  player.step = false;
  return my === player.epoch;
}

function stopPlayback() {
  player.epoch++;
  player.paused = false;
  player.wake?.();
  playing = false;
}

const playback = {
  pause: () => {
    player.paused = !player.paused;
    if (!player.paused) player.wake?.();
    refresh();
  },
  next: () => {
    player.paused = true;
    player.step = true;
    player.wake?.();
    refresh();
  },
  replay: () => {
    if (player.data) void replayLog(player.data);
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

landing();
