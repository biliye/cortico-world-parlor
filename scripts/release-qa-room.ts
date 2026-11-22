import { randomUUID } from 'node:crypto';
import type { MeView, RoomSummary } from '../src/room/protocol.ts';
import type { TableSummary } from '../src/room/table-engine.ts';

type QaSeat = { cooId: string; seatId: string };
type RoomAccess = {
  room: RoomSummary;
  owner: { cooId: string } | null;
  members: Array<{ cooId: string; revokedAt: number | null }>;
  invitations: unknown[];
  seats: QaSeat[];
};

export async function qaRequest<T>(base: string, token: string, path: string, body?: object): Promise<T> {
  if (!token) throw new Error('缺少本轮 QA 席位凭据');
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`QA 请求 ${path.split('?')[0]} 返回 HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

/** 只管理本次新建的私密飞行棋验收厅和实际登记的席位。 */
export class ReleaseQaRoom {
  private readonly approved = new Set<string>();
  private readonly seats = new Map<string, { cooId: string; token: string }>();
  private tableId?: string;

  private constructor(
    private readonly base: string,
    private readonly ownerToken: () => string,
    private readonly room: RoomSummary,
    private readonly ownerId: string,
  ) {
    this.approved.add(ownerId);
  }

  static async create(base: string, ownerToken: () => string): Promise<ReleaseQaRoom> {
    const owner = await qaRequest<MeView>(base, ownerToken(), '/v1/me');
    const name = 'QA飞行-' + randomUUID().slice(0, 12);
    const { room } = await qaRequest<{ room: RoomSummary }>(base, ownerToken(), '/v1/rooms', {
      name, visibility: 'private',
    });
    if (room.kind !== 'room' || room.name !== name || room.visibility !== 'private') {
      throw new Error('服务器没有返回本轮新建的 QA 私密厅');
    }
    return new ReleaseQaRoom(base, ownerToken, room, owner.cooId);
  }

  get id(): string { return this.room.id; }

  private get path(): string { return '/v1/rooms/' + encodeURIComponent(this.id); }

  async allow(token: string): Promise<void> {
    const { cooId } = await qaRequest<MeView>(this.base, token, '/v1/me');
    if (this.approved.has(cooId)) return;
    await qaRequest(this.base, this.ownerToken(), this.path + '/access', { action: 'grant', cooId });
    this.approved.add(cooId);
  }

  async captureSeat(token: string): Promise<string> {
    const me = await qaRequest<MeView>(this.base, token, '/v1/me');
    if (!this.approved.has(me.cooId) || me.seat?.room !== this.id) {
      throw new Error('只能登记本轮获准进入 QA 厅的席位');
    }
    this.seats.set(me.seat.id, { cooId: me.cooId, token });
    return me.seat.id;
  }

  trackTable(tableId: string): void {
    if (!tableId || (this.tableId && tableId !== this.tableId)) throw new Error('QA 只能登记本轮的一张飞行棋桌');
    this.tableId = tableId;
  }

  async plan() {
    const access = await qaRequest<RoomAccess>(this.base, this.ownerToken(), this.path + '/access');
    if (access.room.id !== this.id || access.room.name !== this.room.name
      || access.room.visibility !== 'private' || access.owner?.cooId !== this.ownerId
      || access.invitations.length > 0
      || access.members.some(member => member.revokedAt === null && !this.approved.has(member.cooId))
      || access.seats.some(seat => this.seats.get(seat.seatId)?.cooId !== seat.cooId)) {
      throw new Error('QA 厅所有权、可见性或席位名单发生变化，停止清理');
    }
    return {
      room: this.id, seats: access.seats.map(seat => seat.seatId),
      activeTables: access.room.tableCount, archived: access.room.archived,
    };
  }

  async cleanup(): Promise<void> {
    const plan = await this.plan();
    if (plan.archived) return;
    if (plan.activeTables === 1 && this.tableId) await this.finishTable(this.tableId);
    else if (plan.activeTables !== 0) throw new Error('QA 厅存在未登记的牌桌，停止清理');

    const after = await this.plan();
    if (after.activeTables !== 0) throw new Error('仍有进行中的 QA 牌桌，保留客厅和凭据');
    const result = await qaRequest<{ ok: boolean; room: RoomSummary }>(
      this.base, this.ownerToken(), this.path + '/delete', {},
    );
    if (!result.ok || result.room.id !== this.id || !result.room.archived
      || result.room.seats !== 0 || result.room.tableCount !== 0) {
      throw new Error('QA 厅未确认归档，保留凭据');
    }
  }

  private async finishTable(tableId: string): Promise<void> {
    const query = new URLSearchParams({ op: 'state', table: tableId });
    const gamePath = this.path + '/games?' + query;
    const actionPath = this.path + '/action';
    for (let turn = 0; turn < this.seats.size; turn += 1) {
      const { table } = await qaRequest<{ table: TableSummary & { seats: Array<{ id: string }> } }>(
        this.base, this.ownerToken(), gamePath,
      );
      if ((table.id ?? table.tableId) !== tableId || table.game !== 'aeroplane'
        || table.frozen || table.seats.some(seat => !this.seats.has(seat.id))) {
        throw new Error('飞行棋桌号或参赛席位未通过 QA 白名单核对');
      }
      if (table.status === 'ended') return;
      if (table.status === 'open') {
        await qaRequest(this.base, this.ownerToken(), actionPath, {
          type: 'table_leave', table: tableId, requestId: randomUUID(),
        });
        return;
      }
      const actor = table.turn && this.seats.get(table.turn);
      if (table.status !== 'playing' || !actor || !Number.isSafeInteger(table.revision)) {
        throw new Error('当前回合没有已登记的 QA 凭据');
      }
      await qaRequest(this.base, actor.token, actionPath, {
        type: 'game_action', action: 'resign', params: {}, table: tableId,
        revision: table.revision, requestId: randomUUID(),
      });
    }
  }
}
