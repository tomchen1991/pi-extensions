export interface PiCollaborationRequest {
  projectId: number;
  name: string;
}

export interface PiCollaborationStarted extends PiCollaborationRequest {
  terminalId: string;
}

/** Only display data crosses Electron IPC; launch credentials never reach the renderer. */
export interface PiCollaborationMember {
  terminalId: string;
  projectId: number;
  projectName: string;
  /** Display label only. Delivery still addresses memberId, never this name. */
  name: string;
  group: string;
  memberId?: string;
  status: 'starting' | 'online' | 'offline' | 'closed';
  sent: number;
  received: number;
  pendingCount?: number;
  receiverState?: 'ready' | 'busy' | 'error' | 'stalled';
}

export interface PiCollaborationActivity {
  id: string;
  from: string;
  to: string;
  group: string;
  status: 'queued' | 'accepted' | 'delivered' | 'expired';
  reason?: 'timeout' | 'session-ended';
  timestamp: number;
}

export interface PiCollaborationSnapshot {
  members: PiCollaborationMember[];
  /** Metadata only. Message bodies stay in the receiving Pi transcript. */
  activity: PiCollaborationActivity[];
}

export const COLLABORATION_LIMITS = {
  bodyBytes: 16_384,
  messageBytes: 8_192,
  pending: 20,
  pollBatch: 4,
  messageTtlMs: 10 * 60_000,
  stalledMs: 2 * 60_000,
  sendsPerLaunch: 50,
  sendsPerMinute: 10,
  leaseMs: 15_000,
  launches: 64,
} as const;

function normalizeLabel(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what}无效`);
  const label = value.trim().normalize('NFC');
  if (!label || label.length > 40 || /[\x00-\x1f\x7f]/.test(label)) {
    throw new Error(`${what}须为 1–40 个字符，不能包含控制字符`);
  }
  return label;
}

export function normalizeCollaborationGroup(value: unknown): string {
  return normalizeLabel(value, '协作组名称');
}

export function normalizeCollaborationName(value: unknown): string {
  return normalizeLabel(value, '协作 PI 名称');
}
