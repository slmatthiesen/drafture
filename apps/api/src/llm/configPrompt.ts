/**
 * Static Terraform-generation prompt segment: the AWS wire-up rules appended to
 * the `generateConfig` system prompt. Mirrors `renderSecurityBaselines()` in
 * `pipeline/ground.ts` — pure, deterministic, identical bytes every call, so it
 * rides inside the provider's cached system block (KTD11) at ~$0 on cache hits.
 *
 * WHY this exists separately from the security baselines: the baselines state the
 * POLICY ("encrypt all data at rest"); these state the runtime CONSEQUENCE ("a CMK
 * encrypting CloudWatch Logs needs a key policy granting the Logs principal").
 * `terraform plan` stays green on the omission, so the model emits the resource
 * and silently drops the wire-up unless told — exactly the class of bug found in a
 * real generated reference file (CMK with no key policy, ACM cert with no
 * validation resource, https-only origin on an EC2 public_dns, …).
 *
 * Single-sourced here so both providers (Claude, GLM) emit identical bytes and
 * stay cache-aligned, rather than duplicating the rules text in each.
 */
import wireupRules from "@drafture/kb/terraform-wireup-rules.json" with { type: "json" };
import type { TerraformWireupRule } from "@drafture/kb";

const rules = wireupRules as TerraformWireupRule[];

export function renderTerraformWireupRules(): string {
  const lines = rules.map(
    (r, i) => `${i + 1}. [${r.id}] ${r.rule}\n   Why: ${r.rationale}`,
  );
  return [
    "TERRAFORM WIRE-UP — each rule below is a REQUIRED consequence of a resource you may emit. `terraform plan` stays green if you omit one, but the resource FAILS at runtime, so apply every rule relevant to what you emit:",
    ...lines,
  ].join("\n");
}
