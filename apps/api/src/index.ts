import { DurableObject } from "cloudflare:workers";
import type { Event, Submission } from "@vibloom/engine";
import { ProjectService, type EventStore } from "./service";

interface Env {
  PROJECT: DurableObjectNamespace<ProjectObject>;
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

// One object per project: its single thread serialises every write.
export class ProjectObject extends DurableObject<Env> {
  private readonly service: ProjectService;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.service = new ProjectService(new SqlEventStore(ctx.storage.sql));
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
};

const answer = (r: Submission) => json(r, r.ok ? 200 : (STATUS[r.code] ?? 400));

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
