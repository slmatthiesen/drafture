import { describe, it, expect } from "vitest";

import { detectWireupGaps } from "../../../routes/config.js";
import type { ArchitectureEdge, ArchitectureNode, Tier } from "../../../schema/architecture.js";

import { assembleTier } from "../assemble.js";
import { normalizeServiceKey } from "../serviceKey.js";

const n = (id: string, awsService: string, role: string, security: string[] = []): ArchitectureNode => ({
  id,
  awsService,
  role,
  security,
});
const e = (from: string, to: string, payload = "data", protocol = "local"): ArchitectureEdge => ({
  from,
  to,
  payload,
  protocol,
});

/** A stateful single-box tier: an EC2 app server with a durable SQLite data volume —
 *  the self-host shape. Previously the EBS node routed the whole tier to the LLM. */
function statefulTier(name: "budget" | "balanced" = "budget", volumes = 1): Tier {
  const nodes: ArchitectureNode[] = [n("box", "EC2 (t4g.small)", "app server", ["IMDSv2"])];
  const edges: ArchitectureEdge[] = [e("client", "box", "request", "HTTPS")];
  for (let i = 0; i < volumes; i++) {
    const id = volumes === 1 ? "data" : `data${i}`;
    nodes.push(n(id, "EBS (gp3, 50 GB)", "SQLite data volume", ["encrypted at rest"]));
    edges.push(e("box", id, "read/write", "local"));
  }
  return {
    name,
    summary: "single EC2 box with a durable EBS data volume",
    nodes,
    edges,
    delta: [],
    costDrivers: [],
    tradeoffs: ["single box over managed datastore"],
  } as Tier;
}

describe("deterministic Terraform — standalone EBS data volume", () => {
  const { code, coverage, gaps } = assembleTier(statefulTier(), { region: "us-east-1" });

  it("normalizes a standalone volume to 'ebs' (not 'unsupported'), without stealing ec2/s3", () => {
    expect(normalizeServiceKey({ awsService: "EBS (gp3, 20 GB)", role: "data volume" })).toBe("ebs");
    expect(normalizeServiceKey({ awsService: "Elastic Block Store", role: "data" })).toBe("ebs");
    // Regressions: the EC2 root device and S3 are unaffected.
    expect(normalizeServiceKey({ awsService: "EC2 (t4g.small)", role: "app" })).toBe("ec2");
    expect(normalizeServiceKey({ awsService: "Amazon S3", role: "assets" })).toBe("s3");
  });

  it("templates the whole stateful tier with zero wire-up gaps", () => {
    expect(coverage.unsupported).toEqual([]);
    expect(coverage.ratio).toBe(1);
    expect(gaps).toEqual([]);
    expect(detectWireupGaps(code)).toEqual([]);
  });

  it("emits an encrypted gp3 volume, attaches it to the box, and parses the size", () => {
    expect(code).toContain('resource "aws_ebs_volume" "data"');
    expect(code).toContain("size              = 50");
    expect(code).toContain("type              = \"gp3\"");
    expect(code).toContain("encrypted         = true");
    expect(code).toContain('resource "aws_volume_attachment" "data"');
    expect(code).toContain("instance_id = aws_instance.box.id");
    expect(code).toContain('Backup = "daily"');
  });

  it("emits a daily DLM snapshot policy for durability", () => {
    expect(code).toContain('resource "aws_dlm_lifecycle_policy" "ebs_daily"');
    expect(code).toContain('target_tags    = { Backup = "daily" }');
    expect(code).toContain('resource "aws_iam_role" "dlm"');
  });

  it("defaults to 20 GB when no size is stated", () => {
    const bare = assembleTier(
      {
        name: "budget",
        summary: "box + unsized volume",
        nodes: [n("box", "EC2", "app"), n("data", "EBS", "state")],
        edges: [e("client", "box"), e("box", "data")],
        delta: [],
        costDrivers: [],
        tradeoffs: [],
      } as Tier,
      { region: "us-east-1" },
    );
    expect(bare.code).toContain("size              = 20");
  });

  it("emits the DLM policy ONCE even with multiple volumes (deduped)", () => {
    const { code: multi } = assembleTier(statefulTier("budget", 2), { region: "us-east-1" });
    const dlmCount = multi.split('aws_dlm_lifecycle_policy" "ebs_daily"').length - 1;
    expect(dlmCount).toBe(1);
  });

  it("budget uses the free at-rest key; the paid tier encrypts the volume with the CMK", () => {
    // None-sensitivity budget: no customer CMK reference on the volume.
    expect(code).not.toContain("kms_key_id        = aws_kms_key.main.arn");
    const paid = assembleTier(statefulTier("balanced"), { region: "us-east-1" });
    expect(paid.code).toContain("kms_key_id        = aws_kms_key.main.arn");
    expect(paid.coverage.ratio).toBe(1);
    expect(paid.gaps).toEqual([]);
  });
});
