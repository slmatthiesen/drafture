/**
 * vitest globalSetup for the DynamoDB integration tests: bring up a local emulator and
 * tear it down after the run.
 *
 * If DYNAMO_TEST_ENDPOINT is set, we assume the emulator is already running (CI / a
 * manually-started container) and only wait for readiness. Otherwise we start
 * `amazon/dynamodb-local` in Docker on port 8000 and remove it on teardown.
 */
import { execSync } from "node:child_process";

import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";

const CONTAINER = "drafture-ddb-test";
const PORT = 8000;
const ENDPOINT = process.env.DYNAMO_TEST_ENDPOINT ?? `http://127.0.0.1:${PORT}`;

async function waitForReady(): Promise<void> {
  const client = new DynamoDBClient({
    endpoint: ENDPOINT,
    region: "local",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await client.send(new ListTablesCommand({}));
      return;
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`DynamoDB Local not reachable at ${ENDPOINT} within 60s: ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

export async function setup(): Promise<() => void> {
  const managed = !process.env.DYNAMO_TEST_ENDPOINT;
  if (managed) {
    try {
      execSync(`docker rm -f ${CONTAINER}`, { stdio: "ignore" });
    } catch {
      // not running — fine
    }
    execSync(`docker run -d --rm --name ${CONTAINER} -p ${PORT}:8000 amazon/dynamodb-local`, {
      stdio: "ignore",
    });
  }
  await waitForReady();
  process.env.DYNAMO_TEST_ENDPOINT = ENDPOINT;

  return () => {
    if (managed) {
      try {
        execSync(`docker rm -f ${CONTAINER}`, { stdio: "ignore" });
      } catch {
        // already gone — fine
      }
    }
  };
}
