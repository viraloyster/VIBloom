import { describe, expect, it } from "vitest";
import { BudgetExceeded, Ledger } from "./cost";
import { mismatch, Model, ModelError, type ModelConfig } from "./model";

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fake(status: number, reply: unknown, seen: Seen[]): typeof fetch {
  return (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: url instanceof Request ? url.url : url.toString(),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >,
    });
    return Promise.resolve(new Response(JSON.stringify(reply), { status }));
  };
}

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const ask = { instructions: "Answer.", input: "Is it ok?", maxOutput: 100 };

function model(cfg: Partial<ModelConfig>, f: typeof fetch, cap = 100_000) {
  return new Model(
    { provider: "openai", model: "m", apiKey: "k", fetch: f, ...cfg },
    new Ledger(cap),
  );
}

describe("OpenAI-compatible providers", () => {
  it("asks for JSON against the schema and reads the answer and usage", async () => {
    const seen: Seen[] = [];
    const m = model(
      { provider: "xai", model: "grok-x" },
      fake(
        200,
        {
          model: "grok-x",
          choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 50,
            completion_tokens: 7,
            prompt_tokens_details: { cached_tokens: 10 },
          },
        },
        seen,
      ),
    );
    const r = await m.ask(ask, "check", SCHEMA);
    expect(r.value).toEqual({ ok: true });
    expect(r.usage).toEqual({ model: "grok-x", input: 50, cached: 10, output: 7, reasoning: 0 });
    expect(seen[0]!.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(seen[0]!.headers.authorization).toBe("Bearer k");
    expect(seen[0]!.body).toMatchObject({
      model: "grok-x",
      max_tokens: 100,
      response_format: {
        type: "json_schema",
        json_schema: { name: "check", strict: true, schema: SCHEMA },
      },
    });
    expect(m.ledger.total).toBe(57);
  });

  it("uses max_completion_tokens for OpenAI, a custom base URL, and no key for a local model", async () => {
    const seen: Seen[] = [];
    const reply = { choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] };
    await model({}, fake(200, reply, seen)).ask(ask, "c", SCHEMA);
    expect(seen[0]!.body.max_completion_tokens).toBe(100);
    await model(
      { provider: "local", apiKey: "", baseUrl: "http://127.0.0.1:1234/v1/" },
      fake(200, reply, seen),
    ).ask(ask, "c", SCHEMA);
    expect(seen[1]!.url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(seen[1]!.headers.authorization).toBeUndefined();
  });

  it("reports a cut-off answer instead of parsing half of it", async () => {
    const m = model(
      {},
      fake(200, { choices: [{ message: { content: '{"ok":' }, finish_reason: "length" }] }, []),
    );
    await expect(m.ask(ask, "c", SCHEMA)).rejects.toMatchObject({ code: "length" });
  });
});

// Replies in order, one per request, recording what was sent.
function sequence(replies: [number, unknown][], seen: Seen[]): typeof fetch {
  let i = 0;
  return (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: url instanceof Request ? url.url : url.toString(),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >,
    });
    const [status, reply] = replies[Math.min(i++, replies.length - 1)]!;
    return Promise.resolve(new Response(JSON.stringify(reply), { status }));
  };
}

const good = { choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] };

describe("a provider that is busy, limited or less capable", () => {
  it("asks again after an overload and settles the budget once", async () => {
    const seen: Seen[] = [];
    const waits: number[] = [];
    const m = model(
      {
        fetch: sequence(
          [
            [429, { error: { message: "slow down" } }],
            [503, {}],
            [200, good],
          ],
          seen,
        ),
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      },
      sequence([], []),
    );
    expect((await m.ask(ask, "c", SCHEMA)).value).toEqual({ ok: true });
    expect(seen).toHaveLength(3);
    expect(waits).toEqual([1500, 3000]);
    expect(m.ledger.entries).toHaveLength(1);
  });

  it("gives up after three attempts and returns the reservation", async () => {
    const seen: Seen[] = [];
    const m = model(
      { fetch: sequence([[529, { error: "overloaded" }]], seen), sleep: () => Promise.resolve() },
      sequence([], []),
    );
    await expect(m.ask(ask, "c", SCHEMA)).rejects.toMatchObject({ code: "rejected_529" });
    expect(seen).toHaveLength(3);
    expect(m.ledger.total).toBe(0);
  });

  it("falls back to plain JSON when the server takes no strict schema, and remembers", async () => {
    const seen: Seen[] = [];
    const fenced = {
      choices: [{ message: { content: '```json\n{"ok":false}\n```' }, finish_reason: "stop" }],
    };
    const m = model(
      {
        provider: "local",
        fetch: sequence(
          [
            [400, { error: { message: "response_format json_schema is not supported" } }],
            [200, fenced],
            [200, good],
          ],
          seen,
        ),
      },
      sequence([], []),
    );
    expect((await m.ask(ask, "c", SCHEMA)).value).toEqual({ ok: false });
    expect(seen[1]!.body.response_format).toEqual({ type: "json_object" });
    const system = (seen[1]!.body.messages as { content: string }[])[0]!.content;
    expect(system).toContain('"required":["ok"]');
    // The next request goes straight to plain JSON.
    await m.ask(ask, "c", SCHEMA);
    expect(seen).toHaveLength(3);
    expect(seen[2]!.body.response_format).toEqual({ type: "json_object" });
  });

  it("does not take another kind of refused request for a missing feature", async () => {
    const seen: Seen[] = [];
    const m = model(
      { fetch: sequence([[400, { error: { message: "model not found" } }]], seen) },
      sequence([], []),
    );
    await expect(m.ask(ask, "c", SCHEMA)).rejects.toMatchObject({ code: "rejected_400" });
    expect(seen).toHaveLength(1);
  });

  it("refuses an answer that is JSON but not the format asked for", async () => {
    const wrong = { choices: [{ message: { content: '{"ok":"yes"}' }, finish_reason: "stop" }] };
    await expect(model({}, fake(200, wrong, [])).ask(ask, "c", SCHEMA)).rejects.toMatchObject({
      code: "unparsable",
      message: "the answer did not follow the format: answer.ok is not true or false",
    });
  });

  it("reports a model that declines to answer", async () => {
    const declined = {
      choices: [
        { message: { content: null, refusal: "I cannot help with that" }, finish_reason: "stop" },
      ],
    };
    await expect(model({}, fake(200, declined, [])).ask(ask, "c", SCHEMA)).rejects.toMatchObject({
      code: "refused",
      message: "I cannot help with that",
    });
  });
});

describe("checking an answer against its schema", () => {
  const schema = {
    type: "object",
    required: ["intent", "nodes"],
    properties: {
      intent: { type: "string", enum: ["answer", "run"] },
      nodes: {
        type: "array",
        items: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" }, n: { type: "number" } },
        },
      },
    },
  };
  it("accepts what fits and names the first thing that does not", () => {
    expect(mismatch({ intent: "run", nodes: [{ id: "a", n: 1 }] }, schema)).toBeUndefined();
    expect(mismatch({ intent: "fly", nodes: [] }, schema)).toBe(
      "answer.intent is not one of answer, run",
    );
    expect(mismatch({ intent: "run", nodes: [{ id: "a" }, { n: 2 }] }, schema)).toBe(
      "answer.nodes[1].id is missing",
    );
    expect(mismatch({ intent: "run", nodes: [{ id: "a", n: "x" }] }, schema)).toBe(
      "answer.nodes[0].n is not a number",
    );
    expect(mismatch([], schema)).toBe("answer is not an object");
  });
});

describe("Anthropic", () => {
  it("gets structured output through a forced tool call, with images as base64", async () => {
    const seen: Seen[] = [];
    const m = model(
      { provider: "anthropic", model: "claude-sonnet-5-5" },
      fake(
        200,
        {
          model: "claude-sonnet-5-5",
          content: [{ type: "tool_use", name: "check", input: { ok: false } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 40, output_tokens: 9, cache_read_input_tokens: 20 },
        },
        seen,
      ),
    );
    const r = await m.ask({ ...ask, images: ["data:image/png;base64,AAAA"] }, "check", SCHEMA);
    expect(r.value).toEqual({ ok: false });
    expect(r.usage).toEqual({
      model: "claude-sonnet-5-5",
      input: 60,
      cached: 20,
      output: 9,
      reasoning: 0,
    });
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0]!.headers["x-api-key"]).toBe("k");
    expect(seen[0]!.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(seen[0]!.body).toMatchObject({
      system: "Answer.",
      tool_choice: { type: "tool", name: "check" },
      tools: [{ name: "check", input_schema: SCHEMA }],
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            { type: "text", text: "Is it ok?" },
          ],
        },
      ],
    });
  });
});

describe("the session budget", () => {
  it("refuses a request that could exceed it, before sending anything", async () => {
    const seen: Seen[] = [];
    const m = model({}, fake(200, {}, seen), 10);
    await expect(m.ask(ask, "c", SCHEMA)).rejects.toBeInstanceOf(BudgetExceeded);
    expect(seen).toEqual([]);
  });

  it("returns the reservation when the provider refuses, and counts it when the call fails midway", async () => {
    const refused = model({}, fake(401, { error: { message: "bad key" } }, []));
    await expect(refused.ask(ask, "c", SCHEMA)).rejects.toEqual(
      new ModelError("rejected_401", "bad key"),
    );
    expect(refused.ledger.total).toBe(0);
    const broken = model({}, () => Promise.reject(new Error("socket closed")));
    await expect(broken.ask(ask, "c", SCHEMA)).rejects.toMatchObject({ code: "network" });
    expect(broken.ledger.total).toBeGreaterThan(0);
  });

  it("asks for a model name before anything else", async () => {
    await expect(
      model({ model: " " }, fake(200, {}, [])).ask(ask, "c", SCHEMA),
    ).rejects.toMatchObject({
      code: "no_model",
    });
  });
});
