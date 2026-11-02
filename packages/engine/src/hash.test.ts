import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonical, sha256 } from "./hash";

describe("sha256", () => {
  it("matches the FIPS 180-2 vectors", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("matches the platform implementation across block boundaries", () => {
    for (const n of [1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const text = "aé".repeat(n);
      expect(sha256(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
  });
});

describe("canonical", () => {
  it("does not depend on key order", () => {
    expect(canonical({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } })).toBe(
      canonical({ a: { c: null, d: [2, { x: 2, y: 1 }] }, b: 1 }),
    );
  });
});
