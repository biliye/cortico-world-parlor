import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ParlorHttpError } from '../../../src/room/client.ts';
import { scopeVisibleTo, type RoomEvent } from '../../../src/room/protocol.ts';
import type { ParlorSession } from './session.ts';

interface Cursor {
  room: string;
  seat: string;
  seq: number;
}

type StopReason = 'archived' | 'missing';

interface WatchHost {
  unavailable(sessionId: string): Promise<StopReason | undefined>;
  deliver(sessionId: string, cursor: Cursor, text: string, signal: AbortSignal): Promise<StopReason | undefined>;
}

export interface WatchState {
  id: string;
  sessionId: string;
  roomChat: boolean;
  table?: string;
  cursor: Cursor;
}

interface ActiveWatch {
  state: WatchState;
  abort: AbortController;
  stream?: AbortController;
  connection: 'connecting' | 'connected' | 'reconnecting';
  deliveryFailed?: boolean;
}

function withTable({ table: _previous, ...state }: WatchState, table?: string): WatchState {
  return table ? { ...state, table } : state;
}

const tableNotices: Record<string, string> = {
  'parlor.table.join': '有玩家入座。查看牌桌和开局条件。',
  'parlor.table.start': '牌桌已开局。查看自己的桌面。',
  'parlor.table.end': '牌局已结算。查看结果。',
  'parlor.table.cancel': '牌桌已关闭。',
};

function noticeFor(event: RoomEvent, seat: string, watch: WatchState): string | undefined {
  if (!scopeVisibleTo(event.scope, seat) || event.from === seat) return;
  switch (event.type) {
    case 'parlor.invite':
      return '有客厅邀请。用 parlor_room invitations 或 parlor_query mail 查看。';
    case 'parlor.whisper':
      return '有私信。用 parlor_query dm 查看。';
    case 'parlor.table.turn':
      if (event.scope.kind === 'seat' && event.data?.decision !== false) {
        return '轮到本席行动。先用 parlor_game_info state 核对当前桌面、时限和合法动作。';
      }
      return;
    case 'parlor.table.say':
      return '有人在同桌聊天。用 parlor_query chat，scope 为 table，读取消息。';
    case 'parlor.say':
      if (watch.roomChat || event.mentions?.includes(seat)) {
        return '有客厅消息。用 parlor_query chat，scope 为 room，读取消息。';
      }
      return;
    default:
      if (watch.table && event.data?.tableId === watch.table && event.data?.seat !== seat
        && Object.hasOwn(tableNotices, event.type)) return tableNotices[event.type];
  }
}

export class ParlorWatch {
  private readonly session: ParlorSession;
  private readonly host: WatchHost;
  private current?: ActiveWatch;
  private stoppedReason?: StopReason;
  private disposed = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(session: ParlorSession, host: WatchHost) {
    this.session = session;
    this.host = host;
    session.onSeatChange = () => this.current?.stream?.abort();
    this.tail = session.loadWatch().then(state => {
      if (state && !this.disposed) this.activate(state);
    }).catch(() => {});
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(operation);
    this.tail = pending.catch(() => {});
    return pending;
  }

  start(sessionId: string, roomChat: boolean, table: string | undefined, signal: AbortSignal) {
    return this.run(async () => {
      signal.throwIfAborted();
      if (this.disposed) throw new Error('茶室插件已经停止。');
      const previous = await this.currentWatch();
      if (previous && previous.state.sessionId !== sessionId) {
        throw new Error('茶室正在另一个 DSH 会话等待，请在那里停止等待后再切换。');
      }
      const { client, seat } = await this.session.watchConnection(signal);
      const snapshot = await client.snapshot(seat.token, 0, 1, seat.room);
      const ownTable = snapshot.tablePrivate?.tableId;
      if (table && table !== ownTable
        && !snapshot.tables?.some(row => (row.tableId ?? row.id) === table
          && Array.isArray(row.seats) && row.seats.some(player => (player as { id?: string })?.id === seat.seat.id))) {
        throw new Error('只能等待本席参加的牌桌。请先入座或省略 table。');
      }
      // Read actions after the snapshot cursor. Any event produced between the
      // two reads remains eligible for replay from that cursor.
      let pendingAction = false;
      if (ownTable && (!table || table === ownTable)) {
        try {
          const { availableActions } = await client.games(seat.token, { op: 'state', table: ownTable }, seat.room);
          pendingAction = Array.isArray(availableActions) && availableActions.length > 0;
        } catch (error) {
          if (!(error instanceof ParlorHttpError) || error.status !== 404) throw error;
        }
      }
      signal.throwIfAborted();
      if (this.disposed) throw new Error('茶室插件已经停止。');
      if (!this.session.hasSeat(seat)) throw new Error('客厅已变更，请重新开始等待。');
      const cursor = previous?.state.cursor;
      const state = withTable({
        id: randomUUID(), sessionId, roomChat,
        cursor: cursor?.room === seat.room && cursor.seat === seat.seat.id
          ? cursor : { room: seat.room, seat: seat.seat.id, seq: snapshot.latest },
      }, table ?? ownTable);
      await this.session.saveWatch(() => state);
      previous?.abort.abort();
      if (!this.disposed) {
        this.stoppedReason = undefined;
        this.activate(state);
      }
      return { ...this.view(sessionId), since: state.cursor.seq, pendingAction };
    });
  }

  status(sessionId: string) {
    return this.run(async () => {
      await this.currentWatch();
      return this.view(sessionId);
    });
  }

  stop(sessionId: string) {
    return this.run(async () => {
      const active = await this.currentWatch();
      if (active?.state.sessionId === sessionId) await this.deactivate(active);
      return this.view(sessionId);
    });
  }

  retire(sessionId: string, reason: StopReason) {
    return this.run(async () => {
      const active = this.current;
      if (active?.state.sessionId === sessionId) await this.deactivate(active, reason);
    });
  }

  private async currentWatch(): Promise<ActiveWatch | undefined> {
    const active = this.current;
    if (active) {
      const reason = await this.host.unavailable(active.state.sessionId);
      if (reason) await this.deactivate(active, reason);
    }
    return this.current;
  }

  private async deactivate(active: ActiveWatch, reason?: StopReason): Promise<void> {
    if (this.current !== active) return;
    await this.session.saveWatch(saved => saved?.id === active.state.id ? undefined : saved);
    active.abort.abort();
    this.current = undefined;
    this.stoppedReason = reason;
  }

  track(sessionId: string, table?: string) {
    return this.run(async () => {
      const active = this.current;
      if (!active || active.state.sessionId !== sessionId || active.state.table === table) return;
      await this.session.saveWatch(saved => saved?.id === active.state.id ? withTable(saved, table) : saved);
      active.state = withTable(active.state, table);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.current?.abort.abort();
    this.current = undefined;
    this.session.onSeatChange = undefined;
  }

  private view(sessionId: string) {
    const active = this.current;
    if (!active) return { active: false, ...(this.stoppedReason ? { reason: this.stoppedReason } : {}) };
    if (active.state.sessionId !== sessionId) return { active: false, anotherSession: true };
    const { roomChat, table, cursor } = active.state;
    return { active: true, connection: active.connection, roomChat, room: cursor.room, ...(table ? { table } : {}),
      ...(active.deliveryFailed ? { reason: 'delivery_failed' } : {}) };
  }

  private activate(state: WatchState): void {
    const active: ActiveWatch = { state, abort: new AbortController(), connection: 'connecting' };
    this.current = active;
    void this.listen(active);
  }

  private async listen(active: ActiveWatch): Promise<void> {
    const signal = active.abort.signal;
    let retry = 1_000;
    while (!signal.aborted) {
      let replaced = false;
      try {
        const reason = await this.host.unavailable(active.state.sessionId);
        if (reason) {
          await this.run(() => this.deactivate(active, reason));
          return;
        }
        const { client, seat } = await this.session.watchConnection(signal);
        if (active.state.cursor.room !== seat.room || active.state.cursor.seat !== seat.seat.id) {
          const snapshot = await client.snapshot(seat.token, 0, 1, seat.room);
          if (signal.aborted || !this.session.hasSeat(seat)) continue;
          const cursor = { room: seat.room, seat: seat.seat.id, seq: seat.joinSeq ?? snapshot.latest };
          const table = snapshot.tablePrivate?.tableId;
          await this.session.saveWatch(saved =>
            saved?.id === active.state.id ? withTable({ ...saved, cursor }, table) : saved);
          active.state = withTable({ ...active.state, cursor }, table);
          if (signal.aborted || !this.session.hasSeat(seat)) continue;
        }
        const stream = new AbortController();
        active.stream = stream;
        const connectionSignal = AbortSignal.any([signal, stream.signal]);
        try {
          await client.stream(seat.token, active.state.cursor.seq, async event => {
            if (connectionSignal.aborted || !this.session.hasSeat(seat)
              || !Number.isSafeInteger(event.seq) || event.seq <= active.state.cursor.seq) return;
            const notice = noticeFor(event, seat.seat.id, active.state);
            const cursor = { ...active.state.cursor, seq: event.seq };
            if (notice) {
              // Only local instructions enter the Agent queue. Other players' text
              // and private game state are read separately through ordinary tools.
              try {
                const reason = await this.host.deliver(active.state.sessionId, cursor,
                  `[鲸语茶室事件] ${notice}（事件 ${event.seq}）`, connectionSignal);
                if (connectionSignal.aborted) return;
                if (reason) {
                  await this.run(() => this.deactivate(active, reason));
                  return;
                }
                await this.session.saveWatch(saved =>
                  saved?.id === active.state.id ? { ...saved, cursor } : saved);
                active.deliveryFailed = false;
                retry = 1_000;
              } catch (error) {
                if (!connectionSignal.aborted) active.deliveryFailed = true;
                throw error;
              }
            }
            active.state.cursor = cursor;
          }, connectionSignal, seat.room, () => {
            active.connection = 'connected';
            if (!active.deliveryFailed) retry = 1_000;
          });
        } catch (error) {
          if (!connectionSignal.aborted && error instanceof ParlorHttpError && [401, 403, 404].includes(error.status)) {
            active.stream = undefined;
            this.session.invalidateSeat(seat);
          }
        } finally {
          replaced = stream.signal.aborted;
          active.stream = undefined;
        }
      } catch { /* A failed connection is retried without replaying tool writes. */ }
      if (signal.aborted) return;
      active.connection = 'reconnecting';
      if (replaced) continue;
      await delay(retry, undefined, { signal, ref: false }).catch(() => {});
      retry = Math.min(retry * 2, 30_000);
    }
  }
}
