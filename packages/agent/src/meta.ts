// Muse Spark through the Meta Model API (Responses API). No SDK: one fetch,
// so it runs the same in Workers and Node.

import type { Effort, Provider, TraceEntry, TurnReply, TurnRequest } from "./investigate";
import { INSTRUCTIONS } from "./prompt";

export interface MetaConfig {
  // Omitted when a proxy adds the credential; never logged or recorded.
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class MetaApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface OutputItem {
  type?: string;
  content?: { type?: string; text?: string }[];
}

interface ResponseBody {
  output?: OutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { code?: string; message?: string };
}

// Earlier turns as a compact list, so the model sees its own line of play.
function history(trace: TraceEntry[]) {
  return trace.map((t) => ({
    turn: t.turn,
    action: t.decision?.action,
    accepted: t.accepted,
    rejection: t.rejection,
    result: t.result,
    prediction: t.prediction,
  }));
}

export function userMessage(r: TurnRequest): string {
  return JSON.stringify({
    goal: r.goal,
    turn: r.turn,
    feedback: r.feedback,
    history: history(r.trace),
    context: JSON.parse(r.context) as unknown,
  });
}

export function parseReply(body: ResponseBody): { text: string } {
  const out = Array.isArray(body.output) ? body.output : [];
  const text = out
    .filter((o) => o.type === "message")
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text ?? "")
    .join("");
  return { text };
}

// Models sometimes wrap JSON in a code fence; anything else is left to the
// decision parser to refuse.
export function extractJson(text: string): unknown {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  try {
    return JSON.parse(fenced?.[1] ?? text) as unknown;
  } catch {
    return { unparsable: text.slice(0, 200) };
  }
}

export class MetaProvider implements Provider {
  readonly name: string;
  private readonly cfg: MetaConfig;
  // The previous exchange, including its encrypted reasoning, is passed back
  // so the model keeps its line of thought between turns.
  private previous: unknown[] = [];

  constructor(cfg: MetaConfig = {}) {
    this.cfg = cfg;
    this.name = cfg.model ?? "muse-spark-1.3";
  }

  body(r: TurnRequest, turn = { role: "user", content: userMessage(r) }) {
    const effort: Effort = r.effort;
    return {
      model: this.name,
      instructions: INSTRUCTIONS,
      input: [...this.previous, turn],
      reasoning: { effort },
      include: ["reasoning.encrypted_content"],
      max_output_tokens: this.cfg.maxOutputTokens ?? 4000,
      store: false,
    };
  }

  async decide(r: TurnRequest): Promise<TurnReply> {
    const f = this.cfg.fetch ?? fetch;
    const turn = { role: "user", content: userMessage(r) };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    const res = await f(`${this.cfg.baseUrl ?? "https://api.meta.ai/v1"}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(this.body(r, turn)),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 35_000),
    });
    const body = (await res.json().catch(() => ({}))) as ResponseBody;
    if (!res.ok) {
      throw new MetaApiError(
        res.status,
        body.error?.code ?? "unknown",
        body.error?.message ?? res.statusText,
      );
    }
    const { text } = parseReply(body);
    this.previous = [turn, ...(body.output ?? [])];
    const u = body.usage ?? {};
    return {
      decision: extractJson(text),
      usage: {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        reasoning: u.output_tokens_details?.reasoning_tokens ?? 0,
      },
    };
  }
}
