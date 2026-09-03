import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("browser visibility rules", () => {
  it("keeps hidden dynamic UI hidden even when component display rules apply", () => {
    const css = readFileSync("public/styles.css", "utf8");

    expect(css).toMatch(/\[hidden\]\s*{\s*display:\s*none\s*!important;/);
  });
});
