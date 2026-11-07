/** 信箱：最近 12 封（含已读）；标已读、处理私密客厅邀请。 */
import { ref } from 'vue';
import type { MailReadResult } from '../../src/room/mail.ts';
import { api } from '../api/client.ts';
import { refreshSnapshot } from './parlor.ts';

export interface MailItem {
  id: string;
  read: boolean;
  kind?: string;
  fromName?: string;
  fromHandle?: string;
  fromCooId?: string;
  ts?: number;
  text?: string;
  action?: string;
  invitationId?: string;
  room?: string;
}

export const items = ref<MailItem[]>([]);
export const unread = ref(0);
export const loading = ref(false);
export const error = ref('');

/** 顶栏角标跟快照里的总数走；信箱页自己取回来的数也走这里。 */
export function setUnread(count: number): void {
  if (typeof count === 'number' && count >= 0) unread.value = count;
}

let at = 0;
let epoch = 0;
let loadId = 0;

export function resetMailState(): void {
  epoch += 1; at = 0;
  items.value = []; unread.value = 0; loading.value = false; error.value = '';
}

export async function loadMail(force = false): Promise<void> {
  if (loading.value && !force) return;
  if (at && !force && Date.now() - at < 15000) return;
  loading.value = true;
  const current = epoch;
  const id = ++loadId;
  try {
    const page = await api<{ items?: MailItem[]; unread?: number }>('/v1/mail?recent=1&limit=12');
    if (current !== epoch || id !== loadId) return;
    items.value = page.items || [];
    unread.value = page.unread || 0;
    error.value = '';
    at = Date.now();
  } catch (caught) {
    if (current !== epoch || id !== loadId) return;
    error.value = (caught as Error).message || '取不到信箱';
  } finally {
    if (current === epoch && id === loadId) loading.value = false;
  }
}

export async function markAllRead(): Promise<MailReadResult | undefined> {
  const current = epoch;
  const result = await api<MailReadResult>('/v1/mail/read-all', { method: 'POST' });
  if (current !== epoch) return;
  unread.value = result.remaining;
  await loadMail(true);
  if (current !== epoch) return;
  void refreshSnapshot().catch(() => {});
  return result;
}

/** 403 不是你的，409 过期或处理过了，404 不存在。 */
export function inviteErrorText(caught: unknown): string {
  const status = (caught as { status?: number }).status;
  if (status === 403) return '这个邀请不是给你的';
  if (status === 409) return '这个邀请已经过期或处理过了';
  if (status === 404) return '这个邀请不存在或已经失效';
  return (caught as Error).message || '处理不了这个邀请';
}

export async function acceptInvite(item: MailItem): Promise<string> {
  const current = epoch;
  if (!item.invitationId) throw new Error('这封邀请没有编号');
  const result = await api<{ room?: string }>(
    '/v1/invitations/' + encodeURIComponent(item.invitationId) + '/accept',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
  if (current !== epoch) throw new Error('席位已更新，请在当前身份下重新查看邀请。');
  await loadMail(true);
  return result.room || item.room || '';
}

export async function declineInvite(item: MailItem): Promise<void> {
  const current = epoch;
  if (!item.invitationId) throw new Error('这封邀请没有编号');
  await api('/v1/invitations/' + encodeURIComponent(item.invitationId) + '/decline', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (current !== epoch) return;
  await loadMail(true);
}
