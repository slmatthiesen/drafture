/**
 * DynamoDB-backed design-embedding corpus. PK=`id`; a `model-index` GSI (PK model)
 * pulls the same-model corpus for `search`/`count`. The vector is stored as a Binary
 * attribute (the little-endian Float32 blob from vectorMath) — compact and exact — and
 * cosine is ranked in app, identical to the SQLite path (small corpus, sub-ms). A
 * vector-index backend can replace this behind the same interface unchanged.
 */
import {
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

import type { DesignSource, DesignVectorMatch, DesignVectorStore } from "../types.js";
import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import { blobToVector, cosineSimilarity, vectorToBlob } from "../vectorMath.js";
import type { DynamoDeps } from "./client.js";

export class DynamoDesignVectorStore implements DesignVectorStore {
  constructor(
    private readonly deps: DynamoDeps,
    private readonly clock: Clock = systemClock,
  ) {}

  private get table(): string {
    return this.deps.table("designVectors");
  }

  async upsert(input: {
    id: string;
    source: DesignSource;
    promptHash: string;
    text: string;
    vector: number[];
    model: string;
  }): Promise<void> {
    await this.deps.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          id: input.id,
          source: input.source,
          promptHash: input.promptHash,
          text: input.text,
          vector: vectorToBlob(input.vector),
          dim: input.vector.length,
          model: input.model,
          createdAt: this.clock.now(),
        },
      }),
    );
  }

  async hasForModel(id: string, model: string): Promise<boolean> {
    const res = await this.deps.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { id },
        ProjectionExpression: "#model",
        ExpressionAttributeNames: { "#model": "model" },
      }),
    );
    return res.Item?.model === model;
  }

  async count(model: string): Promise<number> {
    const res = await this.deps.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "model-index",
        KeyConditionExpression: "#model = :model",
        ExpressionAttributeNames: { "#model": "model" },
        ExpressionAttributeValues: { ":model": model },
        Select: "COUNT",
      }),
    );
    return res.Count ?? 0;
  }

  async search(queryVector: number[], model: string, topK: number): Promise<DesignVectorMatch[]> {
    const res = await this.deps.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "model-index",
        KeyConditionExpression: "#model = :model",
        ExpressionAttributeNames: { "#model": "model", "#source": "source" },
        ExpressionAttributeValues: { ":model": model },
        ProjectionExpression: "id, #source, vector",
      }),
    );
    const scored = (res.Items ?? []).map((it) => ({
      id: it.id as string,
      source: it.source as DesignSource,
      similarity: cosineSimilarity(queryVector, blobToVector(Buffer.from(it.vector as Uint8Array))),
    }));
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.deps.doc.send(
      new DeleteCommand({ TableName: this.table, Key: { id }, ReturnValues: "ALL_OLD" }),
    );
    return res.Attributes !== undefined;
  }
}
