import type { Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACCOUNTS, configPath, isAccount, readConfig, repositoryRoot, writeConfig, type Account } from "./config.js";
import { accountProviders, profileId, ROUTER, type Selection } from "./providers.js";

const STATUS = "codex-accounts";
const HELP = "/codex-account [use personal|work | off | reload | status]";
const isCodex = (provider: string | undefined) => provider === "openai-codex" || provider === ROUTER;

export function registerAccounts(pi: ExtensionAPI, base: Provider): void {
  let state: Selection = { account: null };
  let context: ExtensionContext | undefined;
  let path: string | undefined;
  let locked = false;
  let generation = 0;
  const profiles = accountProviders(base, () => state, async id => {
    if (!context) throw Error("Account session is closed");
    return context.modelRegistry.getProviderAuth(id);
  });
  for (const provider of profiles) pi.registerProvider(provider);

  function status(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const value = state.error ? "config error" : state.account ?? "off";
    const suffix = ctx.model?.provider === ROUTER ? "" : " (inactive)";
    ctx.ui.setStatus(STATUS, `ChatGPT: ${value}${suffix}`);
  }
  function notify(ctx: ExtensionContext, text: string, type: "info" | "warning" | "error" = "info"): void {
    if (ctx.hasUI) ctx.ui.notify(text, type);
  }
  async function selectModel(ctx: ExtensionContext, account: Account | null, error = false): Promise<void> {
    let source = ctx.model;
    if (!source || source.provider === "unknown") {
      // SDK consumers may bind extensions only after initial model restoration.
      // Recover the saved selection without guessing a different model ID.
      const saved = [...ctx.sessionManager.getBranch()].reverse().find(entry => entry.type === "model_change");
      const settings = pi.getSettings();
      const sourceProvider = saved?.type === "model_change" ? saved.provider : settings.defaultProvider;
      const id = saved?.type === "model_change" ? saved.modelId : settings.defaultModel;
      if (isCodex(sourceProvider) && id) source = ctx.modelRegistry.find(account || error ? ROUTER : "openai-codex", id);
    }
    if (!source || !isCodex(source.provider)) return;
    const provider = account || error ? ROUTER : "openai-codex";
    if (ctx.model?.provider === provider) return;
    const model = ctx.modelRegistry.find(provider, source.id);
    if (!model) throw Error("The same model ID is not available");
    const thinking = pi.getThinkingLevel();
    if (!await pi.setModel(model)) throw Error("The target provider is not available");
    pi.setThinkingLevel(thinking);
  }
  async function load(ctx: ExtensionContext, applyOff = false): Promise<void> {
    const current = generation;
    let explicitOff = applyOff;
    path = undefined;
    state = { account: null };
    if (!ctx.isProjectTrusted()) {
      // Do not honor project config or interfere with the ordinary login in an untrusted project.
      status(ctx);
      return;
    }
    let root: string;
    try { root = await repositoryRoot(ctx.cwd); } catch { status(ctx); return; }
    if (current !== generation) return;
    try {
      path = configPath(root, CONFIG_DIR_NAME);
      const config = await readConfig(path);
      if (current !== generation) return;
      state = { account: config?.account ?? null };
      explicitOff ||= config?.account === null;
    } catch {
      if (current !== generation) return;
      state = { account: null, error: "Cannot read repository account config; fix it and run /codex-account reload" };
      notify(ctx, state.error!, "error");
    }
    if (current !== generation) return;
    try {
      // Refresh availability only; the router's check never resolves OAuth or performs network I/O.
      await ctx.modelRegistry.refresh({ allowNetwork: false, providers: [ROUTER], signal: AbortSignal.timeout(3000) });
      if (current !== generation) return;
      // Missing config on startup must not silently restore the default login for an old router session.
      if (state.account || state.error || explicitOff) await selectModel(ctx, state.account, !!state.error);
    } catch {
      if (current !== generation) return;
      state = { account: state.account, error: "Repository account could not be selected; use /codex-account reload before continuing" };
      notify(ctx, state.error!, "error");
    }
    if (current === generation) status(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    generation++;
    context = ctx;
    locked = true;
    try { await load(ctx); } finally { locked = false; }
  });
  pi.on("session_shutdown", () => {
    generation++;
    context = undefined;
    path = undefined;
    state = { account: null, error: "Account session is closed" };
  });
  pi.on("model_select", (_event, ctx) => status(ctx));

  pi.registerCommand("codex-account", {
    description: "Select personal/work ChatGPT OAuth account for this repository",
    getArgumentCompletions: prefix => {
      const choices = ["use personal", "use work", "off", "reload", "status"]
        .filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
      return choices.length ? choices : null;
    },
    handler: async (args, ctx) => {
      const text = args.trim();
      if (text === "status") {
        const accounts = ACCOUNTS.map(account => `${account}: ${ctx.modelRegistry.getProviderAuthStatus(profileId(account)).configured ? "logged in" : "not logged in"}`);
        notify(ctx, [`Repository choice: ${state.error ? "config error" : state.account ?? "off"}`,
          `Active provider: ${ctx.model?.provider ?? "none"}`, ...accounts,
          "Other running sessions keep their choice until /codex-account reload."].join("\n"));
        return;
      }
      if (locked || !ctx.isIdle()) {
        notify(ctx, "Wait for the current request or account operation to finish before switching.", "warning");
        return;
      }
      if (!ctx.isProjectTrusted()) {
        notify(ctx, "Trust this project before configuring repository accounts.", "error");
        return;
      }
      locked = true;
      const current = generation;
      const previous = state;
      const previousModel = ctx.model;
      const thinking = pi.getThinkingLevel();
      let moved = false;
      try {
        if (text === "reload") { await load(ctx, true); return; }
        let choice: string | undefined = text === "off" ? "off" : text.startsWith("use ") ? text.slice(4) : undefined;
        if (!text) {
          if (!ctx.hasUI) return;
          choice = await ctx.ui.select("ChatGPT account for this repository", [...ACCOUNTS, "off"]);
          if (!choice) return;
        }
        if (!(choice === "off" || isAccount(choice))) { notify(ctx, HELP, "warning"); return; }
        if (current !== generation || !ctx.isIdle()) return;
        const account = choice === "off" ? null : choice as Account;
        if (account && !ctx.modelRegistry.getProviderAuthStatus(profileId(account)).configured) {
          notify(ctx, `Log in first: /login ${profileId(account)}. Use your own account and check which browser account is authorized.`, "warning");
          return;
        }
        if (!path) path = configPath(await repositoryRoot(ctx.cwd), CONFIG_DIR_NAME);
        if (current !== generation) return;
        state = { ...previous, changing: true };
        await selectModel(ctx, account);
        moved = ctx.model?.provider !== previousModel?.provider;
        if (current !== generation) return;
        await writeConfig(path, { version: 1, account });
        if (current !== generation) return;
        state = { account };
        notify(ctx, account
          ? `Repository account: ${account}. Future Codex requests use it; existing context is sent to this account. No request was automatically retried.`
          : "Repository account selection is off. The original Pi login is unchanged.");
      } catch {
        if (current !== generation) return;
        state = previous;
        if (moved && previousModel) {
          try { await pi.setModel(previousModel); pi.setThinkingLevel(thinking); } catch { /* State still retains the previous account. */ }
        }
        notify(ctx, "Account switch failed. Check the Git repository, config permissions, and target login. No account config was published on write failure.", "error");
      } finally {
        if (current === generation) { locked = false; status(ctx); }
      }
    },
  });
}

export default function (pi: ExtensionAPI): void {
  const base = builtinProviders().find(provider => provider.id === "openai-codex");
  if (!base) throw Error("This SDK does not provide OpenAI Codex OAuth");
  registerAccounts(pi, base);
}
