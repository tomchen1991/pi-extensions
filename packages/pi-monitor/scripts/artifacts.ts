import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ClientFrameSchema, ServerFrameSchema, EventSchema } from "../src/contract.js";
import { examples, exampleEvents } from "./fixtures.js";
// Compiled script lives in dist/scripts; output belongs to the package root.
const packageRoot = new URL("../../", import.meta.url);
for (const dir of ["schema", "examples"]) mkdirSync(new URL(dir, packageRoot), { recursive: true });
for (const [name, schema] of [["client-frame", ClientFrameSchema], ["server-frame", ServerFrameSchema], ["event", EventSchema]] as const) {
  writeFileSync(new URL(`schema/${name}.schema.json`, packageRoot), JSON.stringify(z.toJSONSchema(schema, { reused: "ref" }), null, 2) + "\n");
}
const frames = examples().map(frame => ClientFrameSchema.safeParse(frame).success ? ClientFrameSchema.parse(frame) : ServerFrameSchema.parse(frame));
writeFileSync(new URL("examples/connection.jsonl", packageRoot), frames.map(frame => JSON.stringify(frame)).join("\n") + "\n");
writeFileSync(new URL("examples/events.jsonl", packageRoot), exampleEvents().map(event => JSON.stringify(EventSchema.parse(event))).join("\n") + "\n");
console.log(`Generated monitor schemas and synthetic examples in ${fileURLToPath(packageRoot)}`);
