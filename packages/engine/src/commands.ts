import type { AssumptionNode, DependsOn, ResultRecord, RootNode } from "@vibloom/contracts";

export type Actor = "human" | "agent" | "engine";

// Nodes enter at revision 1; the engine assigns it.
export type NewNode = RootNode extends infer N
  ? N extends RootNode
    ? Omit<N, "revision">
    : never
  : never;

export type Op =
  | { op: "add_node"; node: NewNode }
  | {
      op: "set_assumption";
      id: string;
      expectedRevision: number;
      change: Partial<Pick<AssumptionNode, "statement" | "scope" | "state">>;
    }
  | { op: "add_edge"; edge: DependsOn }
  | { op: "confirm_edge"; from: string; to: string }
  | { op: "record_result"; result: ResultRecord }
  // A person's explicit decision; the model cannot retire what it learned.
  | { op: "retire_lesson"; id: string; expectedRevision: number; reason: string }
  // Never accepted. They exist so attempts are rejected by name, not ignored.
  | { op: "delete_result"; id: string }
  | { op: "edit_result"; result: ResultRecord }
  | { op: "edit_invariant"; id: string }
  | { op: "edit_claim"; id: string }
  | { op: "set_verdict"; claim: string; verdict: string };

export interface Command {
  commandId: string;
  actor: Actor;
  // The head this command was built on; anything older is rejected.
  baseHead: number;
  ops: Op[];
  // Only a human can approve, and only for their own command.
  approved?: boolean;
}

export type RejectionCode =
  | "stale_base"
  | "conflict"
  | "duplicate_command"
  | "forbidden"
  | "needs_approval"
  | "invalid_input"
  | "not_found"
  // The event could not be stored; nothing changed.
  | "storage_failed";

export interface Rejection {
  ok: false;
  code: RejectionCode;
  op?: number;
  detail: string;
}
