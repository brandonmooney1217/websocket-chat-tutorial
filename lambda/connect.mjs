// ============================================================
// $connect Handler — Client joins the chat
//
// API Gateway invokes this automatically when a client opens
// a WebSocket connection. This is the "upgrade handshake"
// from the article:
//
//   1. Client sends HTTP GET with "Upgrade: websocket" header
//   2. Server responds 101 Switching Protocols
//   3. TCP connection stays open, L7 switches to WebSocket
//
// API Gateway handles steps 1-3 for us. By the time this
// Lambda runs, the connection is already established.
// Our job: save the connection ID so we can find this client
// later when we need to push messages to them.
//
// This is what makes WebSocket STATEFUL vs HTTP STATELESS:
//   HTTP:      server doesn't track who's connected
//   WebSocket: server MUST track connections to push messages
// ============================================================

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(client);
const tableName = process.env.TABLE_NAME;

export const handler = async (event) => {
  // event.requestContext.connectionId is unique per client connection.
  // API Gateway assigns this when the WebSocket handshake completes.
  await dynamo.send(
    new PutCommand({
      TableName: tableName,
      Item: { connectionId: event.requestContext.connectionId },
    })
  );

  // Return 200 to tell API Gateway: "allow this connection."
  // If we returned 403, the connection would be rejected.
  return { statusCode: 200, body: "Connected." };
};
