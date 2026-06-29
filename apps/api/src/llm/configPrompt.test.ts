import { describe, it, expect } from "vitest";
import wireupRules from "@drafture/kb/terraform-wireup-rules.json" with { type: "json" };

import { renderTerraformWireupRules } from "./configPrompt.js";

describe("renderTerraformWireupRules", () => {
  // Mirrors ground.test.ts's "each baseline rule appears verbatim in staticPrefix":
  // every KB wire-up rule must reach the generateConfig prompt or the model has no
  // reason to emit the consequence.
  it("renders every KB wire-up rule and its rationale", () => {
    const rendered = renderTerraformWireupRules();
    for (const rule of wireupRules) {
      expect(rendered).toContain(`[${rule.id}]`);
      expect(rendered).toContain(rule.rule);
      expect(rendered).toContain(rule.rationale);
    }
  });

  it("frames the rules as mandatory runtime consequences (the reason they matter)", () => {
    expect(renderTerraformWireupRules()).toMatch(/FAILS at runtime/);
  });
});
