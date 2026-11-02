// The researcher asks; the investigator answers with moves, and the engine
// answers each move. Model text is shown as the model's, engine text as fact.

import type { TraceEntry } from "@vibloom/agent";
import type { Api, StoredInvestigation } from "./api";
import { el } from "./dom";

function entryText(t: TraceEntry): string {
  const d = t.decision;
  if (!d) return "unreadable reply";
  switch (d.action) {
    case "formulate":
      return `Formulated ${d.claims.map((c) => c.id).join(", ")}${d.ambiguities.length > 0 ? `. Ambiguities: ${d.ambiguities.join("; ")}` : ""}`;
    case "run_point":
      return `Run ${JSON.stringify(d.point)} on ${d.experiment}, predicting ${d.prediction.outcome}`;
    case "stress_test":
      return `Stress test of ${d.experiment} (${String(d.budget)} points), predicting ${d.prediction.outcome.replace("_", " ")}`;
    case "diagnose":
      return `Diagnosed: ${d.lesson.statement}`;
    case "revise":
      return `Revised ${d.previous.id} into ${d.claim.id}: ${d.changes}`;
    case "ask_researcher":
      return `Question for you: ${d.question}`;
    case "conclude":
      return `${d.claim} is ${d.verdict}. ${d.interpretation}`;
  }
}

function engineText(t: TraceEntry): string {
  if (!t.accepted) return `Refused: ${t.rejection ?? "invalid"}`;
  if (t.prediction) {
    return t.prediction.verdict === "surprise"
      ? `Surprise: observed ${t.prediction.observed ?? "-"}`
      : `Observed ${t.prediction.observed ?? "-"} (${t.prediction.verdict.replace("_", " ")})`;
  }
  return "Accepted";
}

export function mountChat(
  host: HTMLElement,
  api: () => Api,
  refresh: () => Promise<void>,
  replay: (inv: StoredInvestigation) => void,
) {
  const log = el("div", { class: "log" });
  const input = el("textarea", {
    rows: 2,
    maxlength: 2000,
    placeholder:
      "Ask a question about the model, e.g. does removing the bromide variable keep the oscillations?",
  });
  const send = el("button", { type: "submit" }, "Investigate");
  const status = el("p", { class: "status", role: "status" });
  const chip = el("div", { class: "focus-chip", hidden: true });
  let focus: { id: string; title: string } | undefined;
  const form = el("form", { class: "ask" }, input, send);
  const toggle = el("button", { type: "button", class: "expand" }, "Expand");
  toggle.addEventListener("click", () => {
    host.classList.toggle("open");
    toggle.textContent = host.classList.contains("open") ? "Collapse" : "Expand";
  });
  host.replaceChildren(
    el("div", { class: "chat-head" }, el("h2", {}, "Investigation"), toggle),
    log,
    status,
    chip,
    form,
  );

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const goal = input.value.trim();
    if (!goal) return;
    send.disabled = true;
    status.textContent =
      "Muse Spark is investigating. Each move is checked and run by the engine...";
    void api()
      .investigate(goal, focus?.id)
      .then(async (r) => {
        status.textContent = r.ok
          ? `Finished: ${r.investigation.investigation.stop.replace("_", " ")}`
          : r.detail;
        if (r.ok) input.value = "";
        await refresh();
        // Play the investigation on the tree as soon as it is recorded.
        if (r.ok) replay(r.investigation);
      })
      .catch(() => {
        status.textContent = "The investigation could not be reached.";
      })
      .finally(() => {
        send.disabled = false;
      });
  });

  const replayButton = (inv: StoredInvestigation) => {
    const b = el("button", { type: "button", class: "replay" }, "Replay on the tree");
    b.addEventListener("click", () => {
      replay(inv);
    });
    return b;
  };

  return {
    // The root selected in the tree becomes the focus of the next question.
    setFocus(next: { id: string; title: string } | undefined) {
      focus = next;
      chip.hidden = !next;
      chip.textContent = next ? `Focus: ${next.title}` : "";
    },
    render(investigations: StoredInvestigation[]) {
      log.replaceChildren(
        ...investigations.flatMap((inv) => [
          el("div", { class: "msg researcher" }, inv.investigation.goal),
          replayButton(inv),
          ...inv.investigation.trace.flatMap((t) => [
            el(
              "div",
              { class: "msg model" },
              el("span", { class: "who" }, `${inv.investigation.provider}, turn ${String(t.turn)}`),
              entryText(t),
            ),
            el(
              "div",
              { class: `msg engine ${t.accepted ? "" : "refused"}` },
              el("span", { class: "who" }, "engine"),
              engineText(t),
            ),
          ]),
          el("div", { class: "msg end" }, `stopped: ${inv.investigation.stop.replace("_", " ")}`),
        ]),
      );
      log.scrollTop = log.scrollHeight;
    },
  };
}
