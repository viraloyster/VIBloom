import type { Investigation } from "@vibloom/agent";
import type { DependsOn, ExperimentNode, ResultRecord, RootNode } from "@vibloom/contracts";
import type { ClaimView, LessonView, ResultView } from "@vibloom/engine";

export interface ProjectView {
  head: number;
  lastHash: string;
  nodes: RootNode[];
  edges: DependsOn[];
  results: { record: ResultRecord; view: ResultView }[];
  claims: (ClaimView | undefined)[];
  experiments: ExperimentNode[];
  lessons: (LessonView | undefined)[];
}

export interface StoredInvestigation {
  id: string;
  started: string;
  finished: string;
  investigation: Investigation;
}

export interface Failure {
  ok: false;
  code: string;
  detail: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  return (await res.json()) as T;
}

export class Api {
  private readonly base: string;

  constructor(project: string) {
    this.base = `/api/projects/${encodeURIComponent(project)}`;
  }

  view() {
    return call<ProjectView>(this.base);
  }
  investigations() {
    return call<StoredInvestigation[]>(`${this.base}/investigations`);
  }
  verify() {
    return call<{ ok: boolean; head?: string; events?: number }>(`${this.base}/verify`);
  }
  seed() {
    return call<{ ok: boolean } | Failure>(`${this.base}/seed`, { method: "POST" });
  }
  investigate(goal: string, focus?: string) {
    return call<{ ok: true; investigation: StoredInvestigation } | Failure>(
      `${this.base}/investigations`,
      { method: "POST", body: JSON.stringify({ goal, focus }) },
    );
  }
}
