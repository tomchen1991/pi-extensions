#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBroker, joinBroker } from './broker.mjs';

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'broker' && args.length === 0) {
    const broker = await startBroker();
    console.log(`PI协作 broker: ${broker.socketPath}\nCtrl-C 停止；会话与消息仅存于内存。`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void broker.close(); });
  } else if (command === 'join' && args.length >= 2) {
    const [group, name, ...rest] = args;
    if (rest.length && rest[0] !== '--') throw new Error('Pi arguments must follow --');
    if (process.env.DECKZ_PI_COLLAB_TOKEN || process.env.PI_COLLAB_TOKEN) throw new Error('Cannot nest collaboration launches');
    const { socket, env } = await joinBroker({ group, name, project: basename(process.cwd()) });
    const child = spawn('pi', ['-e', fileURLToPath(new URL('./extension.mjs', import.meta.url)), ...rest.slice(1)], {
      stdio: 'inherit', env: { ...process.env,
        PI_COLLAB_ENDPOINT: env.PI_COLLAB_ENDPOINT, PI_COLLAB_TOKEN: env.PI_COLLAB_TOKEN },
    });
    // Do not retain bearer credentials in the launcher's data object.
    delete env.PI_COLLAB_TOKEN;
    socket.on('close', () => {
      console.error('PI协作 broker 连接已断开；协作凭证已失效。');
    });
    const signals = new Map(['SIGINT', 'SIGTERM'].map((signal) => [signal, () => { child.kill(signal); }]));
    for (const [signal, handler] of signals) process.on(signal, handler);
    function cleanup() {
      for (const [name, handler] of signals) process.off(name, handler);
      socket.removeAllListeners('close');
      socket.destroy();
    }
    child.once('error', (error) => { console.error(error.message); cleanup(); process.exitCode = 1; });
    child.once('exit', (code, signal) => {
      cleanup();
      process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
    });
  } else {
    console.log('PI协作\n  pi-collab broker\n  pi-collab join <组名> <会话名> -- [pi 参数]\n\n先运行 broker，再在各项目终端显式 join。macOS/Linux，Node >=22，Pi >=1.1。');
    if (command && !['help', '--help', '-h'].includes(command)) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
