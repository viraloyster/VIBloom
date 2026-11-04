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
  estimate,
  runCheck,
  type IdeaEvent,
  type Refusal,
  type IdeaNode,
  type Mode,
  type Usage,
} from "@vibloom/ideas";
import { RECIPE_RELATIONS, RECIPE_SOURCE } from "@vibloom/chem";
import { el } from "../dom";
import { mountChat } from "./chat";
import { simulate } from "./chem";
import { mountMonitor, viewData } from "./monitor";
import { openPad } from "./pad";
import { steps } from "./process";
import { mountTreeView, type Ghost } from "./view";

const EXAMPLES = [
  "A commercial airliner made of cardboard to cut costs",
  "A tree that grows gold",
  "A chemical clock that changes colour every minute",
  "There are infinitely many twin primes",
];
const EFFORT = "low" as const;
const MAX_OUT = {
  decompose: 8000,
  expand: 5000,
  view: 9000,
  chat: 1500,
  review: 3000,
  read: 4000,
};
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

// A project's name in the header: its first sentence, cut at a word. The
// whole question stays in the tooltip and on the goal root.
function shortTitle(goal: string): string {
  const first = (goal.split(/[.?!\n]/)[0] ?? goal).trim();
  if (first.length <= 44) return first;
  return `${first.slice(0, 42).replace(/\s+\S*$/, "")}...`;
}

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
  const sketch = el(
    "button",
    { class: "sketch", title: "Write or sketch it by hand, or use a photo of paper" },
    "Write it by hand",
  );
  const note = el("p", { class: "note" });
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
  const replay = el("button", { class: "ghost-btn" }, "Recorded: cardboard airliner");
  replay.addEventListener("click", () => void playRecorded("cardboard-airliner"));
  const replayChem = el(
    "button",
    { class: "ghost-btn" },
    "Recorded: a handwritten BZ recipe, tested in seconds",
  );
  replayChem.addEventListener("click", () => void playRecorded("chemical-clock"));
  const replayLesson = el(
    "button",
    { class: "ghost-btn" },
    "Recorded: Muse surprised, then learns",
  );
  replayLesson.addEventListener("click", () => void playRecorded("period-reduction"));
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
  open.addEventListener("click", () => {
    file.click();
  });
  file.addEventListener("change", () => {
    const f = file.files?.[0];
    if (!f) return;
    void f.text().then((text) => {
      try {
        // Replay re-verifies the hash chain and every computed result.
        const data = JSON.parse(text) as { events: IdeaEvent[]; refused?: Refusal[] };
        load(data.events, data.refused);
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
    void start(text, mode.value as Mode, sketched);
  });
  goal.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) grow.click();
  });
  // Muse reads handwriting (words, sketches, formulas) into the goal; the
  // person reads the transcription before anything grows from it.
  sketch.addEventListener("click", () => {
    key = keyInput.value.trim();
    if (!key) {
      note.textContent = "Reading handwriting uses Muse: add your Meta Model API key first.";
      return;
    }
    ledger.cap = Math.max(0.05, Number(cap.value) || 0.5);
    openPad({
      title: "Write or sketch your idea",
      hint: "Words, a drawing, formulas or functions. Muse transcribes it; you check it before growing.",
      action: "Read it with Muse",
      onRead: async (image) => {
        const { value, usage } = await muse().ask(
          {
            instructions: READ_SKETCH,
            input: "Transcribe this.",
            images: [image],
            mode: mode.value as Mode,
            effort: "low",
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
        note.textContent = `Muse read your handwriting (${usd(usage.cost)})${v.unclear ? `; unclear: ${v.unclear}` : ""}. Check it, then grow the roots.`;
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
        el("img", { src: "crown.webp", alt: "", class: "hero-crown" }),
        el("p", { class: "brand" }, "VIBloom"),
        el("h1", {}, "What do you want to build?"),
        el(
          "p",
          { class: "lede" },
          "Muse grows the assumptions it rests on, down to first principles. Code checks what can be computed. Red means a calculation says it fails.",
        ),
        el(
          "div",
          { class: "watch" },
          el("span", { class: "fine" }, "Watch Muse work, no key needed:"),
          replayChem,
          replayLesson,
          replay,
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
        el("div", { class: "row center" }, resume, open, file),
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
// The process view replaces the monitor's root view while open.
let processOpen = false;
// A recorded session is replaying: its steps appear in the process view.
let playing = false;
let processButton: HTMLButtonElement;

function workspace(goal: string) {
  const treeHost = el("section", { class: "tree-col", "aria-label": "Tree" });
  const monitorHost = el("section", { class: "monitor", "aria-label": "Monitor" });
  const chatHost = el("section", { class: "chat", "aria-label": "Chat" });
  hud = el("div", { class: "hud" });
  const back = el("button", { class: "ghost-btn" }, "New idea");
  back.addEventListener("click", () => {
    if (busy) return;
    stopPlayback();
    landing();
  });
  const save = el("button", { class: "ghost-btn" }, "Export");
  save.addEventListener("click", exportTree);
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
    handwrite: (id) => {
      handwrite(id);
    },
    investigate: (id) => void investigate(id),
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
  chat.render(
    tree,
    asking,
    (i) => {
      const u = chatUsage[i];
      return u ? usd(u.cost) : "";
    },
    selectedId ?? "goal",
  );
  // A recording shows what it cost when it was made; it calls nobody now.
  // Otherwise the meter is this tab's real spend against its budget.
  const calls = recorded
    ? tree.events.flatMap((e) => ("usage" in e.body ? [e.body.usage] : []))
    : ledger.entries;
  const spent = calls.reduce((s, u) => s + u.cost, 0);
  const cached = calls.reduce((s, u) => s + u.cached, 0);
  const input = calls.reduce((s, u) => s + u.input, 0);
  hud.replaceChildren(
    el(
      "span",
      { class: "spend" },
      recorded ? `${usd(spent)} when recorded` : `${usd(ledger.total)} / ${usd(ledger.cap)}`,
    ),
    el("span", {}, `${String(calls.length)} ${recorded ? "recorded calls" : "calls"}`),
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

// Muse designs a visual of what a root tests; it runs in an isolated frame
// and draws only the numbers VIBloom hands it.
async function visualize(id: string) {
  if (busy) return;
  busy = true;
  refresh();
  try {
    let feedback: string[] = [];
    // One drawing, Muse looks at it, and at most one redraw: never a loop.
    for (let attempt = 0; attempt < 2; attempt++) {
      monitor.status(
        attempt ? "Muse is redrawing what it found wrong..." : "Muse is designing a view...",
        true,
      );
      const { value, usage } = await muse().ask(
        {
          instructions: VIEW,
          input: JSON.stringify({
            data: nodeData(id),
            ...(feedback.length ? { fix_what_you_saw: feedback } : {}),
          }),
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

// Muse looks at a picture of the monitor, as the person sees it, and says
// whether its drawing matches the data. Returns what it found wrong.
async function review(id: string): Promise<string[]> {
  monitor.status("Muse is looking at its drawing...", true);
  // Let the frame load and the drawing settle before the picture.
  await sleep(2500);
  const image = await monitor.snapshot();
  if (!image) return [];
  const { value, usage } = await muse().ask(
    {
      instructions: REVIEW,
      input: JSON.stringify({ data: nodeData(id) }),
      images: [image],
      mode: tree.mode,
      effort: "low",
      maxOutput: MAX_OUT.review,
    },
    "review",
    REVIEW_SCHEMA,
  );
  const v = value as { ok: boolean; problems: string[] };
  tree.append(`muse:${usage.model}`, {
    type: "review",
    node: id,
    ok: v.ok,
    problems: v.ok ? [] : v.problems,
    usage,
  });
  refresh();
  return v.ok ? [] : v.problems.slice(0, 3);
}

// A formula written by hand on a root: Muse reads it into the tree's names,
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
    hint: "Write the comparison that would make this assumption hold, with symbols or words. Muse maps it to the tree's parameters; the engine computes it.",
    action: "Read it with Muse",
    onRead: async (image) => {
      busy = true;
      refresh();
      try {
        const { value, usage } = await muse().ask(
          {
            instructions: READ_FORMULA,
            input: JSON.stringify({ assumption: n.statement, parameters: params }),
            images: [image],
            mode: tree.mode,
            effort: "low",
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
            `Muse read "${v.reading}" but found no parameter for ${v.unmatched.join(", ")}. Nothing was changed.`,
          );
        }
        const ok = confirm(
          `Muse read: ${v.reading}\n\nAs a check: ${v.value} ${v.op} ${v.limit} ${v.unit}\n\nUse it for this root?`,
        );
        if (!ok) return;
        tree.append(`muse:${usage.model}`, {
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
        monitor.status(`Your formula is now this root's check (read for ${usd(usage.cost)}).`);
      } finally {
        busy = false;
        refresh();
      }
    },
  });
}

async function ask(question: string) {
  if (busy) return;
  busy = true;
  asking = question;
  refresh();
  const focus = selectedId ?? "goal";
  const asked = tree.scope();
  try {
    // Muse sees the monitor as the person does when it shows its drawing.
    const image = tree.views.has(focus) ? await monitor.snapshot() : undefined;
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
          ...recipeContext(),
          ...(image ? { image: "what the monitor shows the person right now" } : {}),
        }),
        ...(image ? { images: [image] } : {}),
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

// When the tree holds a recipe, what the engine knows about how it sets the
// model, so Muse can reason about which change does what.
function recipeContext() {
  const derived = tree.derived();
  return Object.keys(derived).length
    ? { recipe_model: { derived, relations: RECIPE_RELATIONS, source: RECIPE_SOURCE } }
    : {};
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

// The anticipation loop, around every experiment while Muse is connected:
// Muse commits to an outcome before the run, the engine runs, and a surprise
// makes Muse propose two explanations that one more run tells apart. The
// engine decides which one the evidence fits.
async function experiment(n: IdeaNode) {
  const spec = n.check;
  if (spec?.kind !== "oregonator") return;
  const t = tree;
  const scope = t.scope();
  const inputs = Object.fromEntries(SIM_PARAMS.map((k) => [k, scope[k] ?? NaN]));
  let made: { id: string; expect: "holds" | "fails" } | undefined;
  if (key && !recorded) {
    try {
      made = await foresee(n, inputs);
    } catch (e) {
      // No prediction (budget, network): the run still happens, unscored.
      monitor.status(`Running without a prediction: ${explain(e)}`);
    }
    if (tree !== t) return;
  }
  monitor.status(
    made
      ? `Muse predicts ${n.title} ${made.expect}. Running the experiment...`
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
    monitor.status(`As Muse predicted, ${n.title} ${observed}.`);
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
  monitor.status(`Muse is predicting ${n.title} before the run...`, true);
  const pr = await muse().ask(
    {
      instructions: PREDICT,
      // Never a result: only the claim, its question and the values.
      input: JSON.stringify({
        assumption: n.statement,
        question: spec.question,
        tolerance: spec.tolerance,
        values: inputs,
        lessons: tree.lessonsForModel(n.id),
      }),
      mode: tree.mode,
      effort: "low",
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
  tree.append(`muse:${pr.usage.model}`, {
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
    `Surprise: Muse expected ${p.expect}, the run ${observed}. Muse is proposing explanations...`,
    true,
  );
  const dg = await muse().ask(
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
      mode: tree.mode,
      effort: "medium",
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
  tree.append(`muse:${dg.usage.model}`, {
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
    if (n) await check(n);
  }
  monitor.status(`Muse repaired ${String(fixes.length)} of ${String(failing.length)} formula(s).`);
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

async function start(goal: string, mode: Mode, sketch?: string) {
  stopPlayback();
  recorded = false;
  tree = new IdeaTree();
  chatUsage.length = 0;
  tree.append("person", { type: "goal", text: goal, mode, ...(sketch ? { sketch } : {}) });
  selectedId = undefined;
  workspace(goal);
  await grow("goal", "decompose");
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
  const t = tree;
  const own = !busy;
  if (own) busy = true;
  void (async () => {
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

// A recorded session replays its own log, event by event, exactly as it was
// recorded: same order, same hashes. What this browser adds is separate:
// every experiment is run again here and its run is marked as reproduced or
// not, beside the recorded result. Nothing new is appended to the log.
async function playRecorded(name: string) {
  const my = ++player.epoch;
  player.paused = false;
  player.name = name;
  const res = await fetch(`examples/${name}.json`);
  const data = (await res.json()) as { events: IdeaEvent[]; refused?: Refusal[] };
  if (my !== player.epoch) return;
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
        monitor.status(`Recorded Muse session: ${b.summary}`);
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
  name: "",
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
  replay: () => void playRecorded(player.name),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

landing();
