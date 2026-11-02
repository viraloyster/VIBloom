// One daily allowance of model calls for the whole deployment. Every
// investigation reserves its worst case first and returns what it did not use,
// so many project names cannot multiply the spend.

export interface BudgetStore {
  used(day: string): number;
  set(day: string, calls: number): void;
}

export class DailyBudget {
  private readonly store: BudgetStore;
  private readonly limit: number;

  constructor(store: BudgetStore, limit: number) {
    if (!(Number.isInteger(limit) && limit >= 0)) throw new RangeError("limit must be >= 0");
    this.store = store;
    this.limit = limit;
  }

  reserve(day: string, calls: number): boolean {
    const used = this.store.used(day);
    if (used + calls > this.limit) return false;
    this.store.set(day, used + calls);
    return true;
  }

  release(day: string, calls: number): void {
    this.store.set(day, Math.max(0, this.store.used(day) - Math.max(0, calls)));
  }

  remaining(day: string): number {
    return Math.max(0, this.limit - this.store.used(day));
  }
}
