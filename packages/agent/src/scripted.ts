import type { Provider, TurnReply, TurnRequest } from "./investigate";

// Replies from a fixed list, for tests and for running without a model.
export class ScriptedProvider implements Provider {
  readonly name = "scripted";
  readonly requests: TurnRequest[] = [];
  private readonly replies: unknown[];

  constructor(replies: unknown[]) {
    this.replies = [...replies];
  }

  decide(request: TurnRequest): Promise<TurnReply> {
    this.requests.push(request);
    const decision = this.replies.shift();
    if (decision === undefined) return Promise.reject(new Error("script exhausted"));
    return Promise.resolve({ decision });
  }
}
