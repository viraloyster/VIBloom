// Finds Foundry invariant tests that the map does not list yet. They are added
// as protected invariants for a person to title and connect.

import type { RootNode, RootsMap } from "./map.ts";

export interface Found {
  file: string;
  contract: string;
  name: string;
}

export function findInvariants(file: string, source: string): Found[] {
  const contracts = [...source.matchAll(/\bcontract\s+([A-Za-z_]\w*)/g)].map((m) => ({
    name: m[1] ?? "",
    at: m.index,
  }));
  const out: Found[] = [];
  for (const m of source.matchAll(/\bfunction\s+(invariant_?\w*)\s*\(/g)) {
    const owner = contracts.filter((c) => c.at < m.index).at(-1);
    if (owner && m[1]) out.push({ file, contract: owner.name, name: m[1] });
  }
  return out;
}

const idFor = (name: string) =>
  `inv.${name
    .replace(/^invariant_?/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase()}`;

export function addFound(
  map: RootsMap,
  found: readonly Found[],
): { map: RootsMap; added: string[] } {
  const known = new Set(
    map.nodes.flatMap((n) => (n.test ? [`${n.test.file}:${n.test.name}`] : [])),
  );
  const ids = new Set(map.nodes.map((n) => n.id));
  const nodes = [...map.nodes];
  const added: string[] = [];
  for (const f of found) {
    if (known.has(`${f.file}:${f.name}`)) continue;
    let id = idFor(f.name);
    for (let i = 2; ids.has(id); i++) id = `${idFor(f.name)}-${String(i)}`;
    ids.add(id);
    const node: RootNode = {
      id,
      kind: "invariant",
      title: f.name,
      stance: "adopted",
      test: { file: f.file, contract: f.contract, name: f.name },
      watch: [],
      dependsOn: [],
      protected: true,
    };
    nodes.push(node);
    added.push(id);
  }
  return { map: { ...map, nodes }, added };
}
