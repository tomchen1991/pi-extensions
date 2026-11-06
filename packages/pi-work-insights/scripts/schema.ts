import { z } from "zod";
import { DraftSchema, ObservationSchema } from "../src/contract.js";
import { LatestPointerSchema } from "../src/storage.js";
import { writeFileSync, mkdirSync } from "node:fs";
const dir = new URL("../../schema/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const [name, schema] of [["observation", ObservationSchema], ["model-output", DraftSchema], ["latest", LatestPointerSchema]] as const) {
  writeFileSync(new URL(`${name}.schema.json`, dir), JSON.stringify(z.toJSONSchema(schema), null, 2) + "\n");
}
