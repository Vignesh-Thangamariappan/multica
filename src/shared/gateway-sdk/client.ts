import { io, Socket } from "socket.io-client";
import { v7 as uuidv7 } from "uuid";
import type {
  GatewayClientOptions,
  GatewayClientCallbacks,
  ConnectionState,
  RoutedMessage,
  RegisteredResponse,
  SendErrorResponse,
  PingPayload,
  DeviceType,
} from "./types.js";
import { GatewayEvents } from "./types.js";

interface ResolvedOptions {
  url: string;
  path: string;
  deviceId: string;
  deviceType: DeviceType;
  metadata: Record<string, unknown> | undefined;
  autoReconnect: boolean;
  reconnectDelay: number;
}

export class GatewayClient {
  private socket: Socket | null = null;
  private options: ResolvedOptions;
  private callbacks: GatewayClientCallbacks = {};
  private _state: ConnectionState = "disconnected";

  constructor(options: GatewayClientOptions) {
    if (!options.deviceId) {
      throw new Error("deviceId is required");
    }

    this.options = {
      url: options.url,
      path: options.path ?? "/ws",
      deviceId: options.deviceId,
      deviceType: options.deviceType,
      metadata: options.metadata,
      autoReconnect: options.autoReconnect ?? true,
      reconnectDelay: options.reconnectDelay ?? 1000,
    };
  }

  /** 当前连接状态 */
  get state(): ConnectionState {
    return this._state;
  }

  /** 设备ID */
  get deviceId(): string {
    return this.options.deviceId;
  }

  /** 设备类型 */
  get deviceType(): DeviceType {
    return this.options.deviceType;
  }

  /** Socket ID（连接后可用） */
  get socketId(): string | undefined {
    return this.socket?.id;
  }

  /** 是否已连接 */
  get isConnected(): boolean {
    return this._state === "connected" || this._state === "registered";
  }

  /** 是否已注册 */
  get isRegistered(): boolean {
    return this._state === "registered";
  }

  /** 连接到服务器 */
  connect(): this {
    if (this.socket) {
      return this;
    }

    this.setState("connecting");

    this.socket = io(this.options.url, {
      path: this.options.path,
      reconnection: this.options.autoReconnect,
      reconnectionDelay: this.options.reconnectDelay,
    });

    this.setupListeners();
    return this;
  }

  /** 断开连接 */
  disconnect(): this {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.setState("disconnected");
    return this;
  }

  /** 发送消息给指定设备 */
  send<T = unknown>(
    to: string,
    action: string,
    payload: T,
    messageId?: string
  ): string {
    if (!this.socket || !this.isRegistered) {
      throw new Error("Not registered");
    }

    const id = messageId ?? this.generateMessageId();
    const message: RoutedMessage<T> = {
      id,
      uid: null,
      from: this.options.deviceId,
      to,
      action,
      payload,
    };

    this.socket.emit(GatewayEvents.SEND, message);
    return id;
  }

  /** 发送 ping */
  ping(data: PingPayload = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.isConnected) {
        reject(new Error("Not connected"));
        return;
      }

      this.socket.emit(
        GatewayEvents.PING,
        data,
        (response: { event: string; data: string }) => {
          resolve(response.data);
        }
      );
    });
  }

  /** 注册连接回调 */
  onConnect(callback: (socketId: string) => void): this {
    this.callbacks.onConnect = callback;
    return this;
  }

  /** 注册断开回调 */
  onDisconnect(callback: (reason: string) => void): this {
    this.callbacks.onDisconnect = callback;
    return this;
  }

  /** 注册成功回调 */
  onRegistered(callback: (deviceId: string) => void): this {
    this.callbacks.onRegistered = callback;
    return this;
  }

  /** 注册消息回调 */
  onMessage(callback: (message: RoutedMessage) => void): this {
    this.callbacks.onMessage = callback;
    return this;
  }

  /** 注册发送失败回调 */
  onSendError(callback: (error: SendErrorResponse) => void): this {
    this.callbacks.onSendError = callback;
    return this;
  }

  /** 注册 pong 回调 */
  onPong(callback: (data: string) => void): this {
    this.callbacks.onPong = callback;
    return this;
  }

  /** 注册错误回调 */
  onError(callback: (error: Error) => void): this {
    this.callbacks.onError = callback;
    return this;
  }

  /** 注册状态变化回调 */
  onStateChange(callback: (state: ConnectionState) => void): this {
    this.callbacks.onStateChange = callback;
    return this;
  }

  private setState(state: ConnectionState): void {
    if (this._state !== state) {
      this._state = state;
      this.callbacks.onStateChange?.(state);
    }
  }

  private generateMessageId(): string {
    return uuidv7();
  }

  private register(): void {
    if (!this.socket) return;

    this.socket.emit(GatewayEvents.REGISTER, {
      deviceId: this.options.deviceId,
      deviceType: this.options.deviceType,
      metadata: this.options.metadata,
    });
  }

  private setupListeners(): void {
    if (!this.socket) return;

    this.socket.on("connect", () => {
      this.setState("connected");
      this.callbacks.onConnect?.(this.socket!.id!);
      // 连接后自动注册
      this.register();
    });

    this.socket.on("disconnect", (reason: string) => {
      this.setState("disconnected");
      this.callbacks.onDisconnect?.(reason);
    });

    this.socket.on(
      GatewayEvents.REGISTERED,
      (response: RegisteredResponse) => {
        if (response.success) {
          this.setState("registered");
          this.callbacks.onRegistered?.(response.deviceId);
        } else {
          this.callbacks.onError?.(new Error(response.error ?? "Registration failed"));
        }
      }
    );

    this.socket.on(GatewayEvents.RECEIVE, (message: RoutedMessage) => {
      this.callbacks.onMessage?.(message);
    });

    this.socket.on(GatewayEvents.SEND_ERROR, (error: SendErrorResponse) => {
      this.callbacks.onSendError?.(error);
    });

    this.socket.on(GatewayEvents.PONG, (data: string) => {
      this.callbacks.onPong?.(data);
    });

    this.socket.on("connect_error", (error: Error) => {
      this.callbacks.onError?.(error);
    });
  }
}
