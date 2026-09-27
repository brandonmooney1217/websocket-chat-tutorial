// ============================================================
// sendmessage Handler — The server push function
//
// This is the function that makes WebSocket different from HTTP.
// When a client sends a message, this function:
//   1. Scans DynamoDB for ALL connected client IDs
//   2. Calls @connections API to push the message to each one
//
// With HTTP, step 2 is impossible — the server can only respond
// to the client who made the request. Here, the server actively
// reaches out to clients who DIDN'T send anything.
// ============================================================

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

const ddbClient = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(ddbClient);
const tableName = process.env.TABLE_NAME;

export const handler = async (event) => {
  // ============================================================
  // Step 1: Build the @connections API client
  //
  // The endpoint is constructed from the request context:
  //   https://{apiId}.execute-api.{region}.amazonaws.com/{stage}
  //
  // This is the URL Lambda uses to tell API Gateway:
  //   "push this message to connection XYZ"
  // ============================================================
  const callbackUrl = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
  const apiGateway = new ApiGatewayManagementApiClient({ endpoint: callbackUrl });

  // ============================================================
  // Step 2: Get all connection IDs from DynamoDB
  // ============================================================
  const connections = await dynamo.send(
    new ScanCommand({ TableName: tableName })
  );

  // ============================================================
  // Step 3: Parse the message from the client's request
  //
  // The client sends JSON like: {"action": "sendmessage", "message": "hello!"}
  // API Gateway used "action" to route to this Lambda.
  // We extract the "message" field to broadcast.
  // ============================================================
  const message = JSON.parse(event.body).message;

  // ============================================================
  // Step 4: Push the message to EVERY connected client
  //
  // For each connection ID, we call postToConnection.
  // This is Lambda telling API Gateway:
  //   "You're holding a WebSocket connection to this client.
  //    Please send them this message."
  //
  // If a connection is stale (client left without clean disconnect),
  // we get a 410 Gone error — we clean up by removing that ID.
  // ============================================================
  const sendMessages = connections.Items.map(async ({ connectionId }) => {
    try {
      await apiGateway.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: message,
        })
      );
    } catch (err) {
      // 410 Gone = client disconnected without triggering $disconnect
      // (e.g. network failure, browser crash)
      // Clean up the stale connection ID from DynamoDB
      if (err.statusCode === 410) {
        await dynamo.send(
          new DeleteCommand({
            TableName: tableName,
            Key: { connectionId },
          })
        );
      } else {
        throw err;
      }
    }
  });

  // Send to all clients in parallel
  await Promise.all(sendMessages);

  return { statusCode: 200, body: "Message sent." };
};
