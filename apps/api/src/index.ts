import { DurableObject } from "cloudflare:workers";
import type { Event, Submission } from "@vibloom/engine";
import { MetaProvider } from "@vibloom/agent";
import {
  ProjectService,
  type EventStore,
  type InvestigationStore,
  type StoredInvestigation,
} from "./service";

interface Env {
  PROJECT: DurableObjectNamespace<ProjectObject>;
  // Worker secret; locally in .dev.vars. Never logged or recorded.
  MODEL_API_KEY?: string;
}

const MAX_BODY = 1_000_000;

class SqlEventStore implements EventStore {
  private readonly sql: SqlStorage;
  constructor(sql: SqlStorage) {
    this.sql = sql;
    sql.exec("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  }
  all(): Event[] {
    return this.sql
      .exec<{ body: string }>("SELECT body FROM events ORDER BY seq")
      .toArray()
      .map((r) => JSON.parse(r.body) as Event);
  }
  append(e: Event) {
    this.sql.exec("INSERT INTO events (seq, body) VALUES (?, ?)", e.seq, JSON.stringify(e));
  }
}

class SqlInvestigationStore implements InvestigationStore {
  private readonly sql: SqlStorage;
  constructor(sql: SqlStorage) {
    this.sql = sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS investigations (n INTEGER PRIMARY KEY, body TEXT NOT NULL)",
    );
  }
  all(): StoredInvestigation[] {
    return this.sql
      .exec<{ body: string }>("SELECT body FROM investigations ORDER BY n")
      .toArray()
      .map((r) => JSON.parse(r.body) as StoredInvestigation);
  }
  count(): number {
    return this.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM investigations").one().c;
  }
  append(r: StoredInvestigation) {
    this.sql.exec("INSERT INTO investigations (body) VALUES (?)", JSON.stringify(r));
  }
}

// One object per project: its single thread serialises every write.
export class ProjectObject extends DurableObject<Env> {
  private readonly service: ProjectService;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.service = new ProjectService(
      new SqlEventStore(ctx.storage.sql),
      new SqlInvestigationStore(ctx.storage.sql),
    );
  }

  seed() {
    return this.service.seed();
  }
  command(body: unknown) {
    // Approval needs an authenticated person; there is no sign-in yet.
    return this.service.command(body, false);
  }
  run(body: unknown) {
    return this.service.run(body);
  }
  view() {
    return this.service.view();
  }
  events() {
    return this.service.events();
  }
  verify() {
    return this.service.verify();
  }
  async investigate(body: unknown) {
    const goal =
      typeof body === "object" && body !== null ? (body as { goal?: unknown }).goal : undefined;
    if (!this.env.MODEL_API_KEY) {
      return { ok: false as const, code: "unavailable", detail: "the model is not configured" };
    }
    return this.service.investigate(goal, new MetaProvider({ apiKey: this.env.MODEL_API_KEY }));
  }
  // As JSON text: recorded model replies are arbitrary JSON, which RPC types
  // cannot describe.
  investigations(): string {
    return JSON.stringify(this.service.listInvestigations());
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const STATUS: Record<string, number> = {
  invalid_input: 400,
  not_found: 404,
  forbidden: 403,
  needs_approval: 403,
  stale_base: 409,
  conflict: 409,
  duplicate_command: 409,
  unavailable: 503,
};

const answer = (r: Submission | { ok: boolean; code?: string }) =>
  json(r, r.ok ? 200 : (STATUS[r.code ?? ""] ?? 400));

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new RangeError("body too large");
  return JSON.parse(text) as unknown;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/api\/projects\/([a-z0-9-]{1,64})(\/[a-z]+)?$/.exec(url.pathname);
    if (!match) return json({ ok: false, code: "not_found", detail: "no such route" }, 404);
    const project = env.PROJECT.get(env.PROJECT.idFromName(match[1] ?? ""));
    const route = `${request.method} ${match[2] ?? ""}`;

    try {
      switch (route) {
        case "GET ":
          return json(await project.view());
        case "GET /events":
          return json(await project.events());
        case "GET /verify":
          return json(await project.verify());
        case "POST /seed":
          return answer(await project.seed());
        case "POST /commands":
          return answer(await project.command(await readBody(request)));
        case "POST /runs":
          return answer(await project.run(await readBody(request)));
        case "POST /investigations":
          return answer(await project.investigate(await readBody(request)));
        case "GET /investigations":
          return new Response(await project.investigations(), {
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        default:
          return json({ ok: false, code: "not_found", detail: "no such route" }, 404);
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        return json({ ok: false, code: "invalid_input", detail: "body is not JSON" }, 400);
      }
      if (e instanceof RangeError) {
        return json({ ok: false, code: "invalid_input", detail: e.message }, 400);
      }
      return json({ ok: false, code: "internal", detail: "internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
