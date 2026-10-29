// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PiCollaborationService } from './service';
import { COLLABORATION_LIMITS, normalizeCollaborationGroup } from './protocol';

let now: number;
let relay: PiCollaborationService;
const emit = vi.fn();
let serial = 0;
interface Peer { env: Record<string, string>; runtimeId: string; memberId: string; terminalId: string }
async function call(peer: Pick<Peer, 'env' | 'runtimeId'>, body: object, headers: Record<string, string> = {}) {
  const response = await fetch(peer.env.DECKZ_PI_COLLAB_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${peer.env.DECKZ_PI_COLLAB_TOKEN}`, ...headers },
    body: JSON.stringify({ runtimeId: peer.runtimeId, ...body }),
  });
  return { status: response.status, ...await response.json() };
}
async function peer(group = 'team', project = 'Project', requestedName?: string): Promise<Peer> {
  const terminalId = `terminal-${++serial}`;
  const sessionName = requestedName ?? `session-${serial}`;
  const env = relay.prepare(terminalId, serial, project, group, sessionName);
  const base = { env, terminalId, runtimeId: `runtime-${serial}` };
  const registered = await call(base, { action: 'register', generation: 1 });
  expect(registered).toMatchObject({ name: sessionName, project, group });
  return { ...base, memberId: registered.memberId };
}

beforeEach(async () => {
  now = 100_000;
  emit.mockClear();
  relay = new PiCollaborationService(emit, () => now);
  await Promise.all([relay.start(), relay.start()]);
});
afterEach(async () => { await relay.stop(); });

describe('PI collaboration relay', () => {
  it('dissolves all members in one group, revokes credentials and preserves other groups', async () => {
    const a = await peer('team');
    const b = await peer('team');
    const other = await peer('other');
    await call(a, { action: 'send', to: b.memberId, requestId: 'pending', message: 'hello' });
    now += COLLABORATION_LIMITS.leaseMs + 1; // offline members must also be closed
    const close = vi.fn(async () => {});
    await relay.dissolveGroup(' team ', close);
    expect(close.mock.calls.flat()).toEqual([a.terminalId, b.terminalId]);
    expect(relay.snapshot().members.map((m) => m.terminalId)).toEqual([other.terminalId]);
    expect(relay.snapshot().activity).toEqual([]);
    expect((await call(a, { action: 'poll' })).status).toBe(401);
    expect((await call(b, { action: 'register', generation: 2 })).status).toBe(401);
    expect((await call(other, { action: 'poll' })).status).toBe(200);
  });

  it('attempts every close and keeps failed members available for retry', async () => {
    const a = await peer('team');
    const b = await peer('team');
    const close = vi.fn(async (id: string) => { if (id === a.terminalId) throw new Error('close failed'); });
    await expect(relay.dissolveGroup('team', close)).rejects.toThrow('关闭失败');
    expect(close).toHaveBeenCalledTimes(2);
    expect(relay.isCollaborationTerminal(a.terminalId)).toBe(true);
    expect(relay.isCollaborationTerminal(b.terminalId)).toBe(false);
    await relay.dissolveGroup('team', async () => {});
    expect(relay.snapshot().members).toEqual([]);
  });

  it('requires a valid group and never exposes launch credentials in IPC snapshots', async () => {
    expect(() => normalizeCollaborationGroup(' \n ')).toThrow();
    expect(() => normalizeCollaborationGroup('a\nb')).toThrow();
    expect(() => normalizeCollaborationGroup('a'.repeat(41))).toThrow();
    expect(normalizeCollaborationGroup(' e\u0301 ')).toBe('é');
    const a = await peer();
    expect(JSON.stringify(relay.snapshot())).not.toContain(a.env.DECKZ_PI_COLLAB_TOKEN);
    expect(JSON.stringify(emit.mock.calls)).not.toContain(a.env.DECKZ_PI_COLLAB_TOKEN);
  });

  it('refills the send budget only through the UI-facing reset', async () => {
    const a = await peer();
    const b = await peer();
    const sent = await call(a, { action: 'send', to: b.memberId, requestId: 'r1', message: 'hi' });
    expect(sent.status).toBe('queued');
    expect(relay.snapshot().members.find((m) => m.terminalId === a.terminalId)?.sent).toBe(1);
    relay.resetSendBudget(a.terminalId);
    expect(relay.snapshot().members.find((m) => m.terminalId === a.terminalId)?.sent).toBe(0);
    expect(() => relay.resetSendBudget('missing-terminal')).toThrow();
  });

  it('honors a per-member send budget below the default', async () => {
    const terminalId = `terminal-${++serial}`;
    const env = relay.prepare(terminalId, serial, 'Project', 'team', 'worker-1', { sendBudget: 2 });
    const worker = { env, terminalId, runtimeId: `runtime-${serial}` };
    await call(worker, { action: 'register', generation: 1 });
    const b = await peer('team');
    expect((await call(worker, { action: 'send', to: b.memberId, requestId: '1', message: 'x' })).status).toBe('queued');
    expect((await call(worker, { action: 'send', to: b.memberId, requestId: '2', message: 'x' })).status).toBe('queued');
    const third = await call(worker, { action: 'send', to: b.memberId, requestId: '3', message: 'x' });
    expect(third.status).toBe(429);
    expect(String(third.error)).toContain('2 per launch');
    expect(() => relay.prepare('t-x', 999, 'Project', 'team', 'worker-x', { sendBudget: 0 })).toThrow(/发送预算/);
  });

  it('fires onBudgetBlocked only when the per-launch budget is exhausted, not on per-minute rate limit', async () => {
    const onBudgetBlocked = vi.fn();
    await relay.stop();
    relay = new PiCollaborationService(emit, () => now, onBudgetBlocked);
    await relay.start();
    const terminalId = `terminal-${++serial}`;
    const env = relay.prepare(terminalId, serial, 'Project', 'team', 'worker-b', { sendBudget: 1 });
    const worker = { env, terminalId, runtimeId: `runtime-${serial}` };
    await call(worker, { action: 'register', generation: 1 });
    const b = await peer('team');
    await call(worker, { action: 'send', to: b.memberId, requestId: '1', message: 'x' });
    await call(worker, { action: 'send', to: b.memberId, requestId: '2', message: 'x' });
    expect(onBudgetBlocked).toHaveBeenCalledWith(terminalId, 'worker-b');
    onBudgetBlocked.mockClear();
    // 每分钟限流不触发续额回调：另用一个默认预算（50）的成员，一分钟内发到第 11 条
    const fast = await peer('team', 'Project', 'worker-fast');
    for (let i = 0; i < 10; i++) await call(fast, { action: 'send', to: b.memberId, requestId: `r${i}`, message: 'x' });
    const limited = await call(fast, { action: 'send', to: b.memberId, requestId: 'over', message: 'x' });
    expect(limited.status).toBe(429);
    expect(String(limited.error)).toContain('per minute');
    expect(onBudgetBlocked).not.toHaveBeenCalled();
  });

  it('discovers only online peers in the same group, using exact distinct IDs for identical project names', async () => {
    const a = await peer('team', 'Project', '后端'); const b = await peer('team', 'Project', '前端');
    const foreign = await peer('other', 'Project', '后端');
    const list = await call(a, { action: 'list' });
    expect(list.peers).toEqual([expect.objectContaining({ id: b.memberId, name: '前端', project: 'Project' })]);
    expect((await call(a, { action: 'send', to: foreign.memberId, requestId: 'x', message: 'secret' })).status).toBe(404);
    expect((await call(a, { action: 'send', to: a.memberId, requestId: 'x', message: 'loop' })).status).toBe(404);
    expect((await call(a, { action: 'send', to: '前端', requestId: 'x', message: 'guess' })).status).toBe(404);
    expect((await call(a, { action: 'send', to: 'Project', requestId: 'x', message: 'guess' })).status).toBe(404);
  });

  it('rejects a duplicate display name in the same group and keeps the name off the address', async () => {
    await peer('team', 'App', '后端');
    expect(() => relay.prepare('other-terminal', 9, 'Other', 'team', ' 后端 ')).toThrow(/已有同名会话/);
    expect(() => relay.prepare('other-group', 10, 'Other', 'elsewhere', '后端')).not.toThrow();
    expect(relay.isCollaborationTerminal('other-terminal')).toBe(false);
    expect(relay.isCollaborationTerminal('other-group')).toBe(true);
  });

  it('sends, acknowledges and replies; queued is not delivered; repeated poll/ack/send are idempotent', async () => {
    const a = await peer('team', 'Sender', '发件人'); const b = await peer();
    const request = { action: 'send', to: b.memberId, requestId: 'call-1', message: 'private body' };
    const sent = await call(a, request);
    expect(sent.status).toBe('queued');
    expect(await call(a, request)).toEqual(sent);
    expect((await call(a, { ...request, message: 'different' })).status).toBe(409);
    const polled = await call(b, { action: 'poll' });
    expect(polled.messages[0]).toMatchObject({ id: sent.messageId, from: a.memberId, fromName: '发件人', fromProject: 'Sender', message: 'private body' });
    expect((await call(b, { action: 'poll' })).messages).toHaveLength(1);
    expect(relay.snapshot().activity[0].status).toBe('queued');
    await call(b, { action: 'poll', acks: [sent.messageId] });
    await call(b, { action: 'poll', acks: [sent.messageId] });
    expect(relay.snapshot().activity[0].status).toBe('delivered');
    expect(relay.snapshot().members.find((m) => m.memberId === b.memberId)?.received).toBe(1);
    expect(JSON.stringify(relay.snapshot())).not.toContain('private body');
    expect((await call(b, { action: 'send', requestId: 'reply', to: a.memberId, replyTo: sent.messageId, message: 'answer' })).ok).toBe(true);
    expect((await call(a, { action: 'send', requestId: 'bad-reply', to: b.memberId, replyTo: sent.messageId, message: 'bad' })).status).toBe(400);
  });

  it('revokes credentials on terminal close and cancels undelivered mail', async () => {
    const a = await peer(); const b = await peer();
    await call(a, { action: 'send', to: b.memberId, requestId: '1', message: 'pending' });
    relay.forget(b.terminalId);
    expect((await call(b, { action: 'poll' })).status).toBe(401);
    expect(relay.snapshot().activity[0].status).toBe('expired');
    expect((await call(a, { action: 'list' })).peers).toEqual([]);
  });

  it('replaces identities on session reload and rejects stale generations and requests', async () => {
    const a = await peer(); const b = await peer();
    await call(a, { action: 'send', to: b.memberId, requestId: '1', message: 'old task' });
    const next = { ...b, runtimeId: 'new-runtime' };
    const registration = await call(next, { action: 'register', generation: 2 });
    expect(registration.memberId).not.toBe(b.memberId);
    expect((await call(next, { action: 'poll' })).messages).toEqual([]);
    expect((await call(b, { action: 'poll' })).status).toBe(409);
    expect((await call(b, { action: 'register', generation: 1 })).status).toBe(409);
    expect((await call(a, { action: 'send', to: b.memberId, requestId: '2', message: 'stale target' })).status).toBe(404);
    await call(next, { action: 'leave' });
    expect((await call(next, { action: 'register', generation: 2 })).status).toBe(409);
  });

  it('expires liveness without delivering to offline targets, then recovers on heartbeat', async () => {
    const a = await peer(); const b = await peer();
    now += COLLABORATION_LIMITS.leaseMs + 1;
    expect(relay.snapshot().members.every((m) => m.status === 'offline')).toBe(true);
    expect((await call(a, { action: 'list' })).peers).toEqual([]);
    await call(b, { action: 'poll' });
    expect((await call(a, { action: 'list' })).peers).toHaveLength(1);
  });

  it('bounds message bytes, rate, inbox and per-launch budget', async () => {
    const a = await peer(); const b = await peer();
    expect((await call(a, { action: 'send', to: b.memberId, requestId: 'large', message: '界'.repeat(2800) })).status).toBe(400);
    for (let i = 0; i < 10; i++) expect((await call(a, { action: 'send', to: b.memberId, requestId: `${i}`, message: 'x' })).ok).toBe(true);
    expect((await call(a, { action: 'send', to: b.memberId, requestId: 'rate', message: 'x' })).status).toBe(429);
    for (let i = 10; i < 50; i++) {
      if (i % 10 === 0) now += 60_001;
      // Heartbeat keeps recipient available, and drains its inbox.
      const polled = await call(b, { action: 'poll' });
      await call(b, { action: 'poll', acks: polled.messages.map((m: { id: string }) => m.id) });
      expect((await call(a, { action: 'send', to: b.memberId, requestId: `${i}`, message: 'x' })).ok).toBe(true);
    }
    now += 60_001; await call(b, { action: 'poll' });
    expect((await call(a, { action: 'send', to: b.memberId, requestId: 'budget', message: 'x' })).status).toBe(429);
    // Reload cannot reset the launch budget.
    const next = { ...a, runtimeId: 'next' };
    await call(next, { action: 'register', generation: 2 });
    expect((await call(next, { action: 'send', to: b.memberId, requestId: 'budget2', message: 'x' })).status).toBe(429);
  });

  it('bounds the recipient inbox even across multiple senders', async () => {
    const a = await peer(); const b = await peer(); const c = await peer(); const d = await peer();
    for (const sender of [a, c]) {
      for (let i = 0; i < 10; i++) {
        expect((await call(sender, { action: 'send', to: b.memberId, requestId: `${i}`, message: 'queued' })).ok).toBe(true);
      }
    }
    expect((await call(d, { action: 'send', to: b.memberId, requestId: 'full', message: 'queued' })).status).toBe(429);
  });

  it('skips accepted mail without head-of-line blocking and confirms each ID independently', async () => {
    const a = await peer(); const b = await peer();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await call(a, { action: 'send', to: b.memberId, requestId: `${i}`, message: 'x' })).messageId);
    expect((await call(b, { action: 'poll' })).messages).toHaveLength(4);
    const next = await call(b, { action: 'poll', accepted: ids.slice(0, 4), capacity: 2 });
    expect(next.messages.map((m: { id: string }) => m.id)).toEqual(ids.slice(4));
    expect(relay.snapshot().activity[0].status).toBe('accepted');
    await call(b, { action: 'poll', acks: [ids[5]], capacity: 0 });
    expect(relay.snapshot().activity[5].status).toBe('delivered');
    expect(relay.snapshot().activity[0].status).toBe('accepted');
    expect((await call(b, { action: 'poll', capacity: 5 })).status).toBe(400);
    expect((await call(b, { action: 'poll', accepted: [1] })).status).toBe(400);
  });

  it('expires queued and accepted mail even without receiver polls; late ACK cannot claim delivery', async () => {
    const a = await peer(); const b = await peer();
    const sent = await call(a, { action: 'send', to: b.memberId, requestId: 'ttl', message: 'x' });
    await call(b, { action: 'poll', accepted: [sent.messageId] });
    now += COLLABORATION_LIMITS.messageTtlMs;
    expect(relay.snapshot().activity[0]).toMatchObject({ status: 'expired', reason: 'timeout' });
    expect(relay.snapshot().members.find((m) => m.memberId === b.memberId)?.pendingCount).toBe(0);
    expect((await call(b, { action: 'poll', acks: [sent.messageId] })).messages).toEqual([]);
    expect(relay.snapshot().activity[0].status).toBe('expired');
    expect((await call(a, { action: 'send', to: b.memberId, requestId: 'new', message: 'x' })).ok).toBe(true);
  });

  it('publishes timeout cleanup on its own timer without any further requests', async () => {
    const a = await peer(); const b = await peer();
    await call(a, { action: 'send', to: b.memberId, requestId: 'timer', message: 'x' });
    emit.mockClear();
    now += COLLABORATION_LIMITS.messageTtlMs;
    await vi.waitFor(() => {
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        activity: [expect.objectContaining({ status: 'expired', reason: 'timeout' })],
      }));
    }, { timeout: 3000, interval: 50 });
  });

  it('pauses unhealthy receivers while allowing ACKs and explicit recovery', async () => {
    const a = await peer(); const b = await peer();
    const sent = await call(a, { action: 'send', to: b.memberId, requestId: 'first', message: 'x' });
    await call(b, { action: 'poll', receiverState: 'error' });
    expect((await call(a, { action: 'send', to: b.memberId, requestId: 'blocked', message: 'x' })).error).toContain('Recipient paused (error)');
    expect((await call(b, { action: 'poll' })).messages).toEqual([]);
    await call(b, { action: 'poll', receiverState: 'ready', acks: [sent.messageId] });
    expect((await call(a, { action: 'send', to: b.memberId, requestId: 'recovered', message: 'x' })).ok).toBe(true);
    now += COLLABORATION_LIMITS.stalledMs;
    await call(b, { action: 'poll', receiverState: 'busy' });
    expect((await call(a, { action: 'send', to: b.memberId, requestId: 'stalled', message: 'x' })).error).toContain('Recipient paused (stalled)');
    expect(relay.snapshot().members.find((m) => m.memberId === b.memberId)?.receiverState).toBe('stalled');
  });

  it('ignores renderer errors without losing a successfully queued message', async () => {
    const a = await peer(); const b = await peer();
    emit.mockImplementationOnce(() => { throw new Error('window gone'); });
    const result = await call(a, { action: 'send', to: b.memberId, requestId: '1', message: 'queued' });
    expect(result.ok).toBe(true);
    expect((await call(b, { action: 'poll' })).messages[0].id).toBe(result.messageId);
  });

  it('rejects browser origins, wrong credentials and malformed bodies', async () => {
    const a = await peer();
    expect((await call(a, { action: 'list' }, { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await call(a, { action: 'list' }, { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await call(a, { action: 'poll', acks: [1] })).status).toBe(400);
    expect((await call(a, { action: 'register', generation: -1 })).status).toBe(400);
    expect((await call(a, { action: 'send', message: 'x'.repeat(20_000) })).status).toBe(413);
  });
});
