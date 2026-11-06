import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { DraftSchema, ObservationSchema, validateObservation } from "../src/contract.js";
import { fixture } from "./fixtures/synthetic.js";
import { LatestPointerSchema } from "../src/storage.js";
const json = (relative: string) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));

it("generated JSON schemas match the runtime shapes", () => {
  expect(json("../schema/observation.schema.json")).toEqual(z.toJSONSchema(ObservationSchema));
  expect(json("../schema/model-output.schema.json")).toEqual(z.toJSONSchema(DraftSchema));
  expect(json("../schema/latest.schema.json")).toEqual(z.toJSONSchema(LatestPointerSchema));
});
it("documented complete and empty JSON examples are valid and reproducible", () => {
  expect(validateObservation(json("../examples/observation.json"))).toEqual(fixture());
  expect(validateObservation(json("../examples/empty-observation.json"))).toEqual(fixture(true));
});
