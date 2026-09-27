// ============================================================
// $disconnect Handler — Client leaves the chat
//
// API Gateway invokes this when a client closes their
// WebSocket connection (or when it drops due to timeout/error).
//
// Our job: remove the connection ID from DynamoDB so we don't
// try to send messages to a client that's no longer there.
//
// Without this cleanup, the sendmessage function would try to
// push to dead connections and get errors.
//
// WebSocket connections can close for several reasons:
//   - Client explicitly closes (CTRL+C, browser tab closed)
//   - Idle timeout (API Gateway: 10 min idle, 2 hr max)
//   - Network failure (client loses internet)
// ============================================================

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(client);
const tableName = process.env.TABLE_NAME;

export const handler = async (event) => {
  await dynamo.send(
    new DeleteCommand({
      TableName: tableName,
      Key: { connectionId: event.requestContext.connectionId },
    })
  );

  return { statusCode: 200, body: "Disconnected." };
};
