import { describe, expect, it } from "vitest";
import type { TurnRequest } from "./investigate";
import { extractJson, MetaApiError, MetaProvider } from "./meta";
import { RecordingProvider, ReplayProvider } from "./recorded";
import { ScriptedProvider } from "./scripted";

const request = (turn: number, effort: "low" | "medium" = "low"): TurnRequest => ({
  goal: "Does the reduction keep the period?",
  turn,
  effort,
  context: JSON.stringify({ head: turn, nodes: [] }),
  trace: [],
});

const decision = {
  action: "ask_researcher",
  question: "Which tolerance?",
  rationale: "r",
  cites: [],
};

function fakeApi(status = 200) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const f = (url: string, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
      string,
      unknown
    >;
    calls.push({ url, init: init ?? {}, body });
    const ok = {
      output: [
        { type: "reasoning", id: `rs${String(calls.length)}`, encrypted_content: "opaque" },
        {
          type: "message",
          content: [
            { type: "output_text", text: "```json\n" + JSON.stringify(decision) + "\n```" },
          ],
        },
      ],
      usage: {
        input_tokens: 900,
        output_tokens: 120,
        output_tokens_details: { reasoning_tokens: 80 },
      },
    };
    const err = { error: { code: "invalid_api_key", message: "bad key" } };
    return Promise.resolve(new Response(JSON.stringify(status === 200 ? ok : err), { status }));
  };
  return { calls, fetch: f as unknown as typeof fetch };
}

describe("MetaProvider", () => {
  it("asks Muse Spark at the requested effort and keeps the encrypted reasoning", async () => {
    const api = fakeApi();
    const p = new MetaProvider({ fetch: api.fetch });
    const first = await p.decide(request(1));
    expect(first.decision).toEqual(decision);
    expect(first.usage).toEqual({ input: 900, output: 120, reasoning: 80 });

    const sent = api.calls[0]!;
    expect(sent.url).toBe("https://api.meta.ai/v1/responses");
    expect(sent.body).toMatchObject({
      model: "muse-spark-1.3",
      reasoning: { effort: "low" },
      include: ["reasoning.encrypted_content"],
      store: false,
    });
    expect(new Headers(sent.init.headers).has("authorization")).toBe(false);

    await p.decide(request(2, "medium"));
    const input = api.calls[1]!.body.input as { type?: string; role?: string }[];
    expect(input.map((i) => i.type ?? i.role)).toEqual(["user", "reasoning", "message", "user"]);
    expect(api.calls[1]!.body.reasoning).toEqual({ effort: "medium" });
  });

  it("sends the key only when one is configured", async () => {
    const api = fakeApi();
    await new MetaProvider({ apiKey: "k", fetch: api.fetch }).decide(request(1));
    expect(new Headers(api.calls[0]!.init.headers).get("authorization")).toBe("Bearer k");
  });

  it("reports API errors by code", async () => {
    const p = new MetaProvider({ fetch: fakeApi(401).fetch });
    await expect(p.decide(request(1))).rejects.toMatchObject({
      status: 401,
      code: "invalid_api_key",
    });
    await expect(p.decide(request(1))).rejects.toBeInstanceOf(MetaApiError);
  });

  it("leaves unparsable text to the decision parser", () => {
    expect(extractJson("I think we should run s = 1")).toEqual({
      unparsable: "I think we should run s = 1",
    });
  });
});

describe("recorded turns", () => {
  it("replays exactly what was recorded and nothing else", async () => {
    const rec = new RecordingProvider(new ScriptedProvider([decision, decision]));
    await rec.decide(request(1));
    await rec.decide(request(2));

    const replay = new ReplayProvider(rec.recording);
    expect((await replay.decide(request(1))).decision).toEqual(decision);
    await expect(replay.decide(request(3))).rejects.toThrow(/differs from the recording/);
  });
});
