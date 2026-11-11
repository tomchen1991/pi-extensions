import type { Api, AuthResult, Model, Provider } from "@earendil-works/pi-ai";
import { ACCOUNTS, type Account } from "./config.js";

export const ROUTER = "codex-accounts";
export const profileId = (account: Account): string => `codex-account-${account}`;
export type Selection = { account: Account | null; error?: string; changing?: boolean };

function officialEndpoint(value: string | undefined): void {
  if (!value) return;
  const url = new URL(value);
  if (url.origin !== "https://chatgpt.com" || url.username || url.password) throw Error("Codex accounts requires the official ChatGPT endpoint");
}

export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The operation may already have started before the helper received the signal.
    void operation.catch(() => {});
    signal.throwIfAborted();
  }
  let cancel!: () => void;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      cancel = () => reject(Error("Account authentication cancelled"));
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    })]);
  } finally { signal.removeEventListener("abort", cancel); }
}

/** Reuse the host's OAuth implementation and locked credential refresh. No token copies. */
export function accountProviders(
  base: Provider,
  selection: () => Selection,
  resolveProfile: (id: string) => Promise<AuthResult | undefined>,
): Provider[] {
  const oauth = base.auth.oauth;
  if (!oauth) throw Error("The installed SDK has no Codex OAuth provider");
  const profiles: Provider[] = ACCOUNTS.map(account => ({
    ...base,
    id: profileId(account),
    name: `ChatGPT account: ${account}`,
    auth: { oauth: { ...oauth, name: `ChatGPT account: ${account}` } },
    // Authentication entries, not duplicate model catalogs.
    getModels: () => [], getAllModels: () => [],
  }));
  const models = base.getModels().map(model => ({ ...model, provider: ROUTER }));
  function validate(model: Model<Api>): void { officialEndpoint(model.baseUrl); }
  const router: Provider = {
    ...base,
    id: ROUTER,
    name: "ChatGPT (repository account)",
    getModels: () => models, getAllModels: () => models,
    auth: { apiKey: {
      name: "Repository account selector (use /codex-account)",
      // Keep selectable even for missing/invalid config: resolve fails closed, never uses default OAuth.
      check: async () => ({ type: "api_key", source: "repository account selector" }),
      resolve: async ({ signal }) => {
        const selected = selection();
        if (selected.changing) throw Error("Account selection is changing; retry after it finishes");
        if (selected.error) throw Error(selected.error);
        if (!selected.account) throw Error("Choose an account with /codex-account use personal or work");
        let result: AuthResult | undefined;
        try {
          result = await abortable(resolveProfile(profileId(selected.account)),
            AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
        } catch {
          throw Error(`Account authentication failed; use /login ${profileId(selected.account)}`);
        }
        if (selection() !== selected) throw Error("Account selection changed during authentication; retry manually");
        if (!result?.auth.apiKey) throw Error(`Account is not logged in; use /login ${profileId(selected.account)}`);
        officialEndpoint(result.auth.baseUrl);
        return { ...result, source: `ChatGPT account: ${selected.account}` };
      },
    } },
    stream: (model, context, options) => { validate(model); return base.stream(model, context, options); },
    streamSimple: (model, context, options) => { validate(model); return base.streamSimple(model, context, options); },
  };
  // If startup cannot select the same model ID, or the user picks the default Codex
  // provider while a repo account is enabled, never send a model request as the wrong account.
  // Authentication is unchanged: the host may still refresh its original OAuth credential.
  function guardDefault(): void {
    const selected = selection();
    if (selected.account || selected.error || selected.changing) {
      throw Error("Repository account selection is enabled; select codex-accounts or run /codex-account off");
    }
  }
  const guardedDefault: Provider = {
    ...base,
    stream: (model, context, options) => { guardDefault(); return base.stream(model, context, options); },
    streamSimple: (model, context, options) => { guardDefault(); return base.streamSimple(model, context, options); },
  };
  return [guardedDefault, ...profiles, router];
}
