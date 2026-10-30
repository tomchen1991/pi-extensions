import { mkdirSync, writeFileSync } from "node:fs";
import { fixture } from "../test/fixtures/synthetic.js";
const dir = new URL("../../examples/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const [name, empty] of [["empty-observation", true], ["observation", false]] as const) {
  writeFileSync(new URL(`${name}.json`, dir), JSON.stringify(fixture(empty), null, 2) + "\n");
}
