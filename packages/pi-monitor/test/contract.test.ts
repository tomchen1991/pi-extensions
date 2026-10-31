import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClientFrameSchema, EventSchema, ServerFrameSchema } from "../src/contract.js";
import { exampleEvents, examples } from "../scripts/fixtures.js";

describe("versioned protocol artifacts", () => {
  it("keeps generated schemas equal to runtime validators", () => {
    for (const [name, schema] of [["client-frame", ClientFrameSchema], ["server-frame", ServerFrameSchema], ["event", EventSchema]] as const) {
      expect(JSON.parse(readFileSync(new URL(`../schema/${name}.schema.json`, import.meta.url), "utf8"))).toEqual(z.toJSONSchema(schema, { reused: "ref" }));
    }
  });
  it("validates deterministic synthetic examples and covers every event type", () => {
    const frames = readFileSync(new URL("../examples/connection.jsonl", import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(frames).toEqual(examples());
    for (const frame of frames) expect(ClientFrameSchema.safeParse(frame).success || ServerFrameSchema.safeParse(frame).success).toBe(true);
    const events = readFileSync(new URL("../examples/events.jsonl", import.meta.url), "utf8").trim().split("\n").map(line => EventSchema.parse(JSON.parse(line)));
    expect(events).toEqual(exampleEvents());
    expect(new Set(events.map(e => e.type))).toEqual(new Set(EventSchema.options.map(schema => schema.shape.type.value)));
  });
  it("rejects incompatible versions and unstructured payload fields", () => {
    expect(EventSchema.safeParse({ ...exampleEvents()[0], envelopeVersion: 2 }).success).toBe(false);
    expect(EventSchema.safeParse({ ...exampleEvents()[1], data: { ...exampleEvents()[1].data, prompt: "synthetic secret" } }).success).toBe(false);
    expect(ServerFrameSchema.safeParse({ version: 1, type: "ack", collectorEpoch: "epoch", eventIds: [], errorMessage: "secret" }).success).toBe(false);
  });
});
