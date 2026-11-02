// Recording and replay of model turns. A replay answers only the exact request
// it recorded and fails on any mismatch, so a replayed investigation is the
// recorded one or nothing.

import { canonical, sha256 } from "@vibloom/engine";
import type { Provider, TurnReply, TurnRequest } from "./investigate";

export interface Recording {
  provider: string;
  turns: { request: string; reply: TurnReply }[];
}

export const requestHash = (r: TurnRequest) => sha256(canonical(r));

export class RecordingProvider implements Provider {
  readonly name: string;
  readonly recording: Recording;
  private readonly inner: Provider;

  constructor(inner: Provider) {
    this.inner = inner;
    this.name = inner.name;
    this.recording = { provider: inner.name, turns: [] };
  }

  async decide(request: TurnRequest): Promise<TurnReply> {
    const reply = await this.inner.decide(request);
    this.recording.turns.push({ request: requestHash(request), reply: structuredClone(reply) });
    return reply;
  }
}

export class ReplayProvider implements Provider {
  readonly name: string;
  private readonly recording: Recording;
  private next = 0;

  constructor(recording: Recording) {
    this.recording = recording;
    this.name = `${recording.provider} (recorded)`;
  }

  decide(request: TurnRequest): Promise<TurnReply> {
    const turn = this.recording.turns[this.next];
    if (!turn) return Promise.reject(new Error("recording exhausted"));
    if (turn.request !== requestHash(request)) {
      return Promise.reject(
        new Error(`request ${String(this.next + 1)} differs from the recording`),
      );
    }
    this.next++;
    return Promise.resolve(structuredClone(turn.reply));
  }
}
