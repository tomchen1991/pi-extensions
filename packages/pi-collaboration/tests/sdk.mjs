// Opt-in integration test: real installed PI SDK + bundled extension + local relay,
// separate processes, temporary HOME/config, faux models, no API credentials needed.
// PI_SDK_DIR=/absolute/path/to/pi-coding-agent npm run test:sdk
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const deckz = process.env.PI_COLLAB_TEST_MODE === 'deckz';
const toolName = deckz ? 'deckz_collaboration' : 'pi_collaboration';
const customType = deckz ? 'deckz-peer-message' : 'pi-peer-message';
const tokenEnv = deckz ? 'DECKZ_PI_COLLAB_TOKEN' : 'PI_COLLAB_TOKEN';
const endpointEnv = deckz ? 'DECKZ_PI_COLLAB_ENDPOINT' : 'PI_COLLAB_ENDPOINT';
const extensionPath = path.resolve(here, deckz ? '../deckz-extension.mjs' : '../extension.mjs');
const sdkDir = process.env.PI_SDK_DIR;
if (!sdkDir || !path.isAbsolute(sdkDir)) throw new Error('Set PI_SDK_DIR to the installed PI 1.1+ package directory');

if (process.argv.includes('--worker')) {
  const require = createRequire(path.join(sdkDir, 'package.json'));
  const aiEntry = require.resolve.paths('@earendil-works/pi-ai').map((root) => path.join(root, '@earendil-works/pi-ai/dist/index.js')).find(existsSync);
  if (!aiEntry) throw new Error('Cannot locate the installed PI AI dependency');
  const { fauxProvider, fauxAssistantMessage } = await import(pathToFileURL(aiEntry));
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(path.join(sdkDir, 'dist/index.js')));
  // A host may install a proxy dispatcher. The companion must use direct loopback HTTP.
  globalThis.fetch = async () => { throw new Error('Unexpected global fetch in offline integration test'); };
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const faux = fauxProvider({ provider: 'deckz-test' });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  let calls = 0;
  let hold = false;
  let failNext = false;
  let dropReceipt = false;
  const releases = [];
  faux.setResponses(Array.from({ length: 100 }, () => async () => {
    calls++;
    if (hold) await new Promise((resolve) => releases.push(resolve));
    if (failNext) {
      failNext = false;
      return { ...fauxAssistantMessage(''), stopReason: 'error', errorMessage: 'quota exhausted (test)' };
    }
    return fauxAssistantMessage('simulated response');
  }));
  let session;
  async function start(sessionManager = SessionManager.inMemory(agentDir)) {
    const loader = new DefaultResourceLoader({
      cwd: agentDir, agentDir, noExtensions: true,
      additionalExtensionPaths: [extensionPath],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: agentDir, agentDir, model: faux.getModel(), modelRuntime, resourceLoader: loader,
      noTools: 'builtin', sessionManager,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    }));
    await session.bindExtensions({ mode: 'tui', uiContext: { ...session.extensionRunner.getUIContext(), notify: () => {}, setStatus: () => {} } });
    const emit = session.extensionRunner.emit.bind(session.extensionRunner);
    session.extensionRunner.emit = async (event, ...args) => {
      if (dropReceipt && event.type === 'message_end' && event.message?.customType === customType) return;
      return emit(event, ...args);
    };
    const tool = session.getToolDefinition(toolName);
    assert.ok(tool, 'bundled extension loaded');
    // Assert the actual registered JSON schema, not just the extension source text.
    // Faux models do not reject provider-incompatible anyOf/const schemas.
    assert.deepEqual(JSON.parse(JSON.stringify(tool.parameters.properties.action)), {
      type: 'string', enum: ['list', 'send', 'status'],
    }, 'action must use a Google/Vertex-compatible string enum');
  }
  async function stop() {
    hold = false;
    for (const release of releases.splice(0)) release();
    await session.abort();
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
  }
  await start();
  process.send({ ready: true });
  process.on('message', async ({ id, action, input }) => {
    try {
      let result;
      if (action === 'tool') {
        result = (await session.getToolDefinition(toolName).execute(`smoke-${id}`, input, new AbortController().signal, undefined, undefined)).details;
      } else if (action === 'state') {
        result = { calls, streaming: session.isStreaming, messages: session.messages.filter((m) => m.role === 'custom'), credentialsInEnv: Boolean(process.env[tokenEnv]), sessionName: session.sessionManager.getSessionName() };
      } else if (action === 'identity') {
        const emitted = await session.extensionRunner.emitBeforeAgentStart({ messageType: 'user', prompt: 'ping' }, { cwd: agentDir });
        result = {
          section: emitted.systemPromptOptions.sections[toolName],
          forced: emitted.systemPromptOptions.forceSystemPrompt !== undefined,
        };
      } else if (action === 'drop-receipt') {
        dropReceipt = Boolean(input); result = {};
      } else if (action === 'fail-next') {
        failNext = true; result = {};
      } else if (action === 'prompt') {
        await session.prompt('User resumes after fixing the model'); result = {};
      } else if (action === 'hold') {
        hold = true;
        void session.prompt('Hold the current task for the test').catch(() => {});
        result = {};
      } else if (action === 'release') {
        hold = false;
        for (const release of releases.splice(0)) release();
        result = {};
      } else if (action === 'replace-session') {
        // 模拟 /new 的未命名会话和 /resume 带有已保存名字的会话。
        const manager = SessionManager.inMemory(agentDir);
        if (input?.name) manager.appendSessionInfo(input.name);
        await stop(); await start(manager); result = {};
      } else if (action === 'reload') {
        await stop(); await start(); result = {};
      } else if (action === 'close') {
        await stop(); process.send({ id, result: {} }); process.disconnect(); return;
      }
      process.send({ id, result });
    } catch (error) { process.send({ id, error: error.stack }); }
  });
} else {
  const { PiCollaborationService } = await import('../dist/service.js');
  const home = mkdtempSync(path.join(tmpdir(), 'deckz-collaboration-test-'));
  let clockOffset = 0;
  const relay = new PiCollaborationService(() => {}, () => Date.now() + clockOffset);
  const workers = [];
  let requestId = 0;
  const waitFor = async (predicate, description) => {
    const deadline = Date.now() + 15_000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  async function worker(name, group) {
    const credentials = relay.prepare(name, workers.length + 1, name, group, name);
    // Deliberately do not inherit provider credentials or the developer's PI settings.
    const child = fork(fileURLToPath(import.meta.url), ['--worker'], {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
        PI_SDK_DIR: sdkDir, PI_CODING_AGENT_DIR: path.join(home, name), PI_OFFLINE: '1', PI_TELEMETRY: '0',
        PI_COLLAB_TEST_MODE: deckz ? 'deckz' : 'standalone',
        [endpointEnv]: credentials.DECKZ_PI_COLLAB_ENDPOINT,
        [tokenEnv]: credentials.DECKZ_PI_COLLAB_TOKEN },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const pending = new Map();
    let ready = false;
    let exit;
    child.on('message', (message) => {
      if (message.ready) ready = true;
      else {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.result);
      }
    });
    child.on('exit', (code) => {
      exit = code;
      for (const request of pending.values()) request.reject(new Error(`Worker exited: ${code}`));
      pending.clear();
    });
    const w = {
      child,
      call(action, input) {
        return new Promise((resolve, reject) => {
          const id = ++requestId;
          const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Worker request timed out: ${action}`)); }, 10_000);
          pending.set(id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
          child.send({ id, action, input });
        });
      },
    };
    workers.push(w);
    await waitFor(() => { if (exit !== undefined) throw new Error(`Worker exited on startup: ${exit}`); return ready; }, `${name} ready`);
    return w;
  }
  try {
    await relay.start();
    const a = await worker('project-a', 'team');
    const b = await worker('project-b', 'team');
    const c = await worker('project-c', 'other');
    assert.equal((await a.call('state')).sessionName, 'project-a');
    await a.call('replace-session');
    assert.equal((await a.call('state')).sessionName, 'project-a', 'fresh sessions retain the collaboration name');
    await a.call('replace-session', { name: 'unrelated saved name' });
    assert.equal((await a.call('state')).sessionName, 'project-a', 'resumed sessions use the collaboration name');
    console.log('PASS: session_start 为新会话及已有名字的会话重新应用协作名字');
    const list = await a.call('tool', { action: 'list' });
    assert.equal(list.peers.length, 1);
    const bId = list.peers[0].id;
    assert.deepEqual((await c.call('tool', { action: 'list' })).peers, []);
    assert.equal((await a.call('state')).credentialsInEnv, false);
    const identity = await a.call('identity');
    assert.equal(identity.forced, false);
    assert.match(identity.section, /project-a/);
    assert.match(identity.section, new RegExp(list.self));
    assert.match(identity.section, /不能当收件人/);
    assert.doesNotMatch(identity.section, /尚未连接/);
    console.log('PASS: real extensions load in separate PI processes; discovery is group-scoped; child env stripped');

    const sent = await a.call('tool', { action: 'send', to: bId, message: 'Please review the interface' });
    await waitFor(async () => (await b.call('state')).calls === 1, 'idle recipient wakes the faux model');
    await waitFor(() => relay.snapshot().activity.find((m) => m.id === sent.messageId)?.status === 'delivered', 'transcript receipt');
    const bState = await b.call('state');
    assert.equal(bState.messages[0].customType, customType);
    assert.match(bState.messages[0].content, new RegExp(toolName));
    assert.match(bState.messages[0].content, /Please review/);
    assert.match(bState.messages[0].content, /project-a/);
    assert.equal(bState.messages[0].details.from, list.self);
    assert.equal((await c.call('state')).calls, 0);
    console.log('PASS: idle delivery starts a real PI run, retains peer provenance, and acknowledges the transcript');

    await b.call('tool', { action: 'send', to: list.self, replyTo: sent.messageId, message: 'Review complete' });
    await waitFor(async () => (await a.call('state')).calls === 1, 'reply');
    console.log('PASS: peer can reply using the original message ID');

    await b.call('hold');
    await waitFor(async () => (await b.call('state')).streaming, 'busy receiver');
    const before = (await b.call('state')).calls;
    const queued = await a.call('tool', { action: 'send', to: bId, message: 'Follow up after your current task' });
    await waitFor(() => relay.snapshot().activity.find((m) => m.id === queued.messageId)?.status === 'accepted', 'busy mail accepted locally');
    assert.equal((await b.call('state')).calls, before);
    await b.call('release');
    await waitFor(async () => (await b.call('state')).calls > before, 'follow-up run');
    await waitFor(() => relay.snapshot().activity.find((m) => m.id === queued.messageId)?.status === 'delivered', 'follow-up receipt');
    console.log('PASS: busy delivery queues a follow-up, does not interrupt the active run');

    await b.call('drop-receipt', true);
    const missed = await a.call('tool', { action: 'send', to: bId, message: 'Receipt event deliberately dropped' });
    await waitFor(() => relay.snapshot().activity.find((m) => m.id === missed.messageId)?.status === 'delivered', 'transcript repairs missing event');
    await b.call('drop-receipt', false);
    console.log('PASS: missed message_end is recovered from the real session branch');

    await b.call('fail-next');
    await a.call('tool', { action: 'send', to: bId, message: 'Trigger simulated quota error' });
    await waitFor(() => relay.snapshot().members.find((m) => m.memberId === bId)?.receiverState === 'error', 'model failure pauses inbox');
    await assert.rejects(a.call('tool', { action: 'send', to: bId, message: 'Must not pile up' }), /Recipient paused/);
    await b.call('prompt');
    await waitFor(() => relay.snapshot().members.find((m) => m.memberId === bId)?.receiverState === 'ready', 'user recovery resumes inbox');
    console.log('PASS: model failure blocks new mail until explicit recovery');

    await b.call('hold');
    await waitFor(async () => (await b.call('state')).streaming, 'busy for expiry');
    const expiring = await a.call('tool', { action: 'send', to: bId, message: 'Must expire without injection' });
    await waitFor(() => relay.snapshot().activity.find((m) => m.id === expiring.messageId)?.status === 'accepted', 'expiry candidate accepted');
    clockOffset += 10 * 60_000;
    await waitFor(() => relay.snapshot().activity.find((m) => m.id === expiring.messageId)?.status === 'expired', 'broker expires without receiver ACK');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await b.call('release');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.ok(!(await b.call('state')).messages.some((m) => m.details.messageId === expiring.messageId));
    console.log('PASS: expired local waiting copy never enters PI after recovery');

    await b.call('reload');
    assert.equal((await b.call('state')).sessionName, 'project-b');
    const next = await a.call('tool', { action: 'list' });
    assert.notEqual(next.peers[0].id, bId);
    const reloaded = await b.call('identity');
    assert.match(reloaded.section, new RegExp(next.peers[0].id));
    assert.doesNotMatch(reloaded.section, new RegExp(bId));
    await assert.rejects(a.call('tool', { action: 'send', to: bId, message: 'stale' }), /Target unavailable/);
    await a.call('tool', { action: 'send', to: next.peers[0].id, message: 'new session' });
    await waitFor(async () => (await b.call('state')).messages.length === 1, 'delivery after reload');
    console.log('PASS: reload recreates identity without reusing old mail or inheriting credentials via environment');

    relay.forget('project-b');
    assert.deepEqual((await a.call('tool', { action: 'list' })).peers, []);
    await assert.rejects(b.call('tool', { action: 'list' }), /Unauthorized/);
    console.log('PASS: terminal removal revokes a still-running child immediately');
  } finally {
    await Promise.all(workers.map(async (w) => {
      if (w.child.connected) await w.call('close').catch(() => {});
      if (w.child.exitCode === null) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => { w.child.kill('SIGKILL'); resolve(); }, 3000);
          w.child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
    }));
    await relay.stop();
    rmSync(home, { recursive: true, force: true });
  }
}
