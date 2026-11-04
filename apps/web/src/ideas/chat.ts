// The chat: short, grounded answers. The heavy work shows in the tree and the
// monitor; here Muse only explains, citing the roots it relied on.

import type { IdeaTree } from "@vibloom/ideas";
import { el } from "../dom";
import { statusLabel } from "./view";

export interface ChatActions {
  ask(question: string): void;
  select(id: string): void;
  busy(): boolean;
}

export function mountChat(host: HTMLElement, actions: ChatActions) {
  const log = el("div", { class: "chat-log" });
  const input = el("input", {
    class: "chat-input",
    placeholder: "Ask about the selected root...",
    "aria-label": "Ask Muse",
  });
  const send = el("button", { class: "send", "aria-label": "Send" }, "Ask");
  const grow = el("button", { class: "ghost-btn expand", "aria-label": "Expand chat" }, "Expand");
  grow.addEventListener("click", () => {
    host.classList.toggle("open");
    grow.textContent = host.classList.contains("open") ? "Collapse" : "Expand";
  });
  const submit = () => {
    const q = input.value.trim();
    if (!q || actions.busy()) return;
    input.value = "";
    actions.ask(q);
  };
  send.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  host.replaceChildren(
    el("div", { class: "chat-head" }, el("span", { class: "eyebrow" }, "Chat with Muse"), grow),
    log,
    el("div", { class: "chat-bar" }, input, send),
  );

  return {
    render(tree: IdeaTree, pending?: string, cost?: (i: number) => string) {
      const items = tree.chat.map((c, i) => {
        const cites = c.cites.map((id) => {
          const n = tree.nodes.get(id);
          const b = el(
            "button",
            { class: `cite ${tree.status(id)}`, title: statusLabel(tree.status(id)) },
            n?.title ?? id,
          );
          b.addEventListener("click", () => {
            actions.select(id);
          });
          return b;
        });
        const about = tree.nodes.get(c.focus)?.title;
        return el(
          "div",
          { class: "turn" },
          el("div", { class: "msg me" }, el("p", {}, c.question)),
          el(
            "div",
            { class: "msg muse" },
            el("span", { class: "who" }, "Muse", about ? el("small", {}, ` on ${about}`) : null),
            el("p", {}, c.answer),
            tree.outdated(i)
              ? el("p", { class: "note-line warn" }, "Values have changed since this answer.")
              : null,
            c.cites.length === 0
              ? el("p", { class: "note-line warn" }, "No root cited: treat this as unsupported.")
              : null,
            el(
              "div",
              { class: "cites" },
              ...cites,
              cost ? el("span", { class: "fine" }, cost(i)) : null,
            ),
          ),
        );
      });
      if (pending) {
        items.push(
          el(
            "div",
            { class: "turn" },
            el("div", { class: "msg me" }, el("p", {}, pending)),
            el(
              "div",
              { class: "msg muse" },
              el("span", { class: "who" }, "Muse"),
              el("p", { class: "typing" }, el("i", {}), el("i", {}), el("i", {})),
            ),
          ),
        );
      }
      if (items.length === 0) {
        items.push(
          el(
            "p",
            { class: "chat-empty" },
            "Ask Muse about the selected root: why it fails, what it rests on, what to test next.",
          ),
        );
      }
      log.replaceChildren(...items);
      log.scrollTop = log.scrollHeight;
    },
  };
}
