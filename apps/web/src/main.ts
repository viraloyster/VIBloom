import { Api, type ProjectView, type StoredInvestigation } from "./api";
import { play } from "./choreography";
import { mountChat } from "./chat";
import { el } from "./dom";
import { mountMonitor } from "./monitor";
import { mountTree, nodeState } from "./tree";

const byId = (id: string) => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e;
};

let project = new URLSearchParams(location.search).get("project") ?? "oregonator";
const api = () => new Api(project);

let current: ProjectView | undefined;

// Run a person's change, then let the tree show what it propagated to.
async function change(ops: unknown[]): Promise<string | undefined> {
  const was = current;
  if (!was) return "The project is still loading.";
  const before = new Map(was.nodes.map((n) => [n.id, nodeState(was, n)]));
  const r = await api().command(was.head, ops);
  if (!r.ok) return r.code === "stale_base" ? "The map changed; try again." : r.detail;
  await refresh();
  const after = current;
  if (!after) return undefined;
  const changed = after.nodes.filter((n) => before.get(n.id) !== nodeState(after, n));
  const broke = changed.filter((n) => ["broken", "off"].includes(nodeState(after, n)));
  const rest = changed.filter((n) => !broke.includes(n));
  if (broke.length > 0)
    tree.pulse(
      broke.map((n) => n.id),
      "surprise",
    );
  if (rest.length > 0)
    tree.pulse(
      rest.map((n) => n.id),
      "insight",
    );
  return undefined;
}

const tree = mountTree(byId("tree"), {
  setAssumption: (id, revision, c) =>
    change([{ op: "set_assumption", id, expectedRevision: revision, change: c }]),
  confirmLink: (from, to) => change([{ op: "confirm_edge", from, to }]),
});
const monitor = mountMonitor(byId("monitor"));
let stop: (() => void) | undefined;
function replay(inv: StoredInvestigation) {
  stop?.();
  // Replays start where the researcher was working.
  if (inv.investigation.focus) tree.select(inv.investigation.focus);
  stop = play(inv, (beat, i, total) => {
    monitor.show(beat.entry, `move ${String(i + 1)} of ${String(total)}`);
    for (const p of beat.pulses) tree.pulse(p.ids, p.tone);
    if (i === total - 1) {
      setTimeout(() => {
        monitor.show(undefined);
      }, 4000);
    }
  });
}
const chat = mountChat(byId("chat"), api, refresh, replay);

async function refresh() {
  const [view, investigations] = await Promise.all([api().view(), api().investigations()]);
  if (view.head === 0)
    await api()
      .seed()
      .then(() => refresh());
  else {
    current = view;
    lastNodes = view.nodes.map((n) => ({ id: n.id, title: n.title }));
    tree.render(view);
    monitor.render(view, investigations);
    chat.render(investigations);
  }
}

let lastNodes: { id: string; title: string }[] = [];
tree.onSelect((id) => {
  chat.setFocus(lastNodes.find((n) => n.id === id));
});

// Settings stay out of the way behind the gear.
const settings = byId("settings");
const gear = byId("gear");
gear.addEventListener("click", () => {
  settings.hidden = !settings.hidden;
});
const projectInput = el("input", {
  value: project,
  pattern: "[a-z0-9-]{1,64}",
  "aria-label": "Project",
});
const open = el("button", { type: "button" }, "Open project");
open.addEventListener("click", () => {
  project = projectInput.value;
  history.replaceState(null, "", `?project=${encodeURIComponent(project)}`);
  void refresh();
});
const check = el("button", { type: "button" }, "Replay the log");
const checked = el("p", { class: "hint" });
check.addEventListener("click", () => {
  void api()
    .verify()
    .then((v) => {
      checked.textContent = v.ok
        ? `Replayed ${String(v.events ?? 0)} events; head ${(v.head ?? "").slice(0, 16)} matches.`
        : "Replay does not match the live state.";
    });
});
settings.append(
  el("h2", {}, "Settings"),
  el("label", {}, "Project ", projectInput),
  open,
  check,
  checked,
);

void refresh();
