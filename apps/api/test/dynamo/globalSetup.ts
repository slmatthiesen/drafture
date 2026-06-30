/**
 * vitest globalSetup for the DynamoDB integration tests: bring up DynamoDB Local and
 * tear it down after the run.
 *
 * Uses Amazon's DynamoDB Local JAR via the `dynamodb-local` package (needs a JDK on
 * PATH — Java 21 here), launched in-memory. This is Docker-free, which matters because
 * the local Docker engine is unreliable on this box. Set DYNAMO_TEST_ENDPOINT to point
 * at an already-running emulator (CI / a manually-started instance) and the launch is
 * skipped.
 */
import DynamoDbLocal from "dynamodb-local";

import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";

const PORT = 8000;
const ENDPOINT = process.env.DYNAMO_TEST_ENDPOINT ?? `http://127.0.0.1:${PORT}`;

function client(): DynamoDBClient {
  return new DynamoDBClient({
    endpoint: ENDPOINT,
    region: "local",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
}

async function isReachable(): Promise<boolean> {
  try {
    await client().send(new ListTablesCommand({}));
    return true;
  } catch {
    return false;
  }
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (await isReachable()) return;
    if (Date.now() > deadline) throw new Error(`DynamoDB Local not reachable at ${ENDPOINT} within 60s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function setup(): Promise<() => Promise<void>> {
  // Reuse an already-running emulator (a leftover from a prior run, or one started by
  // CI) rather than double-launching — a second launch on the same port fails to bind.
  // We only own (and stop) the jar when WE start it.
  const external = !!process.env.DYNAMO_TEST_ENDPOINT;
  const reachable = await isReachable();
  const managed = !external && !reachable;
  if (managed) {
    // -sharedDb: one DB across all clients regardless of region/creds (deterministic tests).
    await DynamoDbLocal.launch(PORT, null, ["-inMemory", "-sharedDb"], false, false);
  }
  await waitForReady();
  process.env.DYNAMO_TEST_ENDPOINT = ENDPOINT;

  return async () => {
    if (managed) {
      try {
        await DynamoDbLocal.stop(PORT);
      } catch {
        // already gone — fine
      }
    }
  };
}
