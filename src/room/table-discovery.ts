import { createHmac } from 'node:crypto';
import type { Db } from './db.ts';
import { HostError, type RoomHost } from './room-host.ts';
import { activeSeatForCoo, hashSeatToken, seatByTokenHash, type SeatRow } from './room-seat-db.ts';
import { roomEntryRefusal } from './room-access-db.ts';
import { lockCooRows, lockRoomRow } from './storage/locks.ts';
import { jsonValue } from './storage/json.ts';
import { versionAtLeast } from './games/werewolf.ts';
import { WEREWOLF_MIN_CLIENT } from './games/werewolf-table.ts';
import { tableCapacity, type TableEntryInput, type TableEntryResponse, type TableEntryResult, type TableRecruitment } from './table-discovery-db.ts';

interface Candidate { id: string; room_id: string; room_name: string; game: string; stake: number; created_at: number; n: number }
interface EntryReceipt { coo_id: string; source_token_hash: string; result_token_hash: string; body_key: string; receipt_json: string }

/** 选择桌、换厅、入桌和回执在同一事务内提交；桌队列一直持有到 COMMIT。 */
export class TableDiscovery {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly db: Db;
  private readonly host: (room: string) => Promise<RoomHost>;
  private readonly now: () => number;
  constructor(db: Db, host: (room: string) => Promise<RoomHost>, now: () => number) {
    this.db = db;
    this.host = host;
    this.now = now;
  }

  async recruits(): Promise<TableRecruitment[]> {
    const rows = await this.db.prepare(
      `SELECT t.id, t.room_id, r.name AS room_name, t.game, t.stake, t.created_at,
              d.recruit_text, d.author_coo_id, d.updated_at, c.display_name AS author
         FROM table_discovery d JOIN tables t ON t.id=d.table_id JOIN rooms r ON r.id=t.room_id
         LEFT JOIN coos c ON c.id=d.author_coo_id
        WHERE d.recruit_text<>'' AND t.status='open' AND t.frozen_at IS NULL
          AND t.deadline_at>? AND r.visibility='public' AND r.archived_at IS NULL
        ORDER BY d.updated_at DESC, t.id LIMIT 100`,
    ).all(this.now()) as Array<Candidate & { recruit_text: string; author: string; updated_at: number }>;
    const result: TableRecruitment[] = [];
    for (const row of rows) {
      const table = await (await this.host(row.room_id)).tablePublic(row.id);
      const capacity = tableCapacity(row.game);
      if (!table || table.status !== 'open' || table.frozen || !capacity || Number(table.openDeadline) <= this.now()) continue;
      const seats = Array.isArray(table.seats) ? table.seats.length : 0;
      result.push({ tableId: row.id, room: row.room_id, roomName: row.room_name, game: row.game,
        label: table.label, seats, capacity, full: seats >= capacity, stake: Number(row.stake),
        text: row.recruit_text, author: row.author || '来客', updatedAt: Number(row.updated_at),
        link: `/play?${new URLSearchParams({ room: row.room_id, view: 'table', table: row.id })}` });
    }
    return result;
  }

  async enter(token: string, input: TableEntryInput, clientVersion?: string): Promise<TableEntryResponse> {
    const requestId = input.requestId?.trim();
    if (!requestId || requestId.length > 100) throw new HostError('invalid', '需要 1–100 字的 requestId；重试请使用同一个编号');
    if (!token) throw new HostError('forbidden', '缺少席位令牌，请先加入大厅');
    const direct = Boolean(input.table);
    if (direct ? (!input.room || input.game !== undefined) : (!tableCapacity(input.game || '') || input.room !== undefined)) {
      throw new HostError('invalid', '快速匹配需要选择游戏；定向加入需要客厅号和桌号');
    }
    const key = JSON.stringify(direct ? { room: input.room, table: input.table } : { game: input.game });
    const tokenHash = hashSeatToken(token);
    const saved = await this.db.prepare('SELECT * FROM table_entry_receipts WHERE source_token_hash=? AND request_id=?').get(tokenHash, requestId) as EntryReceipt | undefined;
    const seat = await seatByTokenHash(this.db, tokenHash);
    const cooId = saved?.coo_id ?? (seat?.releasedAt === null ? seat.cooId : undefined);
    if (!cooId) throw new HostError('forbidden', '席位令牌已经失效，请重新加入');
    return this.serial(cooId, async () => {
      const prior = await this.db.prepare('SELECT * FROM table_entry_receipts WHERE coo_id=? AND request_id=?').get(cooId, requestId) as EntryReceipt | undefined;
      if (prior) return this.replay(prior, token, requestId, key);
      const source = await seatByTokenHash(this.db, tokenHash);
      if (!source || source.releasedAt !== null) throw new HostError('forbidden', '席位已经变化，请刷新后重试');
      if (source.kind === 'observer') throw new HostError('forbidden', '观看者不能上桌，请先用自己的玩家身份加入');
      if (await this.db.prepare('SELECT 1 FROM active_table_players WHERE coo_id=?').get(cooId)) {
        throw new HostError('already_seated', '你已经在牌桌上，请先回到当前桌；未开局可以先退桌');
      }
      const sourceHost = await this.host(source.roomId);
      const candidates = await this.candidates(input, source.roomId);
      if (direct && candidates.length === 0) throw new HostError('not_found', '这张牌桌不存在、已经开始、关闭或过期了');
      for (const candidate of candidates) {
        if (candidate.game === 'werewolf' && source.kind === 'pet' && !versionAtLeast(clientVersion, WEREWOLF_MIN_CLIENT)) {
          throw new HostError('conflict', `狼人杀需要 Coo 的客厅扩展至少 ${WEREWOLF_MIN_CLIENT}，请升级后再加入`);
        }
        const targetHost = await this.host(candidate.room_id);
        let result!: TableEntryResult;
        const nextToken = candidate.room_id === source.roomId ? token : this.entryToken(token, requestId);
        let enteredSeat: SeatRow = source;
        let joinSeq = 0;
        try {
          await targetHost.joinTable(cooId, candidate.id, requestId, clientVersion, {
            before: async () => {
              await lockCooRows(this.db, [cooId]);
              for (const room of [...new Set([source.roomId, candidate.room_id])].sort()) await lockRoomRow(this.db, room);
              const actual = await activeSeatForCoo(this.db, cooId);
              if (!actual || actual.id !== source.id || actual.tokenHash !== tokenHash) throw new HostError('forbidden', '席位已经变化，请刷新后重试');
              if (await this.db.prepare('SELECT 1 FROM active_table_players WHERE coo_id=?').get(cooId)) throw new HostError('already_seated', '你已经在另一张牌桌上');
              const refusal = await roomEntryRefusal(this.db, candidate.room_id, cooId);
              if (refusal) throw new HostError('forbidden', refusal);
              if (!direct) {
                const eligible = await this.db.prepare(
                  `SELECT 1 FROM table_discovery d JOIN tables t ON t.id=d.table_id JOIN rooms r ON r.id=t.room_id
                    WHERE t.id=? AND d.match_open=1 AND t.status='open' AND t.stake=0 AND t.frozen_at IS NULL
                      AND t.deadline_at>? AND r.visibility='public' AND r.archived_at IS NULL`,
                ).get(candidate.id, this.now());
                if (!eligible) throw new HostError('conflict', '这张桌子已经停止匹配');
              }
              if (source.roomId !== candidate.room_id) {
                const moved = await sourceHost.switchTo(cooId, candidate.room_id, { token: nextToken });
                enteredSeat = moved.seat;
                joinSeq = moved.joinEvent.seq;
              }
            },
            after: async (joined) => {
              result = { ok: true, matched: true, room: candidate.room_id, roomName: candidate.room_name,
                seat: { id: enteredSeat.id, name: enteredSeat.name, kind: enteredSeat.kind, tier: enteredSeat.tier },
                token: nextToken, tableId: candidate.id, revision: joined.receipt.revision,
                seq: joined.event.seq, joinSeq: joinSeq || joined.event.seq };
              const { token: _secret, ...publicReceipt } = result;
              await this.db.prepare(
                `INSERT INTO table_entry_receipts(coo_id, request_id, source_token_hash, result_token_hash, body_key, receipt_json, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
              ).run(cooId, requestId, tokenHash, hashSeatToken(nextToken), key, JSON.stringify(publicReceipt), this.now());
            },
          });
          return result;
        } catch (error) {
          // 只对候选失效/座位被抢有限重选；认证、权限、已有牌桌与存储故障直接上报。
          if (direct || !(error instanceof HostError) || !['full', 'conflict', 'not_found'].includes(error.code)) throw error;
        }
      }
      return { ok: true, matched: false };
    });
  }

  private async candidates(input: TableEntryInput, sourceRoom: string): Promise<Candidate[]> {
    const rows = await this.db.prepare(
      `SELECT t.id, t.room_id, r.name AS room_name, t.game, t.stake, t.created_at,
              (SELECT COUNT(*) FROM table_seats s WHERE s.table_id=t.id AND s.left_at IS NULL) AS n
         FROM tables t JOIN rooms r ON r.id=t.room_id LEFT JOIN table_discovery d ON d.table_id=t.id
        WHERE t.status='open' AND t.frozen_at IS NULL AND t.deadline_at>? AND r.archived_at IS NULL
          AND ${input.table ? 't.id=? AND t.room_id=?' : `d.match_open=1 AND t.game=? AND t.stake=0 AND r.visibility='public'
            AND (SELECT COUNT(*) FROM table_seats s WHERE s.table_id=t.id AND s.left_at IS NULL)<?
            AND (r.id=? OR (SELECT COUNT(*) FROM room_seats rs WHERE rs.room_id=r.id AND rs.released_at IS NULL AND rs.kind<>'observer')<r.capacity)`}
        ORDER BY n DESC, t.created_at, t.id LIMIT 30`,
    ).all(this.now(), ...(input.table ? [input.table, input.room!] : [input.game!, tableCapacity(input.game!), sourceRoom])) as Candidate[];
    return input.table ? rows : rows.filter((row) => Number(row.n) < tableCapacity(row.game));
  }

  private entryToken(source: string, requestId: string): string {
    return createHmac('sha256', source).update(`parlor-table-entry:${requestId}`).digest('base64url');
  }

  private async replay(prior: EntryReceipt, token: string, requestId: string, key: string): Promise<TableEntryResult> {
    if (key !== prior.body_key) throw new HostError('conflict', '同一个 requestId 不能改游戏或目标牌桌');
    const hash = hashSeatToken(token);
    if (hash !== prior.source_token_hash && hash !== prior.result_token_hash) throw new HostError('forbidden', '此请求不属于当前席位');
    const active = await activeSeatForCoo(this.db, prior.coo_id);
    if (!active || active.tokenHash !== prior.result_token_hash) throw new HostError('conflict', '这次加入已处理，之后席位又发生了变化，请查看当前席位');
    const resultToken = hash === prior.result_token_hash ? token : this.entryToken(token, requestId);
    const result = jsonValue<Omit<TableEntryResult, 'token'>>(prior.receipt_json, {} as Omit<TableEntryResult, 'token'>);
    return { ...result, token: resultToken };
  }

  private async serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => held);
    this.chains.set(key, tail);
    await previous;
    try { return await work(); } finally { release(); if (this.chains.get(key) === tail) this.chains.delete(key); }
  }
}
