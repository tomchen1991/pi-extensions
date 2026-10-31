import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { ClientFrameSchema, LIMITS, type MonitorEvent } from "../src/contract.js";
import { Transport } from "../src/transport.js";
import { delivery, epoch, exampleEvent, exampleState, source } from "../scripts/fixtures.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(test: () => boolean, timeout = 3000): Promise<void> {
  const end = Date.now() + timeout;
  while (!test()) {
    if (Date.now() >= end) throw Error("Timed out waiting for monitor protocol signal");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function server(onConnection: (socket: WebSocket, authorization: string | undefined) => void) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => { wss.once("listening", resolve); wss.once("error", reject); });
  wss.on("connection", (socket, request) => onConnection(socket, request.headers.authorization));
  cleanup.push(async () => { for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); });
  return { wss, endpoint: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ingest` };
}
function client(endpoint: string) {
  const state = exampleState();
  const transport = new Transport({ endpoint, token: "synthetic-secret", deviceId: source.deviceId, projectId: null }, source, epoch,
    () => ({ state, sequence: 1000 }), { retryBaseMs: 20, random: () => 0 });
  cleanup.push(() => transport.stop(0));
  return transport;
}
const ready = (socket: WebSocket) => socket.send(JSON.stringify({ version: 1, type: "ready", collectorEpoch: epoch }));
const ack = (socket: WebSocket, events: MonitorEvent[]) => socket.send(JSON.stringify({ version: 1, type: "ack", collectorEpoch: epoch, eventIds: events.map(e => e.eventId) }));

describe("bounded authenticated WS producer", () => {
  it("handshakes, sends current state before replay, validates every frame and waits for durable ACK", async () => {
    const frames: any[] = [];
    let auth: string | undefined;
    let peer: WebSocket;
    const { endpoint } = await server((socket, authorization) => {
      peer = socket; auth = authorization;
      socket.on("message", raw => {
        const frame = ClientFrameSchema.parse(JSON.parse(raw.toString()));
        frames.push(frame);
        if (frame.type === "hello") ready(socket);
      });
    });
    const transport = client(endpoint);
    transport.enqueue(exampleEvent());
    transport.start();
    await until(() => frames.length >= 3);
    expect(auth).toBe("Bearer synthetic-secret");
    expect(frames.slice(0, 3).map(f => f.type)).toEqual(["hello", "snapshot", "events"]);
    expect(transport.health().queuedEvents).toBe(1);
    expect(JSON.stringify(frames)).not.toContain("synthetic-secret");
    ack(peer!, [exampleEvent()]);
    await until(() => transport.health().queuedEvents === 0);
    expect(transport.health().connection).toBe("connected");
  });

  it("replays identical event IDs after disconnect before ACK and never removes unsent records", async () => {
    let connections = 0;
    const received: string[] = [];
    const { endpoint } = await server(socket => {
      connections++;
      const number = connections;
      socket.on("message", raw => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "hello") ready(socket);
        if (frame.type === "events") {
          received.push(frame.events[0].eventId);
          if (number === 1) socket.terminate();
          else ack(socket, frame.events);
        }
      });
    });
    const transport = client(endpoint);
    transport.enqueue(exampleEvent());
    transport.start();
    await until(() => received.length >= 2 && transport.health().queuedEvents === 0);
    expect(received.slice(0, 2)).toEqual([exampleEvent().eventId, exampleEvent().eventId]);
  });

  it("bounds queue count/bytes, reports unconfirmed eviction, rejects content outside schema", async () => {
    const transport = client("ws://127.0.0.1:1");
    for (let i = 1; i <= 2000; i++) transport.enqueue(exampleEvent(i));
    expect(transport.health().queuedEvents).toBeLessThanOrEqual(LIMITS.queueEvents);
    expect(transport.health().queuedBytes).toBeLessThanOrEqual(LIMITS.queueBytes);
    expect(transport.health().droppedUnconfirmed).toBeGreaterThan(0);
    expect(transport.health().lastDroppedSequence).not.toBeNull();
    transport.enqueue({ ...exampleEvent(), secret: "do-not-send" } as MonitorEvent);
    expect(transport.health().rejectedEvents).toBe(1);
    await transport.stop(0);
    transport.start();
    expect(transport.health().connection).toBe("stopped");
  });

  it("limits batches and ignores forged ACKs for records not yet sent", async () => {
    const batches: MonitorEvent[][] = [];
    let peer: WebSocket;
    const { endpoint } = await server(socket => {
      peer = socket;
      socket.on("message", raw => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "hello") ready(socket);
        if (frame.type === "events") batches.push(frame.events);
      });
    });
    const transport = client(endpoint);
    for (let i = 1; i <= 100; i++) transport.enqueue(exampleEvent(i));
    transport.start();
    await until(() => batches.length === 1);
    ack(peer!, [exampleEvent(100)]);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(transport.health().queuedEvents).toBe(100);
    expect(batches[0].length).toBeLessThanOrEqual(LIMITS.batchEvents);
    ack(peer!, batches[0]);
    await until(() => batches.length === 2);
    expect(transport.health().queuedEvents).toBe(100 - batches[0].length);
  });

  it("fails closed on wrong epoch/malformed responses and retries without losing queued records", async () => {
    let connections = 0;
    let received = false;
    const { endpoint } = await server(socket => {
      const number = ++connections;
      socket.on("message", raw => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "hello") {
          if (number === 1) socket.send("not-json");
          else if (number === 2) socket.send(JSON.stringify({ version: 1, type: "ready", collectorEpoch: "wrong" }));
          else ready(socket);
        }
        if (frame.type === "events") { received = true; ack(socket, frame.events); }
      });
    });
    const transport = client(endpoint);
    transport.enqueue(exampleEvent());
    transport.start();
    await until(() => received && transport.health().queuedEvents === 0);
    expect(connections).toBeGreaterThanOrEqual(3);
  });

  it("stops reconnecting after explicit rejection and closes within the shutdown deadline", async () => {
    let connections = 0;
    const { endpoint } = await server(socket => {
      connections++;
      socket.on("message", () => socket.send(JSON.stringify({ version: 1, type: "reject", code: "unauthorized" })));
    });
    const transport = client(endpoint);
    transport.start();
    await until(() => transport.health().connection === "rejected");
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(connections).toBe(1);
    await transport.stop();
    expect(transport.health().connection).toBe("stopped");
  });

  it("does not retry HTTP authentication rejection", async () => {
    let attempts = 0;
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, verifyClient: (_info, done) => { attempts++; done(false, 401, "Unauthorized"); } });
    await new Promise<void>((resolve, reject) => { wss.once("listening", resolve); wss.once("error", reject); });
    cleanup.push(async () => { for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); });
    const transport = client(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
    transport.start();
    await until(() => transport.health().connection === "rejected");
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(attempts).toBe(1);
  });

  it("does not wait indefinitely for ready", async () => {
    let connections = 0;
    const { endpoint } = await server(() => { connections++; });
    const transport = client(endpoint);
    transport.start();
    await until(() => connections >= 2, LIMITS.connectMs + 2000);
    expect(transport.health().queuedEvents).toBe(0);
  }, 9000);

  it("reconnects on missing ACK and has a bounded flush on shutdown", async () => {
    let batches = 0;
    const { endpoint } = await server(socket => socket.on("message", raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "hello") ready(socket);
      if (frame.type === "events") batches++;
    }));
    const transport = client(endpoint);
    transport.enqueue(exampleEvent());
    transport.start();
    await until(() => batches >= 2, LIMITS.ackMs + 2000);
    const start = performance.now();
    await transport.stop(50);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(transport.health().connection).toBe("stopped");
  }, 14000);
});
