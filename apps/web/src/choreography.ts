// How the investigator's moves play on the tree. The moves come from the
// recorded trace; this only maps each move to the roots it touched.

import type { StoredInvestigation } from "./api";
import type { Tone } from "./tree";

type Entry = StoredInvestigation["investigation"]["trace"][number];

export interface Beat {
  entry: Entry;
  pulses: { ids: string[]; tone: Tone }[];
}

export function beats(inv: StoredInvestigation): Beat[] {
  return inv.investigation.trace.flatMap((entry): Beat[] => {
    const d = entry.decision;
    if (!entry.accepted || !d) return [];
    const pulses: Beat["pulses"] = [];
    switch (d.action) {
      case "formulate":
        pulses.push({
          ids: [...d.claims.map((c) => c.id), ...d.assumptions.map((a) => a.id)],
          tone: "sprout",
        });
        break;
      case "run_point":
      case "stress_test":
        pulses.push({ ids: [d.experiment], tone: "probe" });
        break;
      case "diagnose":
        pulses.push({
          ids: [d.lesson.id, ...new Set(d.candidates.flatMap((c) => c.suspects))],
          tone: "insight",
        });
        break;
      case "revise":
        pulses.push({ ids: [d.claim.id], tone: "sprout" });
        break;
      case "conclude":
        pulses.push({ ids: [d.claim], tone: d.verdict === "refuted" ? "surprise" : "insight" });
        break;
      case "ask_researcher":
        break;
    }
    // A failed prediction shakes the claim behind the experiment.
    if (
      entry.prediction?.verdict === "surprise" &&
      (d.action === "run_point" || d.action === "stress_test")
    ) {
      pulses.push({ ids: [d.experiment, ...d.prediction.assumes], tone: "surprise" });
    }
    return [{ entry, pulses }];
  });
}

export function play(
  inv: StoredInvestigation,
  onBeat: (beat: Beat, index: number, total: number) => void,
  stepMs = 2600,
): () => void {
  const all = beats(inv);
  const timers = all.map((b, i) =>
    setTimeout(() => {
      onBeat(b, i, all.length);
    }, i * stepMs),
  );
  return () => {
    for (const t of timers) clearTimeout(t);
  };
}
