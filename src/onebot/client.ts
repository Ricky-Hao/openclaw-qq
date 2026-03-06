// OneBot v11 WebSocket client with auto-reconnect, heartbeat, and wait-for-reconnect

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type {
  MessageSegment,
  MessageTarget,
  OneBotApiResponse,
  OneBotEvent,
  OneBotMessageEvent,
} from "./types.js";

export type OneBotClientConfig = {
  wsUrl: string;
  token: string;
};

type PendingCall = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface OneBotClient {
  on(event: "message", handler: (evt: OneBotMessageEvent) => void): this;
  on(event: "connected", handler: () => void): this;
  on(event: "disconnected", handler: (reason: string) => void): this;
  on(event: "error", handler: (err: Error) => void): this;
  emit(event: "message", evt: OneBotMessageEvent): boolean;
  emit(event: "connected"): boolean;
  emit(event: "disconnected", reason: string): boolean;
  emit(event: "error", err: Error): boolean;
}

export class OneBotClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: OneBotClientConfig;
  private pendingCalls = new Map<string, PendingCall>();
  private echoCounter = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEventAt = 0;
  private _connected = false;
  private _destroyed = false;

  // Reconnect config
  static readonly INITIAL_DELAY_MS = 1000;
  static readonly MAX_DELAY_MS = 30_000;
  static readonly BACKOFF_FACTOR = 2;
  static readonly HEARTBEAT_INTERVAL_MS = 20_000;
  static readonly PONG_TIMEOUT_MS = 10_000;
  static readonly API_TIMEOUT_MS = 15_000;
  static readonly RECONNECT_WAIT_MS = 10_000;

  constructor(config: OneBotClientConfig) {
    super();
    this.config = config;
  }

  get connected(): boolean {
    return this._connected;
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  async connect(): Promise<void> {
    if (this._destroyed) return;

    // Clean up any old ws instance before creating a new one
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.terminate(); } catch { /* ignore */ }
      this.ws = null;
    }

    return new Promise<void>((resolve, reject) => {
      try {
        const headers: Record<string, string> = {};
        if (this.config.token) {
          headers["Authorization"] = `Bearer ${this.config.token}`;
        }
        this.ws = new WebSocket(this.config.wsUrl, { headers });

        const onOpen = () => {
          cleanup();
          this._connected = true;
          this.reconnectAttempts = 0;
          this.lastEventAt = Date.now();
          this.startHeartbeatMonitor();
          this.emit("connected");
          resolve();
        };

        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };

        const onClose = () => {
          cleanup();
          reject(new Error("WebSocket closed before open"));
        };

        const cleanup = () => {
          this.ws?.removeListener("open", onOpen);
          this.ws?.removeListener("error", onError);
          this.ws?.removeListener("close", onClose);
        };

        this.ws.once("open", onOpen);
        this.ws.once("error", onError);
        this.ws.once("close", onClose);

        // Set up persistent handlers after connection
        this.ws.on("message", (data) => this.handleRawMessage(data));
        this.ws.on("pong", () => {
          this.lastEventAt = Date.now();
          this.clearPongTimer();
        });
        this.ws.on("close", (code, reason) => {
          this._connected = false;
          this.stopHeartbeatMonitor();
          this.clearPongTimer();
          // Do NOT reject pending API calls — they will wait for reconnect
          // and timeout via their own timers if reconnect takes too long
          const reasonStr = reason?.toString() || `code=${code}`;
          this.emit("disconnected", reasonStr);
          this.scheduleReconnect();
        });
        this.ws.on("error", (err) => {
          this.emit("error", err);
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  disconnect(): void {
    this._destroyed = true;
    this.clearReconnectTimer();
    this.stopHeartbeatMonitor();
    this.clearPongTimer();
    this.rejectAllPending("Client disconnected");
    if (this.ws) {
      this.ws.removeAllListeners();
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close(1000, "Client shutdown");
      }
      this.ws = null;
    }
    this._connected = false;
  }

  /**
   * Wait for the WebSocket to become connected, up to timeoutMs.
   * Resolves immediately if already connected.
   * Rejects if destroyed or timeout elapses.
   */
  waitForConnection(timeoutMs: number = OneBotClient.RECONNECT_WAIT_MS): Promise<void> {
    if (this._connected) return Promise.resolve();
    if (this._destroyed) return Promise.reject(new Error("Client destroyed"));

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let destroyChecker: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (destroyChecker) clearInterval(destroyChecker);
        this.removeListener("connected", onConnected);
      };

      const onConnected = () => {
        cleanup();
        resolve();
      };

      timer = setTimeout(() => {
        cleanup();
        reject(new Error("WebSocket not connected (reconnect timeout)"));
      }, timeoutMs);

      // Check for destroy periodically to avoid hanging forever
      destroyChecker = setInterval(() => {
        if (this._destroyed) {
          cleanup();
          reject(new Error("Client destroyed"));
        }
      }, 200);

      this.once("connected", onConnected);
    });
  }

  /**
   * Call a OneBot API action and wait for the response.
   * If disconnected, waits up to RECONNECT_WAIT_MS for reconnection before failing.
   */
  async callApi(
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    // If not connected, wait for reconnection instead of failing immediately
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this._destroyed) {
        throw new Error("WebSocket not connected");
      }
      await this.waitForConnection();
    }

    const echo = `oc_${++this.echoCounter}`;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(echo);
        reject(new Error(`API call ${action} timed out after ${OneBotClient.API_TIMEOUT_MS}ms`));
      }, OneBotClient.API_TIMEOUT_MS);

      this.pendingCalls.set(echo, { resolve, reject, timer });

      // Re-check ws is still open (could have disconnected between await and here)
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        // Don't send — leave pending call in the map; it will either:
        // - be resolved when we reconnect and the server replays (unlikely for OneBot)
        // - time out via the timer above
        // For safety, reject immediately since the echo won't be answered
        clearTimeout(timer);
        this.pendingCalls.delete(echo);
        reject(new Error("WebSocket disconnected during send"));
        return;
      }

      this.ws.send(
        JSON.stringify({ action, params, echo }),
        (err) => {
          if (err) {
            clearTimeout(timer);
            this.pendingCalls.delete(echo);
            reject(err);
          }
        },
      );
    });
  }

  /**
   * Send a message to the specified target.
   * Returns the message_id on success.
   */
  async sendMessage(
    target: MessageTarget,
    message: MessageSegment[],
  ): Promise<number> {
    const params: Record<string, unknown> = { message };

    if (target.type === "private") {
      params.message_type = "private";
      params.user_id = target.userId;
    } else {
      params.message_type = "group";
      params.group_id = target.groupId;
    }

    const result = (await this.callApi("send_msg", params)) as {
      message_id?: number;
    };
    return result?.message_id ?? 0;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private handleRawMessage(data: WebSocket.RawData): void {
    this.lastEventAt = Date.now();

    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }

    const obj = parsed as Record<string, unknown>;

    // Handle API response (has echo field)
    if (typeof obj.echo === "string" && this.pendingCalls.has(obj.echo)) {
      const pending = this.pendingCalls.get(obj.echo)!;
      this.pendingCalls.delete(obj.echo);
      clearTimeout(pending.timer);

      const resp = obj as unknown as OneBotApiResponse;
      if (resp.retcode === 0) {
        pending.resolve(resp.data);
      } else {
        pending.reject(
          new Error(
            `OneBot API error: ${resp.message || resp.wording || "unknown"} (retcode=${resp.retcode})`,
          ),
        );
      }
      return;
    }

    // Handle events
    const event = obj as OneBotEvent;
    if (event.post_type === "message") {
      this.emit("message", event as OneBotMessageEvent);
    }
    // meta_event (heartbeat/lifecycle) — just update lastEventAt (done above)
  }

  /** Compute the reconnect delay for the current attempt (exposed for testing). */
  getReconnectDelay(): number {
    return Math.min(
      OneBotClient.INITIAL_DELAY_MS *
        Math.pow(OneBotClient.BACKOFF_FACTOR, this.reconnectAttempts),
      OneBotClient.MAX_DELAY_MS,
    );
  }

  private scheduleReconnect(): void {
    if (this._destroyed) return;
    this.clearReconnectTimer();

    const delay = this.getReconnectDelay();
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(async () => {
      if (this._destroyed) return;
      try {
        await this.connect();
      } catch {
        // connect failure will trigger close → scheduleReconnect again
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHeartbeatMonitor(): void {
    this.stopHeartbeatMonitor();
    this.heartbeatTimer = setInterval(() => {
      if (!this._connected || !this.ws) return;

      // If we already have a pong timer running, don't send another ping
      if (this.pongTimer) return;

      const elapsed = Date.now() - this.lastEventAt;
      if (elapsed >= OneBotClient.HEARTBEAT_INTERVAL_MS) {
        // No events in a while, send a ping and start pong timeout
        try {
          this.ws.ping();
          this.startPongTimer();
        } catch {
          // ping failed — force reconnect
          this.forceReconnect("ping failed");
        }
      }
    }, OneBotClient.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeatMonitor(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startPongTimer(): void {
    this.clearPongTimer();
    this.pongTimer = setTimeout(() => {
      // No pong received within timeout — connection is dead
      this.forceReconnect("pong timeout");
    }, OneBotClient.PONG_TIMEOUT_MS);
  }

  private clearPongTimer(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  /** Force-close the WS and actively drive reconnect cycle. */
  private forceReconnect(reason: string): void {
    if (this._destroyed) return;
    this._connected = false;
    this.stopHeartbeatMonitor();
    this.clearPongTimer();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.emit("disconnected", reason);
    this.scheduleReconnect();
  }

  private rejectAllPending(reason: string): void {
    for (const [echo, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pendingCalls.delete(echo);
    }
  }
}
