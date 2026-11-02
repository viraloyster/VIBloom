import { Api } from "./api";
import { mountChat } from "./chat";
import { el } from "./dom";
import { mountMonitor } from "./monitor";
import { mountTree } from "./tree";

const byId = (id: string) => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e;
};

let project = new URLSearchParams(location.search).get("project") ?? "oregonator";
const api = () => new Api(project);

const tree = mountTree(byId("tree"));
const monitor = mountMonitor(byId("monitor"));
const chat = mountChat(byId("chat"), api, refresh);

async function refresh() {
  const [view, investigations] = await Promise.all([api().view(), api().investigations()]);
  if (view.head === 0)
    await api()
      .seed()
      .then(() => refresh());
  else {
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
