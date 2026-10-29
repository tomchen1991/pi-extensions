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
const waitSource = `setInterval(() => {}, 1000); console.log('READY');`;
it.each([['SIGINT', 130], ['SIGTERM', 143]] as const)('forwards %s and exits %i', async (signal, code) => {
  const run = await launcher(waitSource);
  await expect.poll(run.out).toContain('READY');
  run.child.kill(signal);
  expect((await run.exit)[0]).toBe(code);
  const next = await joinBroker({ group: 'team', name: 'test', project: 'app' }, run.socketPath);
  next.socket.destroy();
});
it('spawn failure cleans up the control connection and exits without hanging', async () => {
  const run = await launcher();
  expect((await run.exit)[0]).toBe(1);
  expect(run.err()).toContain('ENOENT');
  const next = await joinBroker({ group: 'team', name: 'test', project: 'app' }, run.socketPath);
  next.socket.destroy();
});
it('broker disconnect warns without killing the active Pi', async () => {
  const run = await launcher(waitSource);
  await expect.poll(run.out).toContain('READY');
  await run.broker.close();
  await expect.poll(run.err).toContain('连接已断开');
  expect(run.child.exitCode).toBeNull();
  run.child.kill('SIGTERM');
  expect((await run.exit)[0]).toBe(143);
});
