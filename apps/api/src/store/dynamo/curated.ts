/**
 * DynamoDB-backed CuratedStore. One `curated` table: the run lives at (id, sk="meta"),
 * each voter's vote at (id, sk=`vote#<voter>`). Counters are atomic `ADD`s on the meta
 * item; one-vote-per-voter is enforced by an OPTIMISTIC condition (the vote write
 * requires the existing vote's value to be unchanged since we read it), so a re-click
 * replaces the prior vote instead of stacking — same guarantee as the SQLite votes
 * table, without scanning all votes on every cast.
 *
 * `list` is a small filtered Scan (a handful of operator-curated runs) ranked in app.
 */
import {
  GetCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

import type { CuratedRun, CuratedRunSummary, CuratedStore, CuratedVoteResult } from "../types.js";
import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import type { DynamoDeps } from "./client.js";

const META = "meta";
const MAX_VOTE_ATTEMPTS = 8;

interface MetaItem {
  id: string;
  sk: string;
  title: string;
  prompt: string;
  body: string;
  upvotes: number;
  downvotes: number;
  hidden: boolean;
  createdAt: number;
}

function toSummary(item: MetaItem): CuratedRunSummary {
  return {
    id: item.id,
    title: item.title,
    prompt: item.prompt,
    tech: deriveTech(item.body),
    upvotes: item.upvotes,
    downvotes: item.downvotes,
    createdAt: item.createdAt,
  };
}

export class DynamoCuratedStore implements CuratedStore {
  constructor(
    private readonly deps: DynamoDeps,
    private readonly clock: Clock = systemClock,
  ) {}

  private get table(): string {
    return this.deps.table("curated");
  }

  async list(): Promise<CuratedRunSummary[]> {
    const res = await this.deps.doc.send(
      new ScanCommand({
        TableName: this.table,
        FilterExpression: "sk = :meta AND #hidden = :false",
        ExpressionAttributeNames: { "#hidden": "hidden" },
        ExpressionAttributeValues: { ":meta": META, ":false": false },
      }),
    );
    const runs = (res.Items ?? []) as MetaItem[];
    runs.sort((a, b) => b.upvotes - b.downvotes - (a.upvotes - a.downvotes) || b.createdAt - a.createdAt);
    return runs.map(toSummary);
  }

  async get(id: string): Promise<CuratedRun | undefined> {
    const res = await this.deps.doc.send(
      new GetCommand({ TableName: this.table, Key: { id, sk: META } }),
    );
    const item = res.Item as MetaItem | undefined;
    if (!item || item.hidden) return undefined;
    return { ...toSummary(item), body: item.body };
  }

  async setHidden(id: string, hidden: boolean): Promise<boolean> {
    try {
      await this.deps.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { id, sk: META },
          UpdateExpression: "SET #hidden = :hidden",
          ConditionExpression: "attribute_exists(id)",
          ExpressionAttributeNames: { "#hidden": "hidden" },
          ExpressionAttributeValues: { ":hidden": hidden },
        }),
      );
      return true;
    } catch (err) {
      if ((err as Error).name === "ConditionalCheckFailedException") return false;
      throw err;
    }
  }

  async upsert(run: { id: string; title: string; prompt: string; body: string }): Promise<void> {
    // Replace content, PRESERVE votes + hidden flag on conflict (if_not_exists) — a
    // re-seed keeps accumulated community signal and any suppression.
    await this.deps.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { id: run.id, sk: META },
        UpdateExpression:
          "SET title = :title, prompt = :prompt, body = :body, " +
          "createdAt = if_not_exists(createdAt, :now), upvotes = if_not_exists(upvotes, :z), " +
          "downvotes = if_not_exists(downvotes, :z), #hidden = if_not_exists(#hidden, :false)",
        ExpressionAttributeNames: { "#hidden": "hidden" },
        ExpressionAttributeValues: {
          ":title": run.title,
          ":prompt": run.prompt,
          ":body": run.body,
          ":now": this.clock.now(),
          ":z": 0,
          ":false": false,
        },
      }),
    );
  }

  async vote(id: string, voter: string, value: 1 | -1): Promise<CuratedVoteResult | undefined> {
    for (let attempt = 0; attempt < MAX_VOTE_ATTEMPTS; attempt++) {
      const metaRes = await this.deps.doc.send(
        new GetCommand({ TableName: this.table, Key: { id, sk: META }, ConsistentRead: true }),
      );
      const meta = metaRes.Item as MetaItem | undefined;
      if (!meta) return undefined;

      const voteRes = await this.deps.doc.send(
        new GetCommand({ TableName: this.table, Key: { id, sk: `vote#${voter}` }, ConsistentRead: true }),
      );
      const prior = (voteRes.Item?.value as 1 | -1 | undefined) ?? 0;
      if (prior === value) return { upvotes: meta.upvotes, downvotes: meta.downvotes }; // no-op re-click

      const du = (value === 1 ? 1 : 0) - (prior === 1 ? 1 : 0);
      const dd = (value === -1 ? 1 : 0) - (prior === -1 ? 1 : 0);

      try {
        await this.deps.doc.send(buildVoteTxn(this.table, id, META, voter, value, prior, du, dd, meta, this.clock.now()));
        return { upvotes: meta.upvotes + du, downvotes: meta.downvotes + dd };
      } catch (err) {
        if ((err as Error).name === "TransactionCanceledException") continue; // raced — re-read & retry
        throw err;
      }
    }
    throw new Error(`curated vote contention exceeded ${MAX_VOTE_ATTEMPTS} attempts for ${id}`);
  }
}

/**
 * The vote transaction (shared shape with generations): conditionally write the voter's
 * vote (guarded on the value we read, so a concurrent change forces a retry) and ADD the
 * counter deltas to the meta item (guarded on the counts we read).
 */
function buildVoteTxn(
  table: string,
  id: string,
  metaSk: string,
  voter: string,
  value: 1 | -1,
  prior: 1 | -1 | 0,
  du: number,
  dd: number,
  meta: { upvotes: number; downvotes: number },
  now: number,
): TransactWriteCommand {
  return new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: table,
          Item: { id, sk: `vote#${voter}`, value, createdAt: now },
          ConditionExpression: "attribute_not_exists(sk) OR #value = :prior",
          ExpressionAttributeNames: { "#value": "value" },
          ExpressionAttributeValues: { ":prior": prior },
        },
      },
      {
        Update: {
          TableName: table,
          Key: { id, sk: metaSk },
          UpdateExpression: "ADD upvotes :du, downvotes :dd",
          ConditionExpression: "attribute_exists(id) AND upvotes = :expUp AND downvotes = :expDown",
          ExpressionAttributeValues: {
            ":du": du,
            ":dd": dd,
            ":expUp": meta.upvotes,
            ":expDown": meta.downvotes,
          },
        },
      },
    ],
  });
}

/**
 * One-line tech blurb from the recommended tier's services — a verbatim mirror of the
 * SQLite store's deriveTech (kept local so the DynamoDB path doesn't import the
 * better-sqlite3 module just for a pure string helper). Defensive: malformed body → "".
 */
const TECH_SERVICE_LIMIT = 4;

function deriveTech(body: string): string {
  try {
    const design = JSON.parse(body) as {
      recommendedTier?: string;
      tiers?: { name: string; nodes?: { awsService?: string }[] }[];
    };
    const tiers = design.tiers ?? [];
    const tier = tiers.find((t) => t.name === design.recommendedTier) ?? tiers[0];
    const services = (tier?.nodes ?? [])
      .map((n) => n.awsService?.trim())
      .filter((s): s is string => !!s);
    return [...new Set(services)].slice(0, TECH_SERVICE_LIMIT).join(" · ");
  } catch {
    return "";
  }
}
