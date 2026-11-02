import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Allowed workspace imports per package; see docs/architecture.md.
const boundaries = {
  contracts: [],
  engine: ["contracts"],
  chem: ["contracts"],
  search: ["contracts"],
  agent: ["contracts", "engine"],
};
const packages = Object.keys(boundaries);

const boundaryRules = Object.entries(boundaries).map(([name, allowed]) => ({
  files: [`packages/${name}/**/*.ts`],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: packages.filter((p) => !allowed.includes(p)).map((p) => `@vibloom/${p}`),
            message: `${name} may only import: ${allowed.join(", ") || "nothing"}.`,
          },
          { group: ["@vibloom/*/*"], message: "Import the package entry point only." },
          { group: ["../../*"], message: "Do not reach into another package." },
        ],
      },
    ],
  },
}));

export default tseslint.config(
  { ignores: ["**/node_modules/", "**/dist/", "**/.wrangler/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  { files: ["**/*.mjs"], ...tseslint.configs.disableTypeChecked },
  { files: ["scripts/**/*.mjs"], languageOptions: { globals: globals.node } },
  ...boundaryRules,
  {
    // Numerical kernels index arrays inside loops bounded by their lengths; tests
    // index fixtures they built themselves.
    files: [
      "packages/chem/src/**/*.ts",
      "packages/search/src/**/*.ts",
      "packages/engine/src/hash.ts",
      "**/*.test.ts",
    ],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
