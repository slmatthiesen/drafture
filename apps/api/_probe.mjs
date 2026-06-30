import pkg from "dynamodb-local";
const DynamoDbLocal = pkg.default || pkg;
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
const PORT = 8123;
const log = (...a) => { process.stdout.write(a.join(" ") + "\n"); };
log("launching...");
await DynamoDbLocal.launch(PORT, null, ["-inMemory"], false, false);
try {
  const client = new DynamoDBClient({ endpoint: `http://127.0.0.1:${PORT}`, region: "local", credentials: { accessKeyId: "fake", secretAccessKey: "fake" } });
  await client.send(new CreateTableCommand({ TableName: "probe", AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }], BillingMode: "PAY_PER_REQUEST" }));
  const doc = DynamoDBDocumentClient.from(client);
  await doc.send(new PutCommand({ TableName: "probe", Item: { pk: "a", spent: 0, version: 0 } }));
  await doc.send(new UpdateCommand({ TableName: "probe", Key: { pk: "a" }, UpdateExpression: "SET spent = spent + :p, version = version + :one", ConditionExpression: "version = :v AND spent + :p <= :ceil", ExpressionAttributeValues: { ":p": 0.3, ":one": 1, ":v": 0, ":ceil": 1.0 } }));
  const got = await doc.send(new GetCommand({ TableName: "probe", Key: { pk: "a" } }));
  log("ITEM:", JSON.stringify(got.Item));
  let blocked = false;
  try { await doc.send(new UpdateCommand({ TableName: "probe", Key: { pk: "a" }, UpdateExpression: "SET spent = spent + :p", ConditionExpression: "spent + :p <= :ceil", ExpressionAttributeValues: { ":p": 0.9, ":ceil": 1.0 } })); }
  catch (e) { blocked = e.name === "ConditionalCheckFailedException"; }
  log("OVERSHOOT BLOCKED:", blocked);
  log("PROBE OK");
} finally { await DynamoDbLocal.stop(PORT); log("stopped"); }
process.exit(0);
