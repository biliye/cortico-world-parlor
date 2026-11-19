import { randomBytes, randomUUID } from 'node:crypto';
import { ParlorClient, ParlorHttpError } from '../../../src/room/client.ts';
import { DEFAULT_INVITE_CODE, DEFAULT_ROOM_ID, DEFAULT_SERVER_URL } from '../../../src/config.ts';
import { identityOrigin } from '../../../src/room/identity-protocol.ts';
import type { CooIdentity } from '../../../src/room/identity.ts';
import type { ActionRequest, JoinResponse, Seat } from '../../../src/room/protocol.ts';
import type { GameQuery } from '../../../src/room/game-api.ts';

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
}

export interface StateStore {
  update(change: (current: SavedState | undefined) => SavedState | undefined): Promise<SavedState>;
}

export interface AgentSeat {
  room: string;
  seat: Pick<Seat, 'id' | 'name' | 'kind'>;
}

type ActiveSeat = AgentSeat & { token: string };

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
    this.seat = seat;
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
        if (error instanceof ParlorHttpError && error.status === 401) this.seat = undefined;
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
    return this.run(async (client, seat): Promise<AgentSeat> => {
      if (room !== seat.room) {
        const moved = await client.switchTo(seat.token, seat.room, room);
        // Keep the authoritative new token even if persistence briefly fails.
        this.seat = moved;
        await this.saveSeat(moved);
        seat = moved;
      }
      return { room: seat.room, seat: { id: seat.seat.id, name: seat.seat.name, kind: seat.seat.kind } };
    }, signal);
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
        throw new Error(`茶室动作结果不明，请先重新读取桌面。${requestId ? `本次 requestId：${requestId}` : ''}`);
      }
    }, signal);
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
