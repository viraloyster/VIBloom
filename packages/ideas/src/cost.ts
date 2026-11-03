// Dollars, not calls: every request reserves its worst case before it is sent
// and settles with the reported usage afterwards.

import type { Usage } from "./types";

// USD per million tokens, from dev.meta.ai/docs/pricing-rate-limits.
export const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  "muse-spark-1.3": { input: 1.25, cached: 0.15, output: 4.25 },
  "muse-spark-1.3-contributor": { input: 0.1, cached: 0.002, output: 0.2 },
  "muse-wonder-1.0": { input: 4, cached: 0.2, output: 20 },
};

export function price(model: string) {
  const p = PRICES[model];
  if (!p) throw new Error(`no price for ${model}`);
  return p;
}

export function cost(model: string, input: number, cached: number, output: number): number {
  const p = price(model);
  return ((input - cached) * p.input + cached * p.cached + output * p.output) / 1e6;
}

// Only a fallback when the API cannot count: about 4 characters per token for
// English JSON, so 2 per token plus the schema and injected context stays high.
export const estimateTokens = (text: string) => Math.ceil(text.length / 2) + 3000;

// Shown before a request, from local text only, so it is labelled an estimate.
export function estimate(model: string, inputText: string, maxOutput: number): number {
  return cost(model, estimateTokens(inputText), 0, maxOutput);
}

export class BudgetExceeded extends Error {
  constructor(
    readonly needed: number,
    readonly left: number,
  ) {
    super(`needs up to $${needed.toFixed(4)}, $${left.toFixed(4)} left`);
  }
}

export interface Ticket {
  amount: number;
  open: boolean;
}

export class Ledger {
  private spent = 0;
  private reserved = 0;
  readonly entries: Usage[] = [];

  constructor(public cap: number) {}

  get total() {
    return this.spent;
  }

  get left() {
    return this.cap - this.spent - this.reserved;
  }

  reserve(amount: number): Ticket {
    if (amount > this.left) throw new BudgetExceeded(amount, this.left);
    this.reserved += amount;
    return { amount, open: true };
  }

  private close(t: Ticket): boolean {
    if (!t.open) return false;
    t.open = false;
    this.reserved -= t.amount;
    return true;
  }

  // Rejected before inference: nothing was billed.
  cancel(t: Ticket) {
    this.close(t);
  }

  // Failed or timed out after sending: the provider may have billed it, so the
  // whole reservation counts as spent.
  fail(t: Ticket) {
    if (this.close(t)) this.spent += t.amount;
  }

  settle(t: Ticket, usage: Usage) {
    if (this.close(t)) {
      this.spent += usage.cost;
      this.entries.push(usage);
    }
  }
}
