import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, chmod, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore JavaScript transport module
import { startBroker, joinBroker } from '../broker.mjs';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'pic-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'b.sock');
  const broker = await startBroker(path);
  cleanup.push(() => broker.close());
  return { path, dir };
}
async function call(env: any, body: any) {
  const result = await fetch(env.PI_COLLAB_ENDPOINT, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.PI_COLLAB_TOKEN}` },
    body: JSON.stringify(body),
  });
  return { code: result.status, ...await result.json() };
}
it('provisions separate credentials, scopes groups, and revokes on control disconnect', async () => {
  const { path } = await setup();
  const a = await joinBroker({ group: 'team', name: 'a', project: 'app' }, path);
  const b = await joinBroker({ group: 'team', name: 'b', project: 'app' }, path);
  expect(a.env.PI_COLLAB_TOKEN).not.toBe(b.env.PI_COLLAB_TOKEN);
  await call(a.env, { action: 'register', runtimeId: 'a', generation: 1 });
  const identity = await call(b.env, { action: 'register', runtimeId: 'b', generation: 1 });
  expect((await call(a.env, { action: 'list', runtimeId: 'a' })).peers[0].id).toBe(identity.memberId);
  await expect(joinBroker({ group: 'team', name: 'a', project: 'app' }, path)).rejects.toThrow('同名');
  b.socket.destroy();
  await expect.poll(async () => (await call(b.env, { action: 'poll', runtimeId: 'b' })).code).toBe(401);
  a.socket.destroy();
});
it('does not replace a running broker socket', async () => {
  const { path } = await setup();
  await expect(startBroker(path)).rejects.toThrow();
  const a = await joinBroker({ group: 'team', name: 'a', project: 'app' }, path);
  expect(a.env.PI_COLLAB_TOKEN).toBeTruthy();
  a.socket.destroy();
});
it('launcher forwards Pi args and credentials, preserves exit status and releases its name', async () => {
  const home = await mkdtemp('/tmp/pic-cli-');
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const path = join(home, '.pi', 'collaboration', 'broker.sock');
  const broker = await startBroker(path);
  cleanup.push(() => broker.close());
  await mkdir(join(home, 'bin'));
  await writeFile(join(home, 'bin', 'pi'), `#!/usr/bin/env node\nconst assert = require('node:assert/strict');\nassert.ok(process.env.PI_COLLAB_TOKEN);\nassert.match(process.env.PI_COLLAB_ENDPOINT, /^http:\\/\\/127\\.0\\.0\\.1:/);\nassert.equal(process.argv[2], '-e');\nassert.equal(process.argv.at(-1), '--version');\nprocess.exit(7);\n`, { mode: 0o700 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'join', 'team', 'cli', '--', '--version'], {
    env: { PATH: `${join(home, 'bin')}:${process.env.PATH}`, HOME: home }, stdio: 'pipe',
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  expect(stderr).toBe('');
  expect(code).toBe(7);
  const next = await joinBroker({ group: 'team', name: 'cli', project: 'app' }, path);
  next.socket.destroy();
});
it('rejects non-private control directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pic-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await chmod(dir, 0o755);
  await expect(startBroker(join(dir, 'b.sock'))).rejects.toThrow('0700');
});
