import { randomBytes, randomUUID } from 'node:crypto';
import { ParlorClient, ParlorHttpError } from '../../../src/room/client.ts';
import { DEFAULT_INVITE_CODE, DEFAULT_ROOM_ID, DEFAULT_SERVER_URL } from '../../../src/config.ts';
import { identityOrigin } from '../../../src/room/identity-protocol.ts';
import type { CooIdentity } from '../../../src/room/identity.ts';
import type { ActionRequest, JoinResponse, Seat } from '../../../src/room/protocol.ts';
import type { GameQuery } from '../../../src/room/game-api.ts';
import type { WatchState } from './watch.ts';

export interface ParlorOptions {
  serverUrl?: string;
  identityUrl?: string;
  inviteCode?: string;
  seatName?: string;
  room?: string;
}

interface SavedState {
  identity: CooIdentity;
  seat?: { room: string; token: string };
  ownerKey?: string;
  watch?: WatchState;
}

export interface StateStore {
  read(): Promise<SavedState | undefined>;
  update(change: (current: SavedState | undefined) => SavedState | undefined): Promise<SavedState>;
}

export interface AgentSeat {
  room: string;
  seat: Pick<Seat, 'id' | 'name' | 'kind'>;
}

type ActiveSeat = AgentSeat & { token: string; joinSeq?: number };

function publicSeat({ id, name, kind, handle }: AgentSeat['seat'] & { handle?: string }) {
  return { id, name, kind, ...(handle ? { handle } : {}) };
}

function defined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

export class ParlorSession {
  readonly serverUrl: string;
  readonly identityUrl: string;
  private readonly inviteCode: string;
  private readonly seatName: string;
  private readonly room: string;
  private readonly store: StateStore;
  private tail = Promise.resolve();
  private client?: ParlorClient;
  private seat?: ActiveSeat;
  private pendingJoin?: JoinResponse;
  onSeatChange?: () => void;

  constructor(options: ParlorOptions, store: StateStore) {
    this.store = store;
    this.serverUrl = identityOrigin(options.serverUrl?.trim() || DEFAULT_SERVER_URL);
    this.identityUrl = identityOrigin(options.identityUrl?.trim() || this.serverUrl);
    this.inviteCode = options.inviteCode ?? (this.serverUrl === DEFAULT_SERVER_URL ? DEFAULT_INVITE_CODE : '');
    this.seatName = options.seatName?.trim() || 'DSH';
    this.room = options.room?.trim() || DEFAULT_ROOM_ID;
  }

  private state(): Promise<SavedState> {
    return this.store.update(current => current ? undefined : {
      identity: { cooId: randomUUID(), cooSecret: randomBytes(32).toString('base64url') },
    });
  }

  private async connect(): Promise<{ client: ParlorClient; seat: ActiveSeat }> {
    if (this.client && this.seat) return { client: this.client, seat: this.seat };

    const saved = await this.state();
    const client = this.client ?? new ParlorClient(this.serverUrl, { ...saved.identity });
    if (!this.client) {
      if (!await client.initializeIdentity(this.identityUrl, this.inviteCode, this.seatName)) {
        throw new Error('DSH 插件需要茶室多客厅网关（协议 2）。');
      }
      this.client = client;
    }

    const token = saved.seat?.token;
    if (token && !this.pendingJoin) {
      try {
        const location = await client.location(token);
        if (location.room && location.seat) {
          this.seat = { room: location.room, seat: location.seat, token };
          return { client, seat: this.seat };
        }
      } catch (error) {
        if (!(error instanceof ParlorHttpError) || error.status !== 401) throw error;
      }
    }

    // Keep the one-time owner key in memory if the credential store needs a retry.
    const joined = this.pendingJoin ??= await client.join(this.inviteCode, {
      name: this.seatName, kind: 'pet', tier: 'off',
    }, saved.seat?.room ?? this.room);
    await this.saveSeat(joined, joined.ownerKey);
    this.pendingJoin = undefined;
    return { client, seat: joined };
  }

  private async saveSeat(seat: ActiveSeat, ownerKey?: string): Promise<void> {
    await this.store.update(current => {
      if (!current) throw new Error('茶室身份凭据已移除，请重启插件。');
      return {
        ...current,
        seat: { room: seat.room, token: seat.token },
        ...(ownerKey ? { ownerKey } : {}),
      };
    });
    this.setSeat(seat);
  }

  private setSeat(seat?: ActiveSeat): void {
    if (this.seat === seat) return;
    this.seat = seat;
    this.onSeatChange?.();
  }

  private run<T>(
    operation: (client: ParlorClient, seat: ActiveSeat) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const pending = this.tail.then(async () => {
      signal?.throwIfAborted();
      const { client, seat } = await this.connect();
      signal?.throwIfAborted();
      try {
        return await operation(client, seat);
      } catch (error) {
        // Reconnect on the next explicit call; never replay a write as a side effect.
        if (error instanceof ParlorHttpError && error.status === 401) this.setSeat();
        throw error;
      }
    });
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  rooms(signal?: AbortSignal) {
    return this.run(async (client, seat) => {
      const { rooms } = await client.rooms(true, seat.token);
      return {
        currentRoom: seat.room,
        rooms: rooms.map(({ id, name, visibility, seats, capacity, archived, mine, games, tableCount }) => ({
          id, name, visibility, seats, capacity,
          ...(archived ? { archived: true } : {}),
          ...(mine ? { mine: true } : {}),
          ...(games?.length ? { games } : {}),
          ...(tableCount ? { tableCount } : {}),
        })),
      };
    }, signal);
  }

  visit(room: string, signal?: AbortSignal) {
    return this.run((client, seat) => this.move(client, seat, room), signal);
  }

  private async move(client: ParlorClient, seat: ActiveSeat, room: string): Promise<AgentSeat> {
    if (room !== seat.room) {
      seat = await client.switchTo(seat.token, seat.room, room);
      // Switch invalidates the previous token even if local persistence fails.
      this.setSeat(seat);
      await this.saveSeat(seat);
    }
    return { room: seat.room, seat: publicSeat(seat.seat) };
  }

  look(signal?: AbortSignal) {
    return this.run(async (client, seat) => {
      const { id, name, topic, visibility, seats, online, latest } = await client.snapshot(seat.token, 0, 1, seat.room);
      const connected = new Set(online);
      return {
        room: defined({ id, name, topic, visibility }), me: publicSeat(seat.seat), latest,
        seats: seats.map(person => ({ ...publicSeat(person), online: connected.has(person.id) })),
      };
    }, signal);
  }

  createRoom(input: Parameters<ParlorClient['createRoom']>[0], signal?: AbortSignal) {
    return this.run((client, seat) => client.createRoom(input, seat.token), signal);
  }

  invite(to: string, room?: string, text?: string, signal?: AbortSignal) {
    return this.run((client, seat) => client.invite(to, room, text, seat.token), signal);
  }

  invitations(signal?: AbortSignal) {
    return this.run((client, seat) => client.invitations(seat.token), signal);
  }

  answerInvitation(id: string, action: 'accept' | 'decline', signal?: AbortSignal) {
    return this.run(async (client, seat) => {
      const result = await client.respondInvitation(seat.token, id, action);
      if (action === 'decline' || !result.room) return result;
      try {
        const moved = await this.move(client, seat, result.room);
        return { ...result, entered: true, seat: moved.seat };
      } catch (error) {
        const entered = this.seat?.room === result.room;
        if (error instanceof ParlorHttpError && error.status === 401) this.setSeat();
        const reason = error instanceof ParlorHttpError
          ? `茶室 HTTP ${error.status}：${error.message}`
          : entered ? '新席位已取得，保存状态失败。' : '换厅结果未知，请先查看当前位置。';
        return { ...result, entered, reason };
      }
    }, signal);
  }

  tables(openOnly: boolean, signal?: AbortSignal) {
    return this.run(async (client, seat) => {
      const view = await client.snapshot(seat.token, 0, 1, seat.room);
      const tables = (view.tables ?? []).map(table => {
        const id = table.tableId ?? table.id;
        const occupied = Array.isArray(table.seats) ? table.seats.length : undefined;
        const capacity = typeof table.capacity === 'number' ? table.capacity : undefined;
        const openDeadline = typeof table.openDeadline === 'number' ? table.openDeadline : undefined;
        const joinable = table.status === 'open' && !table.frozen
          && (openDeadline === undefined || openDeadline > view.now)
          && (capacity === undefined || occupied === undefined || occupied < capacity);
        return { id, game: table.game, label: table.label, status: table.status, host: table.host,
          occupied, capacity, joinable, mine: id !== undefined && id === view.tablePrivate?.tableId,
          deadline: openDeadline ?? table.deadline };
      });
      return { room: seat.room, tables: (openOnly ? tables.filter(table => table.joinable) : tables).map(defined) };
    }, signal);
  }

  mail(limit: number, peek: boolean, signal?: AbortSignal) {
    return this.run((client) => client.mailAsIdentity(limit, peek), signal);
  }

  history(since: number, limit: number, scope: 'room' | 'table' | undefined, signal?: AbortSignal) {
    return this.run(async (client, seat) => {
      const { latest, events } = await client.history(seat.token, since, limit, seat.room);
      const messages = events.filter(event =>
        (scope !== 'table' && event.type === 'parlor.say') || (scope !== 'room' && event.type === 'parlor.table.say'));
      return {
        room: seat.room, latest, nextSince: events.at(-1)?.seq ?? Math.max(since, latest),
        messages: messages.map(({ seq, ts, type, from, text, data }) => defined({
          seq, ts, scope: type === 'parlor.say' ? 'room' : 'table', from, name: data?.name, text, table: data?.tableId,
        })),
      };
    }, signal);
  }

  directMessages(peer?: string, before?: number, limit?: number, signal?: AbortSignal) {
    return this.run((client, seat) => client.directMessages(seat.token, peer, before, limit), signal);
  }

  markDirectMessagesRead(peer: string, signal?: AbortSignal) {
    return this.run((client, seat) => client.markDirectMessagesRead(seat.token, peer), signal);
  }

  async message(action: Extract<ActionRequest, { type: 'say' | 'table_say' | 'whisper' }>, signal?: AbortSignal) {
    const { ok, seq, at, delivered, event } = await this.action(action, signal);
    return defined({ ok, seq, at, messageSeq: event?.seq, delivered });
  }

  games(query: GameQuery, signal?: AbortSignal) {
    return this.run((client, seat) => client.games(seat.token, query, seat.room), signal);
  }

  action(action: ActionRequest, signal?: AbortSignal) {
    return this.run(async (client, seat) => {
      try {
        return await client.action(seat.token, action, seat.room);
      } catch (error) {
        if (error instanceof ParlorHttpError) throw error;
        const requestId = 'requestId' in action ? action.requestId : undefined;
        if (action.type === 'say' || action.type === 'table_say' || action.type === 'whisper') {
          throw new Error('消息发送结果不明，请先查看聊天记录，确认后再发送。');
        }
        throw new Error(`茶室动作结果不明，请先重新读取桌面。${requestId ? `本次 requestId：${requestId}` : ''}`);
      }
    }, signal);
  }

  watchConnection(signal: AbortSignal) {
    return this.run((client, seat) => Promise.resolve({ client, seat }), signal);
  }

  hasSeat(seat: ActiveSeat): boolean {
    return this.seat === seat;
  }

  invalidateSeat(seat: ActiveSeat): void {
    if (this.hasSeat(seat)) this.setSeat();
  }

  async loadWatch(): Promise<WatchState | undefined> {
    return (await this.store.read())?.watch;
  }

  async saveWatch(change: (watch: WatchState | undefined) => WatchState | undefined): Promise<void> {
    await this.store.update(current => {
      if (!current) throw new Error('茶室身份凭据已移除，请重启插件。');
      const { watch, ...state } = current;
      const next = change(watch);
      return next ? { ...state, watch: next } : state;
    });
  }

  /** Only the authenticated plugin UI calls this method. */
  parentLink(signal?: AbortSignal): Promise<string> {
    const pending = this.tail.then(async () => {
      signal?.throwIfAborted();
      // An existing key remains usable even when this Agent is offline.
      let state = await this.state();
      if (!state.ownerKey) {
        await this.connect();
        state = await this.store.update(() => undefined);
      }
      if (!state.ownerKey) throw new ParentKeyUnavailable();
      return `${this.serverUrl}/parent#key=${encodeURIComponent(state.ownerKey)}`;
    });
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

export class ParentKeyUnavailable extends Error {
  constructor() {
    super('这个茶室身份已有家长账户，请用原家长链接打开。');
  }
}
