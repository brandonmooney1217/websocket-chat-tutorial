// ============================================================
// $default Handler — Catch-all for unrecognized messages
//
// When a client sends a message that doesn't match any defined
// route (like "sendmessage"), API Gateway routes it here.
//
// Same concept as the HTTP API's "default" case that threw
// "Unsupported route" — but here we use the @connections API
// to push a helpful message back to the client.
// ============================================================

import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

export const handler = async (event) => {
  const callbackUrl = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
  const apiGateway = new ApiGatewayManagementApiClient({ endpoint: callbackUrl });

  // Push a help message back to the client who sent the bad request
  await apiGateway.send(
    new PostToConnectionCommand({
      ConnectionId: event.requestContext.connectionId,
      Data: `Use the sendmessage route to send a message. Example: {"action": "sendmessage", "message": "hello!"}`,
    })
  );

  return { statusCode: 200, body: "Default route." };
};
