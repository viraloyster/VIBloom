// A root written by a person: the same shape an AI returns, so it passes the
// same protocol check and the engine evaluates it the same way.

import { AXES, type GrownNode } from "@vibloom/ideas";
import { el } from "../dom";

type CheckKind = "none" | "arithmetic" | "oregonator";

const QUESTIONS: [string, string][] = [
  ["oscillates", "The full model oscillates"],
  ["reduced_oscillates", "The two-variable model oscillates"],
  ["reduction_keeps_period", "The two-variable model keeps the full model's period"],
];

const field = (label: string, input: HTMLElement, hint?: string) =>
  el(
    "label",
    { class: "field" },
    el("span", { class: "field-label" }, label),
    input,
    hint ? el("span", { class: "fine" }, hint) : null,
  );

export function openRootForm(opts: {
  // Where the new root goes, as shown to the person.
  under: string;
  // Parameter names the tree already holds, usable in a comparison.
  names: string[];
  // Returns why the root was refused, or nothing when it was added.
  onAdd: (node: GrownNode) => string | undefined;
}) {
  const title = el("input", { class: "key", maxlength: 120, placeholder: "A few words" });
  const statement = el("textarea", {
    class: "goal-input",
    rows: 2,
    maxlength: 600,
    placeholder: "One sentence that could turn out false",
  });

  const rows = el("div", { class: "param-rows" });
  const addRow = () => {
    const remove = el("button", { class: "ghost-btn", type: "button", title: "Remove" }, "x");
    const row = el(
      "div",
      { class: "param-row" },
      el("input", { class: "key p-name", placeholder: "name", spellcheck: "false" }),
      el("input", { class: "key p-value", placeholder: "value", inputmode: "decimal" }),
      el("input", { class: "key p-unit", placeholder: "unit" }),
      el(
        "select",
        { class: "mode p-kind", "aria-label": "Kind" },
        el("option", { value: "design" }, "I choose it"),
        el("option", { value: "requirement" }, "the goal demands it"),
        el("option", { value: "external" }, "the world sets it"),
      ),
      el("input", { class: "key p-source", placeholder: "source, if measured or published" }),
      remove,
    );
    remove.addEventListener("click", () => {
      row.remove();
    });
    rows.append(row);
  };
  const more = el("button", { class: "ghost-btn", type: "button" }, "Add a number");
  more.addEventListener("click", addRow);

  const kind = el(
    "select",
    { class: "mode", "aria-label": "How it is tested" },
    el("option", { value: "none" }, "Argued, not computed"),
    el("option", { value: "arithmetic" }, "A comparison the engine computes"),
    el("option", { value: "oregonator" }, "An Oregonator experiment (BZ reaction)"),
  );
  const value = el("input", { class: "key", placeholder: "load * span / 4", spellcheck: "false" });
  const op = el(
    "select",
    { class: "mode", "aria-label": "Comparison" },
    ...["<=", "<", ">=", ">"].map((o) => el("option", { value: o }, o)),
  );
  const limit = el("input", { class: "key", placeholder: "strength", spellcheck: "false" });
  const unit = el("input", { class: "key p-unit", placeholder: "unit" });
  const arithmetic = el(
    "div",
    { class: "check-part" },
    el("div", { class: "row" }, value, op, limit, unit),
    el(
      "p",
      { class: "fine" },
      `Arithmetic over numbers and names (+ - * / ^, sqrt, abs, min, max, log, exp). Names in the tree: ${opts.names.length ? opts.names.join(", ") : "none yet; add numbers above"}.`,
    ),
  );
  const question = el(
    "select",
    { class: "mode", "aria-label": "Question" },
    ...QUESTIONS.map(([v, text]) => el("option", { value: v }, text)),
  );
  const tolerance = el("input", {
    class: "key p-value",
    value: "0.05",
    inputmode: "decimal",
    "aria-label": "Tolerance",
  });
  const oregonator = el(
    "div",
    { class: "check-part" },
    el("div", { class: "row" }, question, el("span", { class: "fine" }, "tolerance"), tolerance),
    el(
      "p",
      { class: "fine" },
      "Needs a recipe in the tree (bromate, malonic_acid and acid in M, and s), or the model's own q, eps, eps_prime and s. The engine runs the stiff solver and decides.",
    ),
  );
  const showCheck = () => {
    arithmetic.hidden = kind.value !== "arithmetic";
    oregonator.hidden = kind.value !== "oregonator";
  };
  kind.addEventListener("change", showCheck);
  showCheck();

  const status = el("p", { class: "fine pad-status", role: "status" });
  const cancel = el("button", { class: "ghost-btn", type: "button" }, "Cancel");
  const add = el("button", { class: "primary", type: "submit" }, "Add the root");
  const form = el(
    "form",
    { class: "pad-card root-form" },
    el("h3", {}, "A new root"),
    el("p", { class: "fine" }, `Under: ${opts.under}`),
    field("Title", title),
    field("The assumption", statement),
    el("span", { class: "field-label" }, "Numbers it relies on"),
    rows,
    el("div", { class: "row" }, more),
    field("How it is tested", kind),
    arithmetic,
    oregonator,
    status,
    el("div", { class: "row" }, el("span", { class: "spacer" }), cancel, add),
  );
  const sheet = el("div", { class: "pad", role: "dialog", "aria-label": "A new root" }, form);
  const close = () => {
    sheet.remove();
  };
  cancel.addEventListener("click", close);
  sheet.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const fail = (why: string) => {
      status.textContent = why;
    };
    const t = title.value.trim();
    if (!t) {
      fail("Give the root a title.");
      return;
    }
    const params: GrownNode["params"] = [];
    for (const row of rows.querySelectorAll(".param-row")) {
      const get = (c: string) =>
        (row.querySelector<HTMLInputElement | HTMLSelectElement>(c)?.value ?? "").trim();
      const name = get(".p-name");
      const raw = get(".p-value");
      if (!name && !raw) continue;
      const number = Number(raw);
      if (!/^[A-Za-z_]\w*$/.test(name)) {
        fail(`"${name}" is not a name: use letters, digits and underscores, like wall_thickness.`);
        return;
      }
      if (raw === "" || !Number.isFinite(number)) {
        fail(`${name} needs a number as its value.`);
        return;
      }
      const source = get(".p-source");
      params.push({
        name,
        kind: get(".p-kind"),
        value: number,
        unit: get(".p-unit"),
        origin: source ? "reference" : "assumed",
        source,
      });
    }
    const which = kind.value as CheckKind;
    let check: GrownNode["check"] = {
      kind: "none",
      description: "argued by the person, not computed",
      value: "",
      op: "none",
      limit: "",
      unit: "",
    };
    if (which === "arithmetic") {
      if (!value.value.trim() || !limit.value.trim()) {
        fail("A comparison needs something on both sides.");
        return;
      }
      check = {
        kind: "arithmetic",
        description: `${value.value.trim()} ${op.value} ${limit.value.trim()}`,
        value: value.value.trim(),
        op: op.value,
        limit: limit.value.trim(),
        unit: unit.value.trim(),
      };
    } else if (which === "oregonator") {
      const tol = Number(tolerance.value);
      if (!(tol > 0 && tol < 1)) {
        fail("The tolerance is a fraction between 0 and 1, for example 0.05.");
        return;
      }
      check = {
        kind: "oregonator",
        question: question.value,
        tolerance: tol,
        description: QUESTIONS.find(([v]) => v === question.value)?.[1] ?? question.value,
        value: "",
        op: "<=",
        limit: "",
        unit: "",
      };
    }
    const refused = opts.onAdd({
      key: t,
      title: t,
      statement: statement.value.trim() || t,
      axis: AXES[0],
      role: "assumption",
      criticality: "major",
      risk: "medium",
      rationale: "written by hand",
      params,
      check,
      basis: [],
    });
    if (refused) fail(refused);
    else close();
  });

  document.body.append(sheet);
  title.focus();
}
