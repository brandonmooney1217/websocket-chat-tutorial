import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';

export class WebsocketChatTutorialStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ============================================================
    // STEP 1: DynamoDB Table — Connection tracking
    //
    // HTTP is STATELESS — each request is independent, the server
    // doesn't know or care who's connected. That's why our CRUD
    // API didn't need a connections table.
    //
    // WebSockets are STATEFUL — the server maintains a persistent
    // connection with each client. To send messages to clients,
    // the server needs to know WHO is currently connected.
    //
    // This table stores one row per connected client:
    //   { connectionId: "abc123" }
    //
    // When a client connects → add their ID
    // When a client disconnects → remove their ID
    // When someone sends a message → scan ALL IDs, push to each
    // ============================================================
    const connectionsTable = new dynamodb.Table(this, 'ConnectionsTable', {
      tableName: 'websocket-chat-connections',
      partitionKey: {
        name: 'connectionId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ============================================================
    // STEP 2-5: Lambda Functions — One per WebSocket event
    //
    // Unlike the HTTP API where ONE Lambda handled all routes via
    // a switch statement, here we use SEPARATE Lambdas:
    //   $connect    → connect.mjs
    //   $disconnect → disconnect.mjs
    //   sendmessage → sendmessage.mjs
    //   $default    → default.mjs
    //
    // This is actually the AWS best practice — one function per
    // route. The HTTP tutorial used one function for simplicity.
    // ============================================================
    const connectFn = new lambda.Function(this, 'ConnectFunction', {
      functionName: 'ws-chat-connect',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'connect.handler',
      code: lambda.Code.fromAsset('lambda'),
      environment: { TABLE_NAME: connectionsTable.tableName },
    });

    const disconnectFn = new lambda.Function(this, 'DisconnectFunction', {
      functionName: 'ws-chat-disconnect',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'disconnect.handler',
      code: lambda.Code.fromAsset('lambda'),
      environment: { TABLE_NAME: connectionsTable.tableName },
    });

    const sendmessageFn = new lambda.Function(this, 'SendMessageFunction', {
      functionName: 'ws-chat-sendmessage',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'sendmessage.handler',
      code: lambda.Code.fromAsset('lambda'),
      environment: { TABLE_NAME: connectionsTable.tableName },
    });

    const defaultFn = new lambda.Function(this, 'DefaultFunction', {
      functionName: 'ws-chat-default',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'default.handler',
      code: lambda.Code.fromAsset('lambda'),
    });

    // Grant DynamoDB access to the functions that need it
    connectionsTable.grantReadWriteData(connectFn);
    connectionsTable.grantReadWriteData(disconnectFn);
    connectionsTable.grantReadWriteData(sendmessageFn);
    // defaultFn doesn't need DynamoDB — it only pushes to one client

    // ============================================================
    // STEP 6: WebSocket API Gateway
    //
    // Compare to the HTTP API from the CRUD project:
    //
    //   HTTP API:
    //     - Routes by HTTP method + path (GET /items/{id})
    //     - Stateless — each request is independent
    //     - Client always initiates
    //
    //   WebSocket API:
    //     - Routes by "action" field in the message body
    //     - Stateful — persistent connection per client
    //     - Either side can send at any time
    //
    // The "route selection expression" tells API Gateway HOW
    // to pick a route. We set it to "$request.body.action":
    //   Client sends: {"action": "sendmessage", "message": "hi"}
    //   API Gateway reads action = "sendmessage" → routes there
    //
    // Compare to HTTP where routing is built into the protocol:
    //   GET /items → method and path are part of HTTP itself
    //
    // WebSocket has no built-in routing — it's just a raw pipe.
    // So API Gateway lets you define your own routing scheme
    // using a field in the JSON message body.
    // ============================================================
    const webSocketApi = new apigwv2.WebSocketApi(this, 'WebSocketApi', {
      apiName: 'websocket-chat-app',
      routeSelectionExpression: '$request.body.action',
      connectRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration(
          'ConnectIntegration', connectFn,
        ),
      },
      disconnectRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration(
          'DisconnectIntegration', disconnectFn,
        ),
      },
      defaultRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration(
          'DefaultIntegration', defaultFn,
        ),
      },
    });

    // Custom route: "sendmessage"
    // When a client sends {"action": "sendmessage", ...},
    // API Gateway matches "sendmessage" and routes here.
    webSocketApi.addRoute('sendmessage', {
      integration: new integrations.WebSocketLambdaIntegration(
        'SendMessageIntegration', sendmessageFn,
      ),
    });

    // Deploy the API to a stage called "production"
    const stage = new apigwv2.WebSocketStage(this, 'ProductionStage', {
      webSocketApi,
      stageName: 'production',
      autoDeploy: true,
    });

    // ============================================================
    // Grant sendmessage and default Lambdas permission to call
    // the @connections API (to push messages to clients).
    //
    // This is an IAM permission — without it, Lambda would get
    // "AccessDenied" when trying to call PostToConnectionCommand.
    //
    // The @connections API endpoint is:
    //   POST https://{apiId}.execute-api.{region}.amazonaws.com/{stage}/@connections/{connectionId}
    // ============================================================
    const connectionsArn = cdk.Stack.of(this).formatArn({
      service: 'execute-api',
      resource: webSocketApi.apiId,
      resourceName: `${stage.stageName}/POST/@connections/*`,
    });

    sendmessageFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [connectionsArn],
      })
    );

    defaultFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [connectionsArn],
      })
    );

    // ============================================================
    // API Gateway Access Logging
    //
    // Lambda logs show what YOUR code did.
    // API Gateway logs show what the GATEWAY did:
    //   - Which connection ID connected/disconnected
    //   - Which route was selected for each message
    //   - Status codes, errors, latency
    //
    // This is like the difference between application logs and
    // load balancer access logs — both useful for debugging.
    // ============================================================
    const accessLogGroup = new logs.LogGroup(this, 'WebSocketAccessLogs', {
      logGroupName: '/aws/apigateway/websocket-chat-access-logs',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Add access logging to the stage
    const cfnStage = stage.node.defaultChild as apigwv2.CfnStage;
    cfnStage.accessLogSettings = {
      destinationArn: accessLogGroup.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        connectionId: '$context.connectionId',
        eventType: '$context.eventType',        // CONNECT, MESSAGE, DISCONNECT
        routeKey: '$context.routeKey',           // $connect, sendmessage, etc.
        status: '$context.status',               // HTTP status code
        integrationError: '$context.integrationErrorMessage',
        requestTime: '$context.requestTime',
      }),
    };

    // Grant API Gateway permission to write to CloudWatch Logs
    // API Gateway requires the AmazonAPIGatewayPushToCloudWatchLogs
    // managed policy — a custom grant isn't enough.
    const apiGwLogsRole = new iam.Role(this, 'ApiGwLogsRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonAPIGatewayPushToCloudWatchLogs',
        ),
      ],
    });

    // Set the account-level CloudWatch role for API Gateway
    // (API Gateway needs this to write logs at all)
    new cdk.CfnResource(this, 'ApiGwAccount', {
      type: 'AWS::ApiGateway::Account',
      properties: {
        CloudWatchRoleArn: apiGwLogsRole.roleArn,
      },
    });

    // Output the WebSocket URL
    new cdk.CfnOutput(this, 'WebSocketUrl', {
      value: stage.url,
      description: 'WebSocket URL — connect with: wscat -c <this-url>',
    });
  }
}
