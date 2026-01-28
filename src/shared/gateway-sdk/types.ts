/** WebSocket 事件名称 */
export const GatewayEvents = {
  // 系统事件
  PING: "ping",
  PONG: "pong",
  REGISTER: "register",
  REGISTERED: "registered",

  // 消息路由
  SEND: "send",
  RECEIVE: "receive",
  SEND_ERROR: "send_error",
} as const;

// ============ 设备相关 ============

/** 设备类型 */
export type DeviceType = "client" | "agent";

/** 设备信息 */
export interface DeviceInfo {
  deviceId: string;
  deviceType: DeviceType;
  metadata?: Record<string, unknown> | undefined;
}

/** 注册请求 */
export interface RegisterPayload {
  deviceId: string;
  deviceType: DeviceType;
  metadata?: Record<string, unknown>;
}

/** 注册响应 */
export interface RegisteredResponse {
  success: boolean;
  deviceId: string;
  error?: string;
}

// ============ 消息路由 ============

/** 路由消息 */
export interface RoutedMessage<T = unknown> {
  /** 消息唯一ID (UUID v7，包含时间戳) */
  id: string;
  /** 用户ID（登录后填充） */
  uid: string | null;
  /** 发送者 deviceId */
  from: string;
  /** 接收者 deviceId */
  to: string;
  /** 动作类型 */
  action: string;
  /** 消息内容 */
  payload: T;
}

/** 发送失败响应 */
export interface SendErrorResponse {
  messageId: string;
  error: string;
  code: "DEVICE_NOT_FOUND" | "NOT_REGISTERED" | "INVALID_MESSAGE";
}

// ============ Ping/Pong ============

/** Ping 请求 */
export interface PingPayload {
  [key: string]: unknown;
}

/** Ping 响应 */
export interface PongResponse {
  event: string;
  data: string;
}

// ============ 客户端配置 ============

/** 连接配置 */
export interface GatewayClientOptions {
  /** 服务器地址，如 http://localhost:3000 */
  url: string;
  /** WebSocket 路径，默认 /ws */
  path?: string | undefined;
  /** 设备ID */
  deviceId: string;
  /** 设备类型 */
  deviceType: DeviceType;
  /** 设备元数据 */
  metadata?: Record<string, unknown> | undefined;
  /** 自动重连，默认 true */
  autoReconnect?: boolean | undefined;
  /** 重连延迟（毫秒），默认 1000 */
  reconnectDelay?: number | undefined;
}

/** 连接状态 */
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "registered";

/** 事件回调类型 */
export interface GatewayClientCallbacks {
  onConnect?: (socketId: string) => void;
  onDisconnect?: (reason: string) => void;
  onRegistered?: (deviceId: string) => void;
  onMessage?: (message: RoutedMessage) => void;
  onSendError?: (error: SendErrorResponse) => void;
  onPong?: (data: string) => void;
  onError?: (error: Error) => void;
  onStateChange?: (state: ConnectionState) => void;
}

// ============ 兼容旧API（可删除） ============

/** @deprecated 使用 RoutedMessage */
export interface SendMessagePayload {
  text: string;
}

/** @deprecated 使用 RoutedMessage */
export interface BroadcastMessage {
  from: string;
  text: string;
  timestamp: string;
}
