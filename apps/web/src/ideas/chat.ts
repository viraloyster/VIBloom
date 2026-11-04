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
      const items = tree.chat.map((c, i) =>
        el(
          "div",
          { class: "turn" },
          el("p", { class: "q" }, c.question),
          el("p", { class: "a" }, c.answer),
          el(
            "div",
            { class: "cites" },
            ...c.cites.map((id) => {
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
            }),
            cost ? el("span", { class: "fine" }, cost(i)) : null,
          ),
        ),
      );
      if (pending)
        items.push(
          el(
            "div",
            { class: "turn" },
            el("p", { class: "q" }, pending),
            el("p", { class: "a thinking-dots" }, "Muse is answering"),
          ),
        );
      log.replaceChildren(...items);
      log.scrollTop = log.scrollHeight;
    },
  };
}
