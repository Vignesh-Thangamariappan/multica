# Gateway SDK Usage Guide

This document describes how to use the Gateway SDK for both Client and Agent implementations.

## Installation

The SDK is located at `src/shared/gateway-sdk`. Import from the index file:

```typescript
import {
  GatewayClient,
  type RoutedMessage,
  type ConnectionState,
  // Actions
  HelloAction,
  RequestAction,
  ResponseAction,
  StreamAction,
  // Types
  type HelloPayload,
  type RequestPayload,
  type ResponsePayload,
  type StreamPayload,
} from "../shared/gateway-sdk/index.js";
```

## Core Concepts

### Device Types

- `client`: End-user applications (web, mobile, desktop)
- `agent`: Backend processing units that handle requests from clients

### Connection States

```typescript
type ConnectionState = "disconnected" | "connecting" | "connected" | "registered";
```

- `disconnected`: Not connected to gateway
- `connecting`: Connection in progress
- `connected`: WebSocket connected, not yet registered
- `registered`: Fully operational, can send/receive messages

### Message Structure

All messages follow the `RoutedMessage` interface:

```typescript
interface RoutedMessage<T = unknown> {
  id: string;        // Unique message ID (UUID v7, contains timestamp)
  uid: string | null; // User ID (null if not authenticated)
  from: string;      // Sender's deviceId
  to: string;        // Recipient's deviceId
  action: string;    // Action type (e.g., "hello", "request", "stream")
  payload: T;        // Message payload
}
```

> Note: The `id` field uses UUID v7 which embeds a millisecond timestamp. To extract it:
> ```typescript
> function getTimestampFromId(id: string): Date {
>   const hex = id.replace(/-/g, '').slice(0, 12);
>   return new Date(parseInt(hex, 16));
> }
> ```

## Client Implementation

### Basic Setup

```typescript
import { GatewayClient } from "../shared/gateway-sdk/index.js";

const client = new GatewayClient({
  url: "http://localhost:3000",  // Gateway server URL
  deviceId: "client-001",        // Unique device identifier
  deviceType: "client",          // Device type
  metadata: { name: "My App" },  // Optional metadata
  autoReconnect: true,           // Auto reconnect on disconnect (default: true)
  reconnectDelay: 1000,          // Reconnect delay in ms (default: 1000)
});
```

### Connecting and Event Handling

```typescript
client
  .onStateChange((state) => {
    console.log("Connection state:", state);
  })
  .onConnect((socketId) => {
    console.log("Connected with socket ID:", socketId);
  })
  .onRegistered((deviceId) => {
    console.log("Registered as:", deviceId);
    // Now safe to send messages
  })
  .onMessage((message) => {
    console.log("Received:", message);
    // Handle incoming messages from agents
  })
  .onSendError((error) => {
    console.error("Send failed:", error);
    // error.code: "DEVICE_NOT_FOUND" | "NOT_REGISTERED" | "INVALID_MESSAGE"
  })
  .onDisconnect((reason) => {
    console.log("Disconnected:", reason);
  })
  .onError((error) => {
    console.error("Connection error:", error);
  })
  .connect();
```

### Sending Messages to an Agent

```typescript
import { HelloAction, type HelloPayload } from "../shared/gateway-sdk/index.js";

// Send a hello message to agent-001
client.send<HelloPayload>("agent-001", HelloAction, {
  greeting: "Hello from client!",
});

// With custom message ID
const messageId = client.send<HelloPayload>(
  "agent-001",
  HelloAction,
  { greeting: "Hello!" },
  "custom-message-id-123"
);
```

### RPC Pattern (Request/Response)

```typescript
import {
  RequestAction,
  ResponseAction,
  type RequestPayload,
  type ResponsePayload,
  isResponseSuccess,
  isResponseError,
} from "../shared/gateway-sdk/index.js";

// Track pending requests
const pendingRequests = new Map<string, (response: ResponsePayload) => void>();

// Send RPC request
function callAgent<T>(agentId: string, method: string, params?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const messageId = client.send<RequestPayload>(agentId, RequestAction, {
      method,
      params,
    });

    pendingRequests.set(messageId, (response) => {
      if (isResponseSuccess<T>(response)) {
        resolve(response.payload);
      } else {
        reject(new Error(response.error.message));
      }
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingRequests.has(messageId)) {
        pendingRequests.delete(messageId);
        reject(new Error("Request timeout"));
      }
    }, 30000);
  });
}

// Handle responses
client.onMessage((message) => {
  if (message.action === ResponseAction) {
    const payload = message.payload as ResponsePayload;
    const callback = pendingRequests.get(payload.requestId);
    if (callback) {
      pendingRequests.delete(payload.requestId);
      callback(payload);
    }
  }
});

// Usage
const result = await callAgent<{ data: string }>("agent-001", "getData", { id: 123 });
```

### Receiving Streams

```typescript
import { StreamAction, type StreamPayload } from "../shared/gateway-sdk/index.js";

// Track active streams
const activeStreams = new Map<string, (data: unknown) => void>();

client.onMessage((message) => {
  if (message.action === StreamAction) {
    const payload = message.payload as StreamPayload;
    const handler = activeStreams.get(payload.streamId);
    if (handler) {
      handler(payload.data);
    }
  }
});

// Subscribe to a stream
function subscribeToStream(streamId: string, onData: (data: unknown) => void) {
  activeStreams.set(streamId, onData);
  return () => activeStreams.delete(streamId); // Unsubscribe function
}
```

### Disconnecting

```typescript
client.disconnect();
```

### Checking Connection Status

```typescript
client.isConnected;   // true if connected or registered
client.isRegistered;  // true if registered (can send messages)
client.state;         // Current ConnectionState
client.deviceId;      // Device ID
client.socketId;      // Socket ID (available after connect)
```

## Agent Implementation

### Basic Setup

```typescript
import { GatewayClient } from "../shared/gateway-sdk/index.js";

const agent = new GatewayClient({
  url: "http://localhost:3000",
  deviceId: "agent-001",
  deviceType: "agent",
  metadata: {
    name: "Processing Agent",
    capabilities: ["chat", "image-generation"],
  },
});
```

### Handling Requests

```typescript
import {
  HelloAction,
  HelloResponseAction,
  RequestAction,
  ResponseAction,
  type HelloPayload,
  type HelloResponsePayload,
  type RequestPayload,
  type ResponseSuccessPayload,
  type ResponseErrorPayload,
} from "../shared/gateway-sdk/index.js";

agent
  .onRegistered((deviceId) => {
    console.log("Agent registered:", deviceId);
  })
  .onMessage(async (message) => {
    // Handle hello action
    if (message.action === HelloAction) {
      const payload = message.payload as HelloPayload;
      agent.send<HelloResponsePayload>(message.from, HelloResponseAction, {
        reply: `Hello! You said: "${payload.greeting}"`,
      });
      return;
    }

    // Handle RPC requests
    if (message.action === RequestAction) {
      const request = message.payload as RequestPayload;

      try {
        const result = await processRequest(request.method, request.params);
        agent.send<ResponseSuccessPayload>(message.from, ResponseAction, {
          requestId: message.id,
          ok: true,
          payload: result,
        });
      } catch (error) {
        agent.send<ResponseErrorPayload>(message.from, ResponseAction, {
          requestId: message.id,
          ok: false,
          error: {
            code: "PROCESSING_ERROR",
            message: error instanceof Error ? error.message : "Unknown error",
            retryable: false,
          },
        });
      }
    }
  })
  .connect();

async function processRequest(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case "getData":
      return { data: "some data" };
    case "processImage":
      // Process image...
      return { url: "https://..." };
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}
```

### Sending Streams

```typescript
import { StreamAction, type StreamPayload } from "../shared/gateway-sdk/index.js";
import { v7 as uuidv7 } from "uuid";

async function sendStream(clientId: string, generateChunks: AsyncIterable<string>) {
  const streamId = uuidv7();

  for await (const chunk of generateChunks) {
    agent.send<StreamPayload<string>>(clientId, StreamAction, {
      streamId,
      data: chunk,
    });
  }

  // Send end-of-stream marker
  agent.send<StreamPayload<null>>(clientId, StreamAction, {
    streamId,
    data: null,
  });
}

// Usage with an async generator
async function* generateResponse(): AsyncIterable<string> {
  yield "Hello";
  yield " ";
  yield "World";
  yield "!";
}

sendStream("client-001", generateResponse());
```

### Multiple Agent Instances

For scaling, run multiple agent instances with unique IDs:

```typescript
const agentId = `agent-${process.env.INSTANCE_ID || uuidv7()}`;

const agent = new GatewayClient({
  url: process.env.GATEWAY_URL || "http://localhost:3000",
  deviceId: agentId,
  deviceType: "agent",
  metadata: {
    instanceId: process.env.INSTANCE_ID,
    region: process.env.REGION,
  },
});
```

## Predefined Actions

### Hello Action

Simple greeting for testing connectivity.

```typescript
// Client sends
client.send<HelloPayload>("agent-001", HelloAction, {
  greeting: "Hello!",
});

// Agent responds
agent.send<HelloResponsePayload>(message.from, HelloResponseAction, {
  reply: "Hi there!",
});
```

### Request/Response Action (RPC)

For request-response patterns.

```typescript
// Request
interface RequestPayload<T = unknown> {
  method: string;
  params?: T;
}

// Success Response
interface ResponseSuccessPayload<T = unknown> {
  requestId: string;
  ok: true;
  payload: T;
}

// Error Response
interface ResponseErrorPayload {
  requestId: string;
  ok: false;
  error: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}
```

### Stream Action

For streaming data (e.g., LLM token streaming).

```typescript
interface StreamPayload<T = unknown> {
  streamId: string;  // Correlates all messages in a stream
  data: T;           // Chunk data, null indicates end-of-stream
}
```

## Error Handling

### Send Errors

```typescript
client.onSendError((error) => {
  switch (error.code) {
    case "DEVICE_NOT_FOUND":
      console.error(`Device ${error.messageId} not found`);
      break;
    case "NOT_REGISTERED":
      console.error("You are not registered");
      break;
    case "INVALID_MESSAGE":
      console.error("Invalid message format");
      break;
  }
});
```

### Connection Errors

```typescript
client.onError((error) => {
  console.error("Connection error:", error.message);
  // SDK will auto-reconnect if autoReconnect is true
});
```

## Type Safety

Use generics for type-safe payloads:

```typescript
// Define your payload types
interface MyRequestPayload {
  query: string;
  limit: number;
}

interface MyResponsePayload {
  results: string[];
  total: number;
}

// Send with type safety
client.send<MyRequestPayload>("agent-001", "search", {
  query: "hello",
  limit: 10,
});

// Receive with type assertion
agent.onMessage((message) => {
  if (message.action === "search") {
    const payload = message.payload as MyRequestPayload;
    // payload.query and payload.limit are typed
  }
});
```

## Complete Example: Chat Application

### Client Side

```typescript
import {
  GatewayClient,
  RequestAction,
  ResponseAction,
  StreamAction,
  type RequestPayload,
  type ResponsePayload,
  type StreamPayload,
  isResponseSuccess,
} from "../shared/gateway-sdk/index.js";

const client = new GatewayClient({
  url: "http://localhost:3000",
  deviceId: `user-${Date.now()}`,
  deviceType: "client",
});

// Collect stream chunks
const streamBuffers = new Map<string, string[]>();

client
  .onMessage((message) => {
    if (message.action === StreamAction) {
      const { streamId, data } = message.payload as StreamPayload<string | null>;

      if (data === null) {
        // Stream ended
        const chunks = streamBuffers.get(streamId) || [];
        console.log("Complete response:", chunks.join(""));
        streamBuffers.delete(streamId);
      } else {
        // Accumulate chunk
        const chunks = streamBuffers.get(streamId) || [];
        chunks.push(data);
        streamBuffers.set(streamId, chunks);
        process.stdout.write(data); // Print chunk immediately
      }
    }
  })
  .onRegistered(() => {
    // Send a chat message
    client.send<RequestPayload>("chat-agent", RequestAction, {
      method: "chat",
      params: { message: "Tell me a joke" },
    });
  })
  .connect();
```

### Agent Side

```typescript
import {
  GatewayClient,
  RequestAction,
  StreamAction,
  type RequestPayload,
  type StreamPayload,
} from "../shared/gateway-sdk/index.js";
import { v7 as uuidv7 } from "uuid";

const agent = new GatewayClient({
  url: "http://localhost:3000",
  deviceId: "chat-agent",
  deviceType: "agent",
});

agent
  .onMessage(async (message) => {
    if (message.action === RequestAction) {
      const { method, params } = message.payload as RequestPayload<{ message: string }>;

      if (method === "chat") {
        const streamId = uuidv7();

        // Simulate streaming response
        const response = "Why did the programmer quit? Because he didn't get arrays!";

        for (const char of response) {
          agent.send<StreamPayload<string>>(message.from, StreamAction, {
            streamId,
            data: char,
          });
          await sleep(50); // Simulate delay
        }

        // End stream
        agent.send<StreamPayload<null>>(message.from, StreamAction, {
          streamId,
          data: null,
        });
      }
    }
  })
  .connect();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```
