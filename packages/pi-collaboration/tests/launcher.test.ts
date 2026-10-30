import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore JS module
import { startBroker, joinBroker } from '../broker.mjs';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function launcher(source?: string) {
  const home = await mkdtemp('/tmp/pic-sig-');
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const socketPath = join(home, '.pi', 'collaboration', 'broker.sock');
  const broker = await startBroker(socketPath);
  cleanups.push(() => broker.close());
  const bin = join(home, 'bin');
  await mkdir(bin);
  if (source) await writeFile(join(bin, 'pi'), '#!' + process.execPath + '\n' + source, { mode: 0o700 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'join', 'team', 'test'], {
    env: { HOME: home, PATH: bin }, stdio: 'pipe',
  });
  const exit = once(child, 'exit');
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exit; } });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  return { child, exit, broker, socketPath, out: () => out, err: () => err };
}
const STARTUP_TIMEOUT_MS = 5000;
const PROCESS_TEST_TIMEOUT_MS = 10000;

// Node + launcher + faux Pi can approach/exceed expect.poll's default 1s on a cold/busy host.
// Wait for the actual readiness marker, but fail immediately if the launcher exits first.
function waitForReady(run: Awaited<ReturnType<typeof launcher>>, timeoutMs = STARTUP_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const diagnostics = () => `code=${run.child.exitCode}, signal=${run.child.signalCode}, ` +
      `stdout=${JSON.stringify(run.out().slice(-2000))}, stderr=${JSON.stringify(run.err().slice(-2000))}`;
    const cleanup = () => {
      clearTimeout(timer);
      run.child.stdout.off('data', check);
      run.child.off('close', closed);
      run.child.off('error', failed);
    };
    const check = () => {
      if (run.out().split(/\r?\n/).includes('READY')) { cleanup(); resolve(); }
    };
    const closed = () => { cleanup(); reject(new Error(`Launcher exited before READY: ${diagnostics()}`)); };
    const failed = (error: Error) => { cleanup(); reject(new Error(`Launcher failed before READY: ${error.message}; ${diagnostics()}`)); };
    const timer = setTimeout(() => {
      cleanup(); reject(new Error(`Timed out waiting for READY after ${timeoutMs}ms: ${diagnostics()}`));
    }, timeoutMs);
    run.child.stdout.on('data', check);
    run.child.once('close', closed);
    run.child.once('error', failed);
    if (run.child.exitCode !== null || run.child.signalCode !== null) closed();
    else check(); // READY may already have arrived before this waiter was registered.
  });
}
const waitSource = `setInterval(() => {}, 1000); console.log('READY');`;
it.each([['SIGINT', 130], ['SIGTERM', 143]] as const)('forwards %s and exits %i', async (signal, code) => {
  const run = await launcher(waitSource);
  await waitForReady(run);
  run.child.kill(signal);
  expect((await run.exit)[0]).toBe(code);
  const next = await joinBroker({ group: 'team', name: 'test', project: 'app' }, run.socketPath);
  next.socket.destroy();
}, PROCESS_TEST_TIMEOUT_MS);
it('spawn failure cleans up the control connection and exits without hanging', async () => {
  const run = await launcher();
  expect((await run.exit)[0]).toBe(1);
  expect(run.err()).toContain('ENOENT');
  const next = await joinBroker({ group: 'team', name: 'test', project: 'app' }, run.socketPath);
  next.socket.destroy();
});
it('broker disconnect warns without killing the active Pi', async () => {
  const run = await launcher(waitSource);
  await waitForReady(run);
  await run.broker.close();
  await expect.poll(run.err).toContain('连接已断开');
  expect(run.child.exitCode).toBeNull();
  run.child.kill('SIGTERM');
  expect((await run.exit)[0]).toBe(143);
}, PROCESS_TEST_TIMEOUT_MS);

it('allows a real child to become ready after the old one-second polling limit', async () => {
  const run = await launcher(`setInterval(() => {}, 1000); setTimeout(() => console.log('READY'), 1200);`);
  await waitForReady(run);
  run.child.kill('SIGTERM');
  expect((await run.exit)[0]).toBe(143);
}, PROCESS_TEST_TIMEOUT_MS);

it('reports an early exit with stdout and stderr rather than waiting for the startup deadline', async () => {
  const run = await launcher(`console.log('starting'); console.error('synthetic startup failure'); process.exitCode = 23;`);
  const error = await waitForReady(run).catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain('Launcher exited before READY');
  expect(error.message).toContain('code=23');
  expect(error.message).toContain('starting');
  expect(error.message).toContain('synthetic startup failure');
  expect((await run.exit)[0]).toBe(23);
}, PROCESS_TEST_TIMEOUT_MS);

it('still times out with diagnostics when a running child never reports READY', async () => {
  const run = await launcher(`setInterval(() => {}, 1000); console.log('BOOTED');`);
  await expect.poll(run.out, { timeout: STARTUP_TIMEOUT_MS }).toContain('BOOTED');
  await expect(waitForReady(run, 50)).rejects.toThrow(/Timed out waiting for READY after 50ms:.*BOOTED/);
  run.child.kill('SIGTERM');
  expect((await run.exit)[0]).toBe(143);
}, PROCESS_TEST_TIMEOUT_MS);
