import { createServer, createConnection } from 'node:net';
import { mkdir, lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PiCollaborationService } from './dist/service.js';

export function defaultSocket() {
  return join(homedir(), '.pi', 'collaboration', 'broker.sock');
}

async function privateDirectory(path, create = true) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid()) {
    throw new Error(`Broker directory must be owned by you and mode 0700: ${path}`);
  }
}

// The control socket is a same-OS-user trust boundary, not an agent sandbox.
// Each live connection owns exactly one launch; disconnect revokes its bearer.
export async function startBroker(socketPath = defaultSocket()) {
  if (process.platform === 'win32') throw new Error('Standalone broker currently supports macOS/Linux only');
  await privateDirectory(dirname(socketPath));
  const relay = new PiCollaborationService(() => {});
  await relay.start();
  const connections = new Set();
  const server = createServer((socket) => {
    connections.add(socket);
    const launchId = randomUUID();
    let data = '';
    let joined = false;
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => { if (!joined) socket.destroy(); });
    socket.on('error', () => {});
    socket.on('close', () => { connections.delete(socket); relay.forget(launchId); });
    socket.on('data', (chunk) => {
      if (joined) { socket.destroy(); return; }
      data += chunk;
      if (Buffer.byteLength(data) > 4096) { socket.destroy(); return; }
      if (!data.includes('\n')) return;
      try {
        const request = JSON.parse(data.trim());
        if (request.action !== 'join' || typeof request.project !== 'string' || request.project.length > 200 || /[\x00-\x1f\x7f]/.test(request.project)) {
          throw new Error('Invalid join request');
        }
        const env = relay.prepare(launchId, 0, request.project, request.group, request.name);
        joined = true;
        socket.setTimeout(0);
        socket.write(JSON.stringify({ ok: true, env: {
          PI_COLLAB_ENDPOINT: env.DECKZ_PI_COLLAB_ENDPOINT,
          PI_COLLAB_TOKEN: env.DECKZ_PI_COLLAB_TOKEN,
        } }) + '\n');
      } catch (error) {
        socket.end(JSON.stringify({ ok: false, error: error.message }) + '\n');
      }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) { await relay.stop(); throw error; }
  let closing;
  return {
    socketPath,
    close() {
      return closing ??= (async () => {
        for (const socket of connections) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
        await relay.stop();
      })();
    },
  };
}

export async function joinBroker({ group, name, project }, socketPath = defaultSocket()) {
  if (process.platform === 'win32') throw new Error('Standalone broker currently supports macOS/Linux only');
  await privateDirectory(dirname(socketPath), false);
  const info = await lstat(socketPath);
  if (!info.isSocket() || info.uid !== process.getuid()) throw new Error('Untrusted broker socket');
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = '';
    const timer = setTimeout(() => socket.destroy(new Error('Broker join timed out')), 5000);
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.once('close', () => { clearTimeout(timer); reject(new Error('Broker disconnected')); });
    socket.once('connect', () => socket.write(JSON.stringify({ action: 'join', group, name, project }) + '\n'));
    function receive(chunk) {
      data += chunk;
      if (Buffer.byteLength(data) > 4096) { socket.destroy(new Error('Invalid broker response')); return; }
      if (!data.includes('\n')) return;
      clearTimeout(timer);
      socket.off('data', receive);
      try {
        const result = JSON.parse(data.trim());
        if (!result.ok) throw new Error(result.error);
        const endpoint = result.env?.PI_COLLAB_ENDPOINT;
        const token = result.env?.PI_COLLAB_TOKEN;
        if (typeof endpoint !== 'string' || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
          throw new Error('Invalid broker credentials');
        }
        const url = new URL(endpoint);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
            url.pathname !== '/collaboration' || url.username || url.password || url.search || url.hash) {
          throw new Error('Invalid broker endpoint');
        }
        // Never pass broker-supplied arbitrary environment (e.g. NODE_OPTIONS) to Pi.
        resolve({ socket, env: { PI_COLLAB_ENDPOINT: endpoint, PI_COLLAB_TOKEN: token } });
      } catch (error) { socket.destroy(); reject(error); }
    }
    socket.on('data', receive);
  });
}
