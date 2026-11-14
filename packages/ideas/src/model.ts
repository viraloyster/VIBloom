// Any language model, through the person's own key. The browser calls the
// provider directly; nothing passes through a server of ours. Two protocols
// cover the providers: OpenAI-compatible chat completions and Anthropic's
// messages. Every answer is JSON against a schema, and is checked again by
// the code that uses it: a model proposes, it never decides.

import { estimateTokens, Ledger } from "./cost";
import type { GrownNode } from "./protocol";
import { GROWTH_SCHEMA } from "./protocol";
import type { Usage } from "./types";

export type Provider = "anthropic" | "openai" | "xai" | "gemini" | "openrouter" | "local";

interface ProviderInfo {
  label: string;
  protocol: "openai" | "anthropic";
  baseUrl: string;
  // A suggestion for the model field; the person can type any model name.
  model: string;
}

export const PROVIDERS: Record<Provider, ProviderInfo> = {
  anthropic: {
    label: "Anthropic (Claude)",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-5-5",
  },
  openai: { label: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", model: "" },
  xai: { label: "xAI (Grok)", protocol: "openai", baseUrl: "https://api.x.ai/v1", model: "" },
  gemini: {
    label: "Google (Gemini)",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "",
  },
  openrouter: {
    label: "OpenRouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "",
  },
  local: {
    label: "Local (Ollama, LM Studio)",
    protocol: "openai",
    baseUrl: "http://localhost:11434/v1",
    model: "",
  },
};

export interface ModelConfig {
  provider: Provider;
  model: string;
  // Never logged or recorded. Optional for a local model.
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface AskRequest {
  instructions: string;
  input: string;
  maxOutput: number;
  // Pictures read with the text (data: URLs): handwriting, a photo, or what
  // the monitor shows. Only for models that read images.
  images?: string[];
}

export interface GrowRequest extends AskRequest {
  onNode?: (raw: unknown) => void;
}

export interface GrowReply {
  summary: string;
  nodes: GrownNode[];
  usage: Usage;
}

export class ModelError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Raw {
  text: string;
  usage: Usage;
  truncated: boolean;
}

const dataUrl = /^data:([^;,]+);base64,(.*)$/s;

export class Model {
  constructor(
    readonly cfg: ModelConfig,
    readonly ledger: Ledger,
  ) {}

  get name() {
    return this.cfg.model;
  }

  async grow(r: GrowRequest): Promise<GrowReply> {
    const { value, usage } = await this.ask(r, "growth", GROWTH_SCHEMA);
    const parsed = value as { summary?: unknown; nodes?: unknown };
    const nodes = Array.isArray(parsed.nodes) ? (parsed.nodes as GrownNode[]) : [];
    for (const n of nodes) r.onNode?.(n);
    return { summary: typeof parsed.summary === "string" ? parsed.summary : "", nodes, usage };
  }

  // One structured request: reserve, send, settle, parse.
  async ask(
    r: AskRequest,
    name: string,
    schema: object,
  ): Promise<{ value: unknown; usage: Usage }> {
    if (!this.cfg.model.trim()) throw new ModelError("no_model", "choose a model in Settings");
    const reserved =
      estimateTokens(r.instructions + r.input) + 1500 * (r.images?.length ?? 0) + r.maxOutput;
    const ticket = this.ledger.reserve(reserved);
    let raw: Raw;
    try {
      raw =
        PROVIDERS[this.cfg.provider].protocol === "anthropic"
          ? await this.anthropic(r, name, schema)
          : await this.openai(r, name, schema);
    } catch (e) {
      if (e instanceof ModelError && e.code.startsWith("rejected")) this.ledger.cancel(ticket);
      else this.ledger.fail(ticket);
      throw e instanceof ModelError ? e : new ModelError("network", String(e));
    }
    this.ledger.settle(ticket, raw.usage);
    if (raw.truncated) throw new ModelError("length", "the answer did not fit in its output limit");
    try {
      return { value: JSON.parse(raw.text) as unknown, usage: raw.usage };
    } catch {
      throw new ModelError("unparsable", raw.text.slice(0, 200));
    }
  }

  private base() {
    return (this.cfg.baseUrl?.trim() || PROVIDERS[this.cfg.provider].baseUrl).replace(/\/+$/, "");
  }

  private async post(url: string, headers: Record<string, string>, body: object): Promise<unknown> {
    let res: Response;
    try {
      res = await (this.cfg.fetch ?? fetch)(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 180_000),
      });
    } catch (e) {
      throw new ModelError("network", e instanceof Error ? e.message : String(e));
    }
    const json = (await res.json().catch(() => ({}))) as {
      error?: { type?: string; code?: string; message?: string } | string;
    };
    if (!res.ok) {
      const err = typeof json.error === "string" ? { message: json.error } : json.error;
      // A request the provider refused before running it.
      throw new ModelError(
        `rejected_${String(res.status)}`,
        err?.message ?? (res.statusText || "the provider refused the request"),
      );
    }
    return json;
  }

  private async openai(r: AskRequest, name: string, schema: object): Promise<Raw> {
    const headers: Record<string, string> = {};
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    const content = r.images?.length
      ? [
          { type: "text", text: r.input },
          ...r.images.map((url) => ({ type: "image_url", image_url: { url } })),
        ]
      : r.input;
    // OpenAI's newer models take max_completion_tokens; the compatible
    // providers still read max_tokens.
    const limit =
      this.cfg.provider === "openai"
        ? { max_completion_tokens: r.maxOutput }
        : { max_tokens: r.maxOutput };
    const j = (await this.post(`${this.base()}/chat/completions`, headers, {
      model: this.cfg.model,
      messages: [
        { role: "system", content: r.instructions },
        { role: "user", content },
      ],
      response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
      ...limit,
    })) as {
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      };
      model?: string;
    };
    const choice = j.choices?.[0];
    const u = j.usage ?? {};
    return {
      text: choice?.message?.content ?? "",
      truncated: choice?.finish_reason === "length",
      usage: {
        model: j.model ?? this.cfg.model,
        input: u.prompt_tokens ?? 0,
        cached: u.prompt_tokens_details?.cached_tokens ?? 0,
        output: u.completion_tokens ?? 0,
        reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
      },
    };
  }

  // Anthropic returns structured output through a tool the model must call.
  private async anthropic(r: AskRequest, name: string, schema: object): Promise<Raw> {
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
      // The person calls the API from their own browser with their own key.
      "anthropic-dangerous-direct-browser-access": "true",
    };
    if (this.cfg.apiKey) headers["x-api-key"] = this.cfg.apiKey;
    const images = (r.images ?? []).flatMap((url) => {
      const m = dataUrl.exec(url);
      return m ? [{ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }] : [];
    });
    const j = (await this.post(`${this.base()}/messages`, headers, {
      model: this.cfg.model,
      max_tokens: r.maxOutput,
      system: r.instructions,
      messages: [{ role: "user", content: [...images, { type: "text", text: r.input }] }],
      tools: [{ name, description: `Return the ${name} answer.`, input_schema: schema }],
      tool_choice: { type: "tool", name },
    })) as {
      content?: { type?: string; name?: string; input?: unknown }[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
      model?: string;
    };
    const call = j.content?.find((c) => c.type === "tool_use" && c.name === name);
    const u = j.usage ?? {};
    const cached = u.cache_read_input_tokens ?? 0;
    return {
      text: call ? JSON.stringify(call.input) : "",
      truncated: j.stop_reason === "max_tokens",
      usage: {
        model: j.model ?? this.cfg.model,
        input: (u.input_tokens ?? 0) + cached,
        cached,
        output: u.output_tokens ?? 0,
        reasoning: 0,
      },
    };
  }
}
