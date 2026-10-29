import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { mkdtemp, chmod, rm, symlink } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
// @ts-ignore JS module
import { joinBroker } from '../broker.mjs';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const valid = { PI_COLLAB_ENDPOINT: 'http://127.0.0.1:12345/collaboration', PI_COLLAB_TOKEN: 'a'.repeat(64) };
async function mockBroker(env = valid) {
  const dir = await mkdtemp('/tmp/pic-client-');
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'b.sock');
  const sockets = new Set<any>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', () => socket.write(JSON.stringify({ ok: true, env }) + '\n'));
  });
  server.listen(path);
  await once(server, 'listening');
  cleanup.push(async () => { for (const s of sockets) s.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { dir, path };
}
const identity = { group: 'g', name: 'n', project: 'p' };
it('only returns whitelisted credentials, not arbitrary broker environment', async () => {
  const { path } = await mockBroker({ ...valid, NODE_OPTIONS: '--require malicious' } as any);
  const result = await joinBroker(identity, path);
  expect(result.env).toEqual(valid);
  result.socket.destroy();
});
it.each([
  { ...valid, PI_COLLAB_TOKEN: 'bad' },
  { ...valid, PI_COLLAB_ENDPOINT: 'http://example.com:123/collaboration' },
  { ...valid, PI_COLLAB_ENDPOINT: 'http://user@127.0.0.1:123/collaboration' },
  { ...valid, PI_COLLAB_ENDPOINT: 'http://127.0.0.1:123/collaboration?x=1' },
  { ...valid, PI_COLLAB_ENDPOINT: 'http://127.0.0.1:123/other' },
])('rejects invalid credentials %#', async env => {
  const { path } = await mockBroker(env);
  await expect(joinBroker(identity, path)).rejects.toThrow();
});
it('client refuses public directories and symlink sockets', async () => {
  const { dir, path } = await mockBroker();
  await chmod(dir, 0o755);
  await expect(joinBroker(identity, path)).rejects.toThrow('0700');
  await chmod(dir, 0o700);
  const alias = join(dir, 'alias.sock');
  await symlink(path, alias);
  await expect(joinBroker(identity, alias)).rejects.toThrow('Untrusted');
});
