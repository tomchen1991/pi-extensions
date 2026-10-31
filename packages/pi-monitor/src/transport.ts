import WebSocket from "ws";
import { ClientFrameSchema, EventSchema, LIMITS, ServerFrameSchema, type Delivery, type MonitorEvent, type Source, type State } from "./contract.js";
import type { Config } from "./config.js";

type Item = { event: MonitorEvent; bytes: number };
export type ConnectionStatus = "offline" | "connecting" | "handshaking" | "connected" | "rejected" | "stopped";

/** One socket, one in-flight batch, bounded queue. No payloads/errors/credentials are logged. */
export class Transport {
  private socket?: WebSocket;
  private queue: Item[] = [];
  private bytes = 0;
  private dropped = 0;
  private lastDropped: number | null = null;
  private rejected = 0;
  private inflight = new Set<string>();
  private ackAt = 0;
  private readyAt = 0;
  private lastPong = 0;
  private lastPing = 0;
  private lastAttemptSnapshot = 0;
  private dirty = true;
  private attempts = 0;
  private stopped = false;
  private closing = false;
  private blocked = false;
  private timer?: NodeJS.Timeout;
  private timerAt = 0;
  private started = false;
  private retry?: NodeJS.Timeout;
  private status: ConnectionStatus = "offline";

  constructor(private config: Config, private source: Source, private epoch: string,
    private snapshot: () => { state: State; sequence: number },
    private options: { random?: () => number; retryBaseMs?: number } = {}) {}

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.connect();
  }
  changed(): void {
    this.dirty = true;
    if (this.status === "connected") this.requestTick(LIMITS.flushMs);
  }
  private requestTick(delay: number): void {
    if (this.stopped) return;
    const at = Date.now() + Math.max(1, delay);
    if (this.timer && this.timerAt <= at) return;
    clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => { this.timer = undefined; this.tick(); }, Math.max(1, delay));
    this.timer.unref();
  }
  observationFailed(): void { this.rejected++; this.changed(); }
  health(): Delivery & { connection: ConnectionStatus } {
    return { connection: this.status, queuedEvents: this.queue.length, queuedBytes: this.bytes,
      droppedUnconfirmed: this.dropped, lastDroppedSequence: this.lastDropped, rejectedEvents: this.rejected };
  }
  private delivery(): Delivery {
    const { connection: _, ...delivery } = this.health();
    return delivery;
  }
  enqueue(event: MonitorEvent): void {
    if (this.stopped) return;
    const parsed = EventSchema.safeParse(event);
    if (!parsed.success) { this.rejected++; this.dirty = true; return; }
    const bytes = Buffer.byteLength(JSON.stringify(parsed.data));
    if (bytes > LIMITS.batchBytes - 1024) { this.rejected++; this.dirty = true; return; }
    while (this.queue.length && (this.bytes + bytes > LIMITS.queueBytes || this.queue.length >= LIMITS.queueEvents)) {
      const old = this.queue.shift()!;
      this.bytes -= old.bytes;
      this.inflight.delete(old.event.eventId);
      this.dropped++;
      this.lastDropped = old.event.sequence;
    }
    this.queue.push({ event: parsed.data, bytes });
    this.bytes += bytes;
    this.changed();
  }
  private connect(): void {
    if (this.stopped || this.blocked) return;
    this.status = "connecting";
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.config.endpoint, {
        headers: { Authorization: `Bearer ${this.config.token}` },
        followRedirects: false, perMessageDeflate: false, rejectUnauthorized: true,
        handshakeTimeout: LIMITS.connectMs, maxPayload: LIMITS.frameBytes,
      });
    } catch { this.schedule(); return; }
    this.socket = socket;
    socket.on("open", () => {
      if (this.socket !== socket || this.stopped) { socket.terminate(); return; }
      this.status = "handshaking";
      this.readyAt = this.lastPong = Date.now();
      this.lastPing = 0;
      this.requestTick(LIMITS.connectMs);
      this.send({ version: 1, type: "hello", protocol: "pi-monitor", source: this.source, collectorEpoch: this.epoch, delivery: this.delivery() });
    });
    socket.on("pong", () => { if (this.socket === socket) this.lastPong = Date.now(); });
    socket.on("message", (raw, binary) => {
      if (this.socket !== socket || this.stopped) return;
      const buffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
      if (binary || buffer.byteLength > LIMITS.frameBytes) { socket.terminate(); return; }
      let value: unknown;
      try { value = JSON.parse(buffer.toString("utf8")); } catch { socket.terminate(); return; }
      const frame = ServerFrameSchema.safeParse(value);
      if (!frame.success) { socket.terminate(); return; }
      const message = frame.data;
      if (message.type === "reject") { this.blocked = true; this.status = "rejected"; socket.terminate(); return; }
      if (message.collectorEpoch !== this.epoch) { socket.terminate(); return; }
      if (message.type === "ready") {
        if (this.status !== "handshaking") { socket.terminate(); return; }
        this.status = "connected";
        this.attempts = 0;
        this.dirty = true;
        this.publishSnapshot();
        this.flush();
        this.requestTick(LIMITS.flushMs);
      } else {
        if (this.status !== "connected") { socket.terminate(); return; }
        const ack = new Set(message.eventIds.filter(id => this.inflight.has(id)));
        this.queue = this.queue.filter(item => {
          if (!ack.has(item.event.eventId)) return true;
          this.bytes -= item.bytes;
          this.inflight.delete(item.event.eventId);
          return false;
        });
        // Unknown/duplicate ACKs never remove unsent records or extend the timeout.
        if (!this.inflight.size) this.flush();
      }
    });
    socket.on("unexpected-response", (request, response) => {
      if (response.statusCode === 401 || response.statusCode === 403) { this.blocked = true; this.status = "rejected"; }
      response.destroy();
      request.destroy();
      socket.terminate();
    });
    socket.on("error", () => { /* close handles retry; never expose raw error text */ });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.inflight.clear();
      if (!this.stopped) this.schedule();
    });
  }
  private schedule(): void {
    if (this.stopped || this.blocked || this.retry) return;
    this.status = "offline";
    const base = this.options.retryBaseMs ?? 500;
    const random = this.options.random ?? Math.random;
    const delay = Math.min(30000, base * 2 ** Math.min(this.attempts++, 10)) * (0.5 + random() * 0.5);
    this.retry = setTimeout(() => { this.retry = undefined; this.connect(); }, delay);
    this.retry.unref();
  }
  private send(frame: unknown): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const parsed = ClientFrameSchema.safeParse(frame);
    if (!parsed.success) { this.rejected++; return false; }
    const data = JSON.stringify(parsed.data);
    if (Buffer.byteLength(data) > LIMITS.frameBytes) { this.rejected++; return false; }
    if (socket.bufferedAmount > LIMITS.frameBytes) { socket.terminate(); return false; }
    try {
      socket.send(data, error => { if (error && this.socket === socket) socket.terminate(); });
      return true;
    } catch { socket.terminate(); return false; }
  }
  private publishSnapshot(): void {
    const now = Date.now();
    this.lastAttemptSnapshot = now;
    const { state, sequence } = this.snapshot();
    if (this.send({ version: 1, type: "snapshot", source: this.source, collectorEpoch: this.epoch,
      throughSequence: sequence, observedAt: new Date(now).toISOString(),
      heartbeatIntervalMs: state.status === "idle" ? LIMITS.idleHeartbeatMs : LIMITS.activeHeartbeatMs,
      state, delivery: this.delivery() })) {
      this.dirty = false;
    }
  }
  private flush(): void {
    if (this.status !== "connected" || this.inflight.size || !this.queue.length) return;
    const items: Item[] = [];
    let bytes = 1024;
    for (const item of this.queue) {
      if (items.length >= LIMITS.batchEvents || bytes + item.bytes > LIMITS.batchBytes) break;
      items.push(item);
      bytes += item.bytes;
    }
    if (!items.length) return;
    if (this.send({ version: 1, type: "events", source: this.source, collectorEpoch: this.epoch, events: items.map(i => i.event) })) {
      this.inflight = new Set(items.map(i => i.event.eventId));
      this.ackAt = Date.now();
      this.requestTick(LIMITS.ackMs);
    }
  }
  private tick(): void {
    if (this.stopped) return;
    const now = Date.now();
    if (this.status === "handshaking") {
      if (now - this.readyAt >= LIMITS.connectMs) this.socket?.terminate();
      else this.requestTick(this.readyAt + LIMITS.connectMs - now);
      return;
    }
    if (this.status !== "connected") return;
    if ((this.inflight.size && now - this.ackAt >= LIMITS.ackMs) || now - this.lastPong >= 30000) { this.socket?.terminate(); return; }
    if (now - this.lastPing >= 10000) { this.socket?.ping(); this.lastPing = now; }
    const heartbeat = this.snapshot().state.status === "idle" ? LIMITS.idleHeartbeatMs : LIMITS.activeHeartbeatMs;
    if ((this.dirty && now - this.lastAttemptSnapshot >= LIMITS.snapshotMs) || now - this.lastAttemptSnapshot >= heartbeat) this.publishSnapshot();
    this.flush();
    const deadlines = [this.lastPing + 10000, this.lastPong + 30000, this.lastAttemptSnapshot + heartbeat];
    if (this.dirty) deadlines.push(this.lastAttemptSnapshot + LIMITS.snapshotMs);
    if (this.inflight.size) deadlines.push(this.ackAt + LIMITS.ackMs);
    this.requestTick(Math.min(...deadlines) - Date.now());
  }
  async stop(deadlineMs = LIMITS.shutdownMs): Promise<void> {
    if (this.stopped || this.closing) return;
    this.closing = true;
    if (this.status === "connected") { this.publishSnapshot(); this.flush(); }
    const deadline = Date.now() + deadlineMs;
    while (this.queue.length && this.status === "connected" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
    }
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.retry);
    this.timer = this.retry = undefined;
    this.status = "stopped";
    this.socket?.terminate();
    this.socket = undefined;
    this.inflight.clear();
    this.queue = [];
    this.bytes = 0;
  }
}
