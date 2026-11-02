import { describe, expect, it } from "vitest";
import { DailyBudget, type BudgetStore } from "./budget";

const memory = (): BudgetStore => {
  const m = new Map<string, number>();
  return { used: (d) => m.get(d) ?? 0, set: (d, c) => m.set(d, c) };
};

describe("DailyBudget", () => {
  it("reserves worst cases and gives back what was not used", () => {
    const b = new DailyBudget(memory(), 30);
    expect(b.reserve("2026-11-02", 14)).toBe(true);
    expect(b.reserve("2026-11-02", 14)).toBe(true);
    expect(b.reserve("2026-11-02", 14)).toBe(false);
    b.release("2026-11-02", 10);
    expect(b.remaining("2026-11-02")).toBe(12);
    expect(b.reserve("2026-11-02", 12)).toBe(true);
  });

  it("starts each day afresh and never goes below zero", () => {
    const b = new DailyBudget(memory(), 14);
    expect(b.reserve("2026-11-02", 14)).toBe(true);
    expect(b.reserve("2026-11-03", 14)).toBe(true);
    b.release("2026-11-02", 99);
    expect(b.remaining("2026-11-02")).toBe(14);
  });
});
