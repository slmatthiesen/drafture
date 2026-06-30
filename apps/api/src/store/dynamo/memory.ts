/**
 * DynamoDB-backed MemoryStore. PK=`id`; a `topic-index` GSI (PK topic, SK updatedAt)
 * serves `get`/`search`. `listPending` is a small filtered Scan — the KB corpus is a
 * few dozen seeded docs, so it never grows into a hot path (documented in the plan).
 */
import {
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

import type { MemoryStore, MemoryDoc } from "../types.js";
import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import type { DynamoDeps } from "./client.js";

type UpsertInput = Omit<MemoryDoc, "createdAt" | "updatedAt"> &
  Partial<Pick<MemoryDoc, "createdAt" | "updatedAt">>;

function toDoc(item: Record<string, unknown>): MemoryDoc {
  return {
    id: item.id as string,
    topic: item.topic as string,
    fact: item.fact as string,
    rationale: item.rationale as string,
    source: item.source as string,
    verified: item.verified === true,
    provenance: item.provenance as MemoryDoc["provenance"],
    createdAt: item.createdAt as number,
    updatedAt: item.updatedAt as number,
  };
}

export class DynamoMemoryStore implements MemoryStore {
  constructor(
    private readonly deps: DynamoDeps,
    private readonly clock: Clock = systemClock,
  ) {}

  private get table(): string {
    return this.deps.table("memory");
  }

  async upsert(doc: UpsertInput): Promise<MemoryDoc> {
    const now = this.clock.now();
    // Preserve createdAt across overwrites (if_not_exists), refresh everything else —
    // mirrors the SQLite ON CONFLICT path. ALL_NEW returns the canonical stored row.
    const res = await this.deps.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { id: doc.id },
        UpdateExpression:
          "SET #topic = :topic, #fact = :fact, #rationale = :rationale, #source = :source, " +
          "#verified = :verified, #provenance = :provenance, " +
          "#createdAt = if_not_exists(#createdAt, :createdAt), #updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#topic": "topic",
          "#fact": "fact",
          "#rationale": "rationale",
          "#source": "source",
          "#verified": "verified",
          "#provenance": "provenance",
          "#createdAt": "createdAt",
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":topic": doc.topic,
          ":fact": doc.fact,
          ":rationale": doc.rationale,
          ":source": doc.source,
          ":verified": doc.verified,
          ":provenance": doc.provenance,
          ":createdAt": doc.createdAt ?? now,
          ":updatedAt": doc.updatedAt ?? now,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return toDoc(res.Attributes as Record<string, unknown>);
  }

  async get(topic: string): Promise<MemoryDoc | undefined> {
    const res = await this.deps.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "topic-index",
        KeyConditionExpression: "#topic = :topic",
        ExpressionAttributeNames: { "#topic": "topic" },
        ExpressionAttributeValues: { ":topic": topic },
        ScanIndexForward: false, // newest updatedAt first
        Limit: 1,
      }),
    );
    const item = res.Items?.[0];
    return item ? toDoc(item) : undefined;
  }

  async getById(id: string): Promise<MemoryDoc | undefined> {
    const res = await this.deps.doc.send(new GetCommand({ TableName: this.table, Key: { id } }));
    return res.Item ? toDoc(res.Item) : undefined;
  }

  async search(topics: string[]): Promise<MemoryDoc[]> {
    if (topics.length === 0) return [];
    const perTopic = await Promise.all(
      topics.map((topic) =>
        this.deps.doc.send(
          new QueryCommand({
            TableName: this.table,
            IndexName: "topic-index",
            KeyConditionExpression: "#topic = :topic",
            ExpressionAttributeNames: { "#topic": "topic" },
            ExpressionAttributeValues: { ":topic": topic },
            ScanIndexForward: false,
          }),
        ),
      ),
    );
    const docs = perTopic.flatMap((r) => (r.Items ?? []).map(toDoc));
    // Match SQLite's `ORDER BY updated_at DESC` across all matched topics.
    docs.sort((a, b) => b.updatedAt - a.updatedAt);
    return docs;
  }

  async listPending(): Promise<MemoryDoc[]> {
    const res = await this.deps.doc.send(
      new ScanCommand({
        TableName: this.table,
        FilterExpression: "#verified = :false",
        ExpressionAttributeNames: { "#verified": "verified" },
        ExpressionAttributeValues: { ":false": false },
      }),
    );
    const docs = (res.Items ?? []).map(toDoc);
    docs.sort((a, b) => a.createdAt - b.createdAt); // ORDER BY created_at ASC
    return docs;
  }

  async setVerified(id: string, verified: boolean): Promise<boolean> {
    try {
      await this.deps.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { id },
          UpdateExpression: "SET #verified = :verified, #updatedAt = :now",
          ConditionExpression: "attribute_exists(id)",
          ExpressionAttributeNames: { "#verified": "verified", "#updatedAt": "updatedAt" },
          ExpressionAttributeValues: { ":verified": verified, ":now": this.clock.now() },
        }),
      );
      return true;
    } catch (err) {
      if ((err as Error).name === "ConditionalCheckFailedException") return false;
      throw err;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.deps.doc.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { id },
          ConditionExpression: "attribute_exists(id)",
        }),
      );
      return true;
    } catch (err) {
      if ((err as Error).name === "ConditionalCheckFailedException") return false;
      throw err;
    }
  }
}
