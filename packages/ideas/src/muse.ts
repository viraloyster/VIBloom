// Muse Spark on the Meta Model API (Responses, streamed). The browser calls it
// directly with the person's own key; nothing passes through a server of ours.

import { cost, Ledger, worstCase } from "./cost";
import { GROWTH_SCHEMA, type GrownNode } from "./protocol";
import { ArrayItems } from "./stream";
import type { Mode, Usage } from "./types";

export interface MuseConfig {
  // Omitted when a proxy adds the credential. Never logged or recorded.
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface AskRequest {
  instructions: string;
  input: string;
  mode: Mode;
  effort: "minimal" | "low" | "medium" | "high";
  maxOutput: number;
  onThought?: (text: string) => void;
}

export interface GrowRequest extends AskRequest {
  onNode?: (raw: unknown) => void;
}

export interface GrowReply {
  summary: string;
  nodes: GrownNode[];
  usage: Usage;
}

export class MuseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const modelFor = (mode: Mode) =>
  mode === "contributor" ? "muse-spark-1.3-contributor" : "muse-spark-1.3";

interface StreamEvent {
  type?: string;
  delta?: string;
  response?: {
    status?: string;
    incomplete_details?: { reason?: string };
    error?: { code?: string; message?: string };
    usage?: {
      input_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
      output_tokens?: number;
      output_tokens_details?: { reasoning_tokens?: number };
    };
  };
  error?: { code?: string; message?: string };
}

export class Muse {
  constructor(
    private readonly cfg: MuseConfig,
    readonly ledger: Ledger,
  ) {}

  async grow(r: GrowRequest): Promise<GrowReply> {
    const items = new ArrayItems("nodes");
    const { value, usage } = await this.ask(r, "growth", GROWTH_SCHEMA, (delta) => {
      for (const n of items.push(delta)) r.onNode?.(n);
    });
    const parsed = value as { summary?: unknown; nodes?: unknown };
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      nodes: Array.isArray(parsed.nodes) ? (parsed.nodes as GrownNode[]) : [],
      usage,
    };
  }

  // One structured request: reserve, stream, settle, parse.
  async ask(
    r: AskRequest,
    name: string,
    schema: object,
    onText?: (delta: string) => void,
  ): Promise<{ value: unknown; usage: Usage }> {
    const model = modelFor(r.mode);
    const reserved = worstCase(model, r.instructions + r.input, r.maxOutput);
    const ticket = this.ledger.reserve(reserved);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    let res: Response;
    try {
      res = await (this.cfg.fetch ?? fetch)(
        `${this.cfg.baseUrl ?? "https://api.meta.ai/v1"}/responses`,
        {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 120_000),
          body: JSON.stringify({
            model,
            // Fixed instructions first, so the cache can serve them.
            instructions: r.instructions,
            input: r.input,
            reasoning: { effort: r.effort, summary: "concise" },
            text: {
              format: { type: "json_schema", name, strict: true, schema },
            },
            max_output_tokens: r.maxOutput,
            prompt_cache_key: "vibloom-ideas-1",
            store: false,
            stream: true,
          }),
        },
      );
    } catch (e) {
      this.ledger.fail(ticket);
      throw new MuseError("network", e instanceof Error ? e.message : String(e));
    }
    if (!res.ok || !res.body) {
      // Rejected before inference: nothing was billed.
      const body = (await res.json().catch(() => ({}))) as StreamEvent;
      this.ledger.cancel(ticket);
      throw new MuseError(
        body.error?.code ?? `http_${String(res.status)}`,
        body.error?.message ?? res.statusText,
      );
    }

    let text = "";
    let done: StreamEvent["response"];
    try {
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buffer += value;
        let cut = buffer.indexOf("\n\n");
        while (cut >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          cut = buffer.indexOf("\n\n");
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("");
          if (!data || data === "[DONE]") continue;
          const ev = JSON.parse(data) as StreamEvent;
          if (ev.type === "response.output_text.delta" && ev.delta) {
            text += ev.delta;
            onText?.(ev.delta);
          } else if (ev.type === "response.reasoning_summary_text.delta" && ev.delta) {
            r.onThought?.(ev.delta);
          } else if (
            ev.type === "response.completed" ||
            ev.type === "response.incomplete" ||
            ev.type === "response.failed"
          ) {
            done = ev.response;
          } else if (ev.type === "error") {
            throw new MuseError(
              ev.error?.code ?? "stream_error",
              ev.error?.message ?? "stream error",
            );
          }
        }
      }
    } catch (e) {
      this.ledger.fail(ticket);
      throw e instanceof MuseError ? e : new MuseError("stream", String(e));
    }
    if (!done) {
      this.ledger.fail(ticket);
      throw new MuseError("stream", "the response ended without completing");
    }
    const u = done.usage ?? {};
    const usage: Usage = {
      model,
      input: u.input_tokens ?? 0,
      cached: u.input_tokens_details?.cached_tokens ?? 0,
      output: u.output_tokens ?? 0,
      reasoning: u.output_tokens_details?.reasoning_tokens ?? 0,
      cost: 0,
    };
    usage.cost = cost(model, usage.input, usage.cached, usage.output);
    this.ledger.settle(ticket, usage);
    if (done.status !== "completed") {
      throw new MuseError(
        done.incomplete_details?.reason ?? done.error?.code ?? "incomplete",
        done.error?.message ?? "the response did not complete",
      );
    }
    try {
      return { value: JSON.parse(text) as unknown, usage };
    } catch {
      throw new MuseError("unparsable", text.slice(0, 200));
    }
  }
}
