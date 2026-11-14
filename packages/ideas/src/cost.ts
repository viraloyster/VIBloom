// Tokens, not dollars: VIBloom does not know what each provider charges. Every
// request reserves its worst case before it is sent and settles with the
// reported usage afterwards, so a session cannot run past its token budget.

import type { Usage } from "./types";

// Only a fallback when the provider does not report usage: about 4 characters
// per token for English JSON, so 2 per token plus the schema stays high.
export const estimateTokens = (text: string) => Math.ceil(text.length / 2) + 3000;

// Shown before a request, from local text only, so it is labelled an estimate.
export function estimate(inputText: string, maxOutput: number): number {
  return estimateTokens(inputText) + maxOutput;
}

export const used = (u: Usage) => u.input + u.output;

export class BudgetExceeded extends Error {
  constructor(
    readonly needed: number,
    readonly left: number,
  ) {
    super(`needs up to ${String(needed)} tokens, ${String(Math.max(0, left))} left`);
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

  // Rejected before inference: nothing was used.
  cancel(t: Ticket) {
    this.close(t);
  }

  // Failed or timed out after sending: the provider may have counted it, so
  // the whole reservation counts as spent.
  fail(t: Ticket) {
    if (this.close(t)) this.spent += t.amount;
  }

  settle(t: Ticket, usage: Usage) {
    if (this.close(t)) {
      this.spent += used(usage);
      this.entries.push(usage);
    }
  }
}
