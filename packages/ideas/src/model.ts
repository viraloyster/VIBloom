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

// What in a value does not match a schema, or nothing. Covers what VIBloom's
// own schemas use: objects, arrays, strings, numbers, booleans and enums. A
// provider that enforces the schema never trips it; one that only promises
// JSON may.
export function mismatch(value: unknown, schema: unknown, at = "answer"): string | undefined {
  const s = schema as {
    type?: string;
    enum?: unknown[];
    properties?: Record<string, unknown>;
    required?: string[];
    items?: unknown;
  };
  if (s.enum && !s.enum.includes(value)) return `${at} is not one of ${s.enum.join(", ")}`;
  switch (s.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return `${at} is not an object`;
      const o = value as Record<string, unknown>;
      for (const k of s.required ?? []) if (!(k in o)) return `${at}.${k} is missing`;
      for (const [k, sub] of Object.entries(s.properties ?? {})) {
        if (!(k in o)) continue;
        const bad = mismatch(o[k], sub, `${at}.${k}`);
        if (bad) return bad;
      }
      return undefined;
    }
    case "array": {
      if (!Array.isArray(value)) return `${at} is not a list`;
      for (const [i, item] of value.entries()) {
        const bad = mismatch(item, s.items ?? {}, `${at}[${String(i)}]`);
        if (bad) return bad;
      }
      return undefined;
    }
    case "string":
      return typeof value === "string" ? undefined : `${at} is not text`;
    case "number":
    case "integer":
      return typeof value === "number" && Number.isFinite(value)
        ? undefined
        : `${at} is not a number`;
    case "boolean":
      return typeof value === "boolean" ? undefined : `${at} is not true or false`;
    default:
      return undefined;
  }
}

export interface ModelConfig {
  provider: Provider;
  model: string;
  // Never logged or recorded. Optional for a local model.
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  // Waits between attempts; tests pass one that does not sleep.
  sleep?: (ms: number) => Promise<void>;
}

// Overloaded or briefly unavailable: worth asking again.
const RETRY = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const ATTEMPTS = 3;

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
  // The model declined to answer, in its own words.
  refusal?: string | undefined;
}

const dataUrl = /^data:([^;,]+);base64,(.*)$/s;

export class Model {
  // Set once a provider turns down a strict JSON schema: from then on the
  // schema goes in the instructions and the answer is checked here.
  private plainJson = false;

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
    if (raw.refusal) throw new ModelError("refused", raw.refusal.slice(0, 300));
    if (raw.truncated) throw new ModelError("length", "the answer did not fit in its output limit");
    let value: unknown;
    try {
      // A model without schema enforcement may wrap its JSON in a code fence.
      const text = raw.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
      value = JSON.parse(text) as unknown;
    } catch {
      throw new ModelError("unparsable", raw.text.slice(0, 200));
    }
    const bad = mismatch(value, schema);
    if (bad) throw new ModelError("unparsable", `the answer did not follow the format: ${bad}`);
    return { value, usage: raw.usage };
  }

  private base() {
    return (this.cfg.baseUrl?.trim() || PROVIDERS[this.cfg.provider].baseUrl).replace(/\/+$/, "");
  }

  private async post(url: string, headers: Record<string, string>, body: object): Promise<unknown> {
    const sleep =
      this.cfg.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await (this.cfg.fetch ?? fetch)(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 180_000),
        });
      } catch (e) {
        // No answer at all: the request may or may not have run, so it is
        // not sent twice.
        throw new ModelError("network", e instanceof Error ? e.message : String(e));
      }
      const json = (await res.json().catch(() => ({}))) as {
        error?: { type?: string; code?: string; message?: string } | string;
      };
      if (res.ok) return json;
      if (RETRY.has(res.status) && attempt < ATTEMPTS) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(Math.min(20_000, after > 0 ? after * 1000 : 1500 * 2 ** (attempt - 1)));
        continue;
      }
      const err = typeof json.error === "string" ? { message: json.error } : json.error;
      // A request the provider refused before running it.
      throw new ModelError(
        `rejected_${String(res.status)}`,
        err?.message ?? (res.statusText || "the provider refused the request"),
      );
    }
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
    const send = () =>
      this.post(`${this.base()}/chat/completions`, headers, {
        model: this.cfg.model,
        messages: [
          {
            role: "system",
            content: this.plainJson
              ? `${r.instructions}\n\nAnswer with one JSON object and nothing else, following this JSON Schema exactly:\n${JSON.stringify(schema)}`
              : r.instructions,
          },
          { role: "user", content },
        ],
        response_format: this.plainJson
          ? { type: "json_object" }
          : { type: "json_schema", json_schema: { name, strict: true, schema } },
        ...limit,
      });
    let reply: unknown;
    try {
      reply = await send();
    } catch (e) {
      // Not every compatible server takes a strict schema; nothing ran, so
      // the same question goes again as plain JSON.
      const unsupported =
        e instanceof ModelError &&
        (e.code === "rejected_400" || e.code === "rejected_422") &&
        /response_format|json_schema|schema|strict|structured/i.test(e.message);
      if (this.plainJson || !unsupported) throw e;
      this.plainJson = true;
      reply = await send();
    }
    const j = reply as {
      choices?: {
        message?: { content?: string | null; refusal?: string | null };
        finish_reason?: string;
      }[];
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
      refusal: choice?.message?.refusal ?? undefined,
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
      refusal: j.stop_reason === "refusal" ? "the model declined to answer" : undefined,
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
