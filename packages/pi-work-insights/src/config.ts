import { z } from "zod";
import { Hash } from "./contract.js";
import { digest } from "./identity.js";

export const DEBOUNCE_MS = 10_000;
export const MIN_INTERVAL_MS = 120_000;
export const REQUEST_TIMEOUT_MS = 45_000;
export const HOURLY_REQUEST_LIMIT = 6;
export const HOUR_MS = 3_600_000;
export const MAX_OUTPUT_TOKENS = 4096;
export const DestinationSchema = z.strictObject({
  provider: z.string().min(1).max(256), model: z.string().min(1).max(256),
  endpoint: z.string().max(2048), fingerprint: Hash,
});
export type Destination = z.infer<typeof DestinationSchema>;
export const SettingsSchema = z.strictObject({
  version: z.literal(1), revision: z.uuid(), enabled: z.boolean(), destination: DestinationSchema.nullable(),
  attempts: z.array(z.strictObject({ at: z.number().int().nonnegative(), observationId: Hash, token: z.uuid() })).max(HOURLY_REQUEST_LIMIT),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const INITIAL_REVISION = "00000000-0000-0000-0000-000000000000";
export const defaultSettings = (): Settings => ({
  version: 1, revision: INITIAL_REVISION, enabled: false, destination: null, attempts: [],
});
/** Bind authorization to configured routing, not merely a display model name. Never persist credentials. */
export function destinationFor(model: { provider: string; id: string; baseUrl: string }, providerConfig: unknown): Destination {
  const url = new URL(model.baseUrl);
  return DestinationSchema.parse({
    provider: model.provider, model: model.id, endpoint: `${url.origin}${url.pathname}`,
    fingerprint: digest([model.provider, model.id, model.baseUrl, JSON.stringify(providerConfig ?? null)]),
  });
}
