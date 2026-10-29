import { createHash, randomUUID, randomBytes } from 'crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import {
  COLLABORATION_LIMITS as limits,
  normalizeCollaborationGroup,
  normalizeCollaborationName,
  type PiCollaborationActivity,
  type PiCollaborationMember,
  type PiCollaborationSnapshot,
} from './protocol.js';

interface Mail {
  id: string;
  expiresAt: number;
  from: string;
  fromName: string;
  fromProject: string;
  to: string;
  message: string;
  replyTo?: string;
}
interface Launch {
  token: string;
  view: PiCollaborationMember;
  generation: number;
  runtimeId?: string;
  lastSeen: number;
  pending: Mail[];
  /** At most sendsPerLaunch entries; a retry cannot deliver the same tool call twice. */
  sends: Map<string, { request: string; id: string }>;
  recentSends: number[];
  /** 长任务工人 20、QA 50；缺省用 limits.sendsPerLaunch。 */
  sendBudget?: number;
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const fail = (message: string, status = 400): never => { throw new RequestError(status, message); };
const text = (value: unknown, name: string, max = 200): string => {
  if (typeof value !== 'string' || !value || value.length > max) return fail(`Invalid ${name}`);
  return value;
};

/** Local, ephemeral, opt-in relay. Not a sandbox against other processes of the same OS user. */
export class PiCollaborationService {
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private launches = new Map<string, Launch>();
  private activity: PiCollaborationActivity[] = [];
  private signature = '';
  private endpoint = '';

  constructor(
    private readonly emit: (snapshot: PiCollaborationSnapshot) => void,
    private readonly now = Date.now,
    /** 成员的发送预算（不是每分钟限流）耗尽时回调。relay 自己不给重置口，由 DeckZ 决定续不续。 */
    private readonly onBudgetBlocked?: (terminalId: string, memberName: string) => void,
  ) {}

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.server) return;
    this.starting = new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => { void this.handle(req, res); });
      this.server = server;
      server.requestTimeout = 5_000;
      server.headersTimeout = 5_000;
      server.on('error', () => {}); // startup failure is surfaced below
      server.once('error', (error) => { this.server = null; reject(error); });
      server.listen(0, '127.0.0.1', () => {
        this.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/collaboration`;
        this.timer = setInterval(() => this.publish(), 2_000);
        this.timer.unref();
        resolve();
      });
    });
    try { await this.starting; } finally { this.starting = null; }
  }

  /** Called only after explicit UI consent. Credentials go to a new PTY, not to IPC. */
  prepare(
    terminalId: string,
    projectId: number,
    projectName: string,
    groupName: string,
    sessionName: string,
    opts?: { sendBudget?: number },
  ): Record<string, string> {
    if (!this.endpoint) throw new Error('PI 通信服务未启动');
    if (this.launches.size >= limits.launches) throw new Error('协作会话数量已达上限，请关闭不用的终端');
    if (this.launches.has(terminalId)) throw new Error('Duplicate collaboration terminal');
    const group = normalizeCollaborationGroup(groupName);
    const name = normalizeCollaborationName(sessionName);
    if ([...this.launches.values()].some((l) => l.view.group === group && l.view.name === name)) {
      throw new Error(`协作组内已有同名会话「${name}」`);
    }
    const sendBudget = opts?.sendBudget;
    if (sendBudget !== undefined && (!Number.isSafeInteger(sendBudget) || sendBudget < 1 || sendBudget > limits.sendsPerLaunch)) {
      throw new Error(`发送预算必须是 1–${limits.sendsPerLaunch} 的整数`);
    }
    const token = randomBytes(32).toString('hex');
    this.launches.set(terminalId, {
      token, view: { terminalId, projectId, projectName, name, group, status: 'starting', sent: 0, received: 0 },
      generation: 0, lastSeen: this.now(), pending: [], sends: new Map(), recentSends: [],
      ...(sendBudget !== undefined ? { sendBudget } : {}),
    });
    this.publish();
    return { DECKZ_PI_COLLAB_ENDPOINT: this.endpoint, DECKZ_PI_COLLAB_TOKEN: token };
  }

  isCollaborationTerminal(terminalId: string): boolean {
    return this.launches.has(terminalId);
  }

  forget(terminalId: string): void {
    const launch = this.launches.get(terminalId);
    if (!launch) return;
    this.cancelPending(launch);
    this.launches.delete(terminalId); // invalidates the bearer even if a descendant survives PTY close
    this.publish();
  }

  /** Close every member, including offline PTYs; leave failed closes visible for retry. */
  async dissolveGroup(groupName: string, close: (terminalId: string) => Promise<void>): Promise<void> {
    const group = normalizeCollaborationGroup(groupName);
    const members = this.snapshot().members.filter((member) => member.group === group);
    const results = await Promise.allSettled(members.map(async (member) => {
      await close(member.terminalId);
      this.forget(member.terminalId);
    }));
    if (results.some((result) => result.status === 'rejected')) throw new Error('部分协作终端关闭失败，请重试解散');
    this.activity = this.activity.filter((entry) => entry.group !== group);
    this.publish();
  }

  /**
   * Human-initiated budget refill from the collaboration modal. Deliberately
   * only reachable through the DeckZ UI: if the relay protocol itself offered
   * a reset, a runaway Pi would learn to top up its own budget and the
   * circuit breaker would be decoration.
   */
  resetSendBudget(terminalId: string): void {
    const launch = this.launches.get(terminalId);
    if (!launch || launch.view.status === 'closed') throw new Error('协作会话不存在或已退出');
    launch.view.sent = 0;
    launch.recentSends = [];
    this.publish();
  }

  private isOnline(launch: Launch): boolean {
    return launch.view.status === 'online' && this.now() - launch.lastSeen <= limits.leaseMs;
  }

  private expirePending(): void {
    for (const launch of this.launches.values()) {
      launch.pending = launch.pending.filter((mail) => {
        if (mail.expiresAt > this.now()) return true;
        this.setDelivery(mail.id, 'expired', 'timeout');
        return false;
      });
    }
  }

  private receiverState(launch: Launch): PiCollaborationMember['receiverState'] {
    if (launch.view.receiverState === 'error') return 'error';
    if (launch.pending.some((mail) => this.now() >= mail.expiresAt - limits.messageTtlMs + limits.stalledMs)) return 'stalled';
    return launch.view.receiverState ?? 'ready';
  }

  snapshot(): PiCollaborationSnapshot {
    this.expirePending();
    return {
      members: [...this.launches.values()].map((l) => ({
        ...l.view,
        pendingCount: l.pending.length,
        receiverState: this.receiverState(l),
        status: l.view.status === 'online' && !this.isOnline(l) ? 'offline'
          : l.view.status === 'starting' && this.now() - l.lastSeen > 120_000 ? 'offline' : l.view.status,
      })),
      activity: this.activity.slice(-200).map((a) => ({ ...a })),
    };
  }

  private publish(): void {
    const snapshot = this.snapshot();
    const signature = JSON.stringify(snapshot);
    if (this.signature === signature) return;
    this.signature = signature;
    try { this.emit(snapshot); } catch { /* A closing renderer must not break delivery. */ }
  }

  private cancelPending(launch: Launch): void {
    // A receiver may have appended the message but lost its ACK. Do not claim recall.
    for (const mail of launch.pending) this.setDelivery(mail.id, 'expired', 'session-ended');
    launch.pending = [];
  }

  private setDelivery(id: string, status: PiCollaborationActivity['status'], reason?: PiCollaborationActivity['reason']): void {
    const entry = this.activity.find((a) => a.id === id);
    if (entry) { entry.status = status; entry.reason = reason; }
  }

  private dispatch(launch: Launch, body: Record<string, unknown>): unknown {
    this.expirePending();
    const action = body.action;
    if (action === 'register') {
      const runtimeId = text(body.runtimeId, 'runtimeId');
      const generation = body.generation;
      if (!Number.isSafeInteger(generation) || (generation as number) < 1) return fail('Invalid generation');
      const identity = () => ({ memberId: launch.view.memberId, group: launch.view.group, name: launch.view.name, project: launch.view.projectName });
      if (generation === launch.generation && runtimeId === launch.runtimeId && launch.view.status !== 'closed') {
        launch.lastSeen = this.now();
        return identity();
      }
      if ((generation as number) <= launch.generation) return fail('Session replaced; reload the extension', 409);
      this.cancelPending(launch);
      launch.generation = generation as number;
      launch.runtimeId = runtimeId;
      launch.view.memberId = randomUUID(); // /new and /resume cannot inherit old addressed mail
      launch.view.status = 'online';
      launch.view.receiverState = 'ready';
      launch.lastSeen = this.now();
      return identity();
    }
    if (!launch.runtimeId || body.runtimeId !== launch.runtimeId || launch.view.status === 'closed') {
      return fail('Session is no longer registered', 409);
    }
    launch.lastSeen = this.now();
    if (action === 'leave') {
      this.cancelPending(launch);
      launch.view.status = 'closed';
      return {};
    }
    if (action === 'poll') {
      const acks = body.acks ?? [];
      if (!Array.isArray(acks) || acks.length > limits.pending || acks.some((id) => typeof id !== 'string')) return fail('Invalid acknowledgements');
      const accepted = body.accepted ?? [];
      const capacity = body.capacity ?? limits.pollBatch;
      const state = body.receiverState;
      if (!Array.isArray(accepted) || accepted.length > limits.pending || accepted.some((id) => typeof id !== 'string')) return fail('Invalid accepted IDs');
      if (!Number.isSafeInteger(capacity) || (capacity as number) < 0 || (capacity as number) > limits.pollBatch) return fail('Invalid capacity');
      if (state !== undefined && state !== 'ready' && state !== 'busy' && state !== 'error') return fail('Invalid receiver state');
      if (state !== undefined) launch.view.receiverState = state;
      for (const mail of launch.pending) {
        if (accepted.includes(mail.id)) this.setDelivery(mail.id, 'accepted');
      }
      for (const id of acks) {
        const mail = launch.pending.find((m) => m.id === id);
        if (!mail) continue;
        this.setDelivery(mail.id, 'delivered');
        launch.view.received += 1;
      }
      launch.pending = launch.pending.filter((m) => !acks.includes(m.id));
      return {
        messages: launch.view.receiverState === 'error' ? [] : launch.pending.filter((mail) => !accepted.includes(mail.id)).slice(0, capacity as number),
        pendingIds: launch.pending.map((mail) => mail.id),
        remainingSends: (launch.sendBudget ?? limits.sendsPerLaunch) - launch.view.sent,
      };
    }
    if (action === 'list') {
      return { self: launch.view.memberId, peers: [...this.launches.values()]
        .filter((l) => l !== launch && l.view.group === launch.view.group && this.isOnline(l))
        .map((l) => ({ id: l.view.memberId, name: l.view.name, project: l.view.projectName, projectId: l.view.projectId, receiverState: this.receiverState(l), pendingCount: l.pending.length })) };
    }
    if (action === 'status') {
      return { self: launch.view.memberId, group: launch.view.group, sent: launch.view.sent,
        receiverState: this.receiverState(launch), pendingCount: launch.pending.length,
        remainingSends: (launch.sendBudget ?? limits.sendsPerLaunch) - launch.view.sent,
        activity: this.activity.filter((a) => a.from === launch.view.memberId || a.to === launch.view.memberId).slice(-50) };
    }
    if (action !== 'send') return fail('Unknown action');
    const to = text(body.to, 'to');
    const message = text(body.message, 'message', limits.messageBytes);
    if (Buffer.byteLength(message, 'utf8') > limits.messageBytes || !message.trim()) return fail('Message must be 1–8192 UTF-8 bytes');
    const requestId = text(body.requestId, 'requestId');
    const replyTo = body.replyTo === undefined ? undefined : text(body.replyTo, 'replyTo');
    const request = createHash('sha256').update(JSON.stringify({ to, message, replyTo })).digest('hex');
    const previous = launch.sends.get(requestId);
    if (previous) {
      if (previous.request !== request) return fail('requestId already used for another message', 409);
      return { messageId: previous.id, status: this.activity.find((a) => a.id === previous.id)?.status ?? 'unknown' };
    }
    const target = [...this.launches.values()].find((l) => l.view.memberId === to && l.view.group === launch.view.group && this.isOnline(l));
    if (!target || target === launch) return fail('Target unavailable in this group; list peers again', 404);
    const receiverState = this.receiverState(target);
    if (receiverState === 'error' || receiverState === 'stalled') return fail(`Recipient paused (${receiverState}); inspect the receiving terminal. Do not retry automatically.`, 409);
    if (replyTo && !this.activity.some((a) => a.id === replyTo && a.from === to && a.to === launch.view.memberId)) return fail('Reply must reference a message from this peer');
    launch.recentSends = launch.recentSends.filter((t) => this.now() - t < 60_000);
    const sendBudget = launch.sendBudget ?? limits.sendsPerLaunch;
    if (launch.view.sent >= sendBudget) {
      try { this.onBudgetBlocked?.(launch.view.terminalId, launch.view.name); } catch { /* 回调不能影响发送 */ }
      return fail(`Message budget reached (${sendBudget} per launch). Wait for the orchestrator to refill; do not retry automatically.`, 429);
    }
    if (launch.recentSends.length >= limits.sendsPerMinute) {
      return fail(`Rate limit reached (${limits.sendsPerMinute} per minute). Do not retry automatically.`, 429);
    }
    if (target.pending.length >= limits.pending) return fail('Recipient inbox full. Do not retry automatically.', 429);
    const mail: Mail = {
      id: randomUUID(), expiresAt: this.now() + limits.messageTtlMs, from: launch.view.memberId!, fromName: launch.view.name, fromProject: launch.view.projectName,
      to, message, ...(replyTo ? { replyTo } : {}),
    };
    target.pending.push(mail);
    launch.sends.set(requestId, { id: mail.id, request });
    launch.recentSends.push(this.now());
    launch.view.sent += 1;
    this.activity.push({ id: mail.id, from: mail.from, to, group: launch.view.group, status: 'queued', timestamp: this.now() });
    // Bounded by 64 launches x 50 sends. Keep pending and reply references for this app run.
    if (this.activity.length > limits.launches * limits.sendsPerLaunch) this.activity.shift();
    return { messageId: mail.id, status: 'queued' };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method !== 'POST' || req.url !== '/collaboration' || req.headers.origin ||
          req.headers.host !== new URL(this.endpoint).host || req.headers['content-type'] !== 'application/json') {
        return fail('Not allowed', 403);
      }
      const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
      const launch = [...this.launches.values()].find((l) => l.token === token);
      if (!launch) return fail('Unauthorized', 401);
      if (Number(req.headers['content-length']) > limits.bodyBytes) return fail('Request too large', 413);
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > limits.bodyBytes) return fail('Request too large', 413);
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail('Invalid JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('Invalid request');
      const result = this.dispatch(launch, body as Record<string, unknown>);
      this.publish();
      res.end(JSON.stringify({ ok: true, ...result as object }));
    } catch (error) {
      if (res.destroyed) return;
      res.statusCode = error instanceof RequestError ? error.status : 500;
      res.end(JSON.stringify({ ok: false, error: error instanceof RequestError ? error.message : 'Relay error' }));
    }
  }

  async stop(): Promise<void> {
    if (this.starting) await this.starting.catch(() => {});
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.launches.clear();
    this.activity = [];
    this.endpoint = '';
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}
