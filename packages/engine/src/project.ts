// A project: its hash-chained event log and the state projected from it.

import type { Contract } from "@vibloom/contracts";
import type { Actor, Command, Op, Rejection } from "./commands";
import { canonical, sha256 } from "./hash";
import { parseCommand } from "./parse";
import { applyOps, cloneState, emptyState, type State } from "./state";

export interface Event {
  seq: number;
  commandId: string;
  actor: Actor;
  approved: boolean;
  // Supplied by the caller; replay never regenerates it.
  at: string;
  ops: Op[];
  digest: string;
  prevHash: string;
  hash: string;
}

export type Submission = { ok: true; event: Event; duplicate: boolean } | Rejection;

export type Prepared =
  | { ok: true; event: Event; duplicate: true }
  | { ok: true; event: Event; duplicate: false; publish: () => void }
  | Rejection;

const commandDigest = (c: Command) =>
  sha256(canonical({ actor: c.actor, approved: c.approved ?? false, ops: c.ops }));

function eventHash(e: Omit<Event, "hash">) {
  return sha256(canonical(e));
}

export class Project {
  private readonly rules: Contract;
  private current: State = emptyState();
  private readonly log: Event[] = [];
  private readonly commands = new Map<string, Event>();

  constructor(contract: Contract) {
    this.rules = structuredClone(contract);
  }

  get contract(): Contract {
    return structuredClone(this.rules);
  }

  // Callers get copies: changing them cannot bypass the gate.
  get state(): State {
    return cloneState(this.current);
  }

  get head(): number {
    return this.current.head;
  }

  get events(): Event[] {
    return structuredClone(this.log);
  }

  // Takes unknown input: commands arrive as JSON from the API and the agent.
  submit(input: unknown, at: string): Submission {
    const prepared = this.prepare(input, at);
    if (!prepared.ok || prepared.duplicate) return prepared;
    prepared.publish();
    return { ok: true, event: prepared.event, duplicate: false };
  }

  // Validates a command and builds its event without changing the project.
  // The caller persists the event first and then publishes it, so memory never
  // runs ahead of storage.
  prepare(input: unknown, at: string): Prepared {
    const parsed = parseCommand(input);
    if (!parsed.ok) return { ok: false, code: "invalid_input", detail: parsed.detail };
    const command = parsed.command;
    const digest = commandDigest(command);
    const seen = this.commands.get(command.commandId);
    if (seen) {
      return seen.digest === digest
        ? { ok: true, event: structuredClone(seen), duplicate: true }
        : { ok: false, code: "duplicate_command", detail: "command id reused with other content" };
    }
    if (command.baseHead !== this.current.head) {
      return {
        ok: false,
        code: "stale_base",
        detail: `built on ${String(command.baseHead)}, head is ${String(this.current.head)}`,
      };
    }
    const approved = command.approved ?? false;
    const applied = applyOps(this.current, command.ops, command.actor, approved, this.rules);
    if (!applied.ok) return applied;

    const body = {
      seq: this.current.head + 1,
      commandId: command.commandId,
      actor: command.actor,
      approved,
      at,
      ops: structuredClone(command.ops),
      digest,
      prevHash: this.current.lastHash,
    };
    const event: Event = { ...body, hash: eventHash(body) };
    const next = applied.state;
    next.head = event.seq;
    next.lastHash = event.hash;
    const base = this.current;
    return {
      ok: true,
      event: structuredClone(event),
      duplicate: false,
      publish: () => {
        if (this.current !== base) throw new Error("the project changed after prepare");
        this.current = next;
        this.log.push(event);
        this.commands.set(command.commandId, event);
      },
    };
  }

  // Rebuilds a project from its log, checking the chain and every op again.
  static replay(
    contract: Contract,
    events: readonly Event[],
  ): { ok: true; project: Project } | { ok: false; seq: number; detail: string } {
    const p = new Project(contract);
    for (const e of events) {
      const { hash, ...body } = e;
      if (e.seq !== p.current.head + 1) return { ok: false, seq: e.seq, detail: "sequence gap" };
      if (e.prevHash !== p.current.lastHash)
        return { ok: false, seq: e.seq, detail: "broken chain" };
      if (eventHash(body) !== hash) return { ok: false, seq: e.seq, detail: "hash mismatch" };
      const parsed = parseCommand({
        commandId: e.commandId,
        actor: e.actor,
        baseHead: p.current.head,
        ops: e.ops,
        approved: e.approved,
      });
      if (!parsed.ok) return { ok: false, seq: e.seq, detail: parsed.detail };
      if (commandDigest(parsed.command) !== e.digest) {
        return { ok: false, seq: e.seq, detail: "digest mismatch" };
      }
      const applied = applyOps(p.current, e.ops, e.actor, e.approved, contract);
      if (!applied.ok) return { ok: false, seq: e.seq, detail: applied.detail };
      applied.state.head = e.seq;
      applied.state.lastHash = hash;
      p.current = applied.state;
      const own = structuredClone(e);
      p.log.push(own);
      p.commands.set(e.commandId, own);
    }
    return { ok: true, project: p };
  }
}
