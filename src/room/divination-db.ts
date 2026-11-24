import { randomInt, randomUUID } from 'node:crypto';
import type { ParentAccount } from './coo-account-db.ts';
import { withTransaction, type Db } from './db.ts';
import { DIVINATION_LOTS, divinationDay } from './divination-lots.ts';
import {
  DIVINATION_BOARD_LIMIT, DIVINATION_NAME, DIVINATION_REQUEST, DIVINATION_ROOM,
  type DivinationBoardEntry, type DivinationChatMessage, type DivinationDraw, type LotGrade,
} from './divination-protocol.ts';
import { EventDb } from './event-db.ts';
import { HttpError } from './http.ts';
import { MailDb } from './mail-db.ts';

type DrawRow = {
  id: string; day_key: string; display_name: string; lot_number: number; lot_grade: LotGrade;
  is_head: number; drawn_at: number; interpretation: string | null;
};

const REPLY_TIME_MS = 24 * 60 * 60_000;
const DRAW_ID = /^[0-9a-f-]{36}$/i;

function drawView(row: DrawRow): DivinationDraw {
  return {
    id: row.id, day: row.day_key, lot: { ...DIVINATION_LOTS[row.lot_number - 1], grade: row.lot_grade },
    head: row.is_head === 1, interpretation: row.interpretation,
  };
}

export class DivinationDb {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
    private readonly onCommit: (room: string) => void,
  ) {}

  async draw(account: ParentAccount, request: unknown, hall: string, getPlayer: () => Promise<{ id: string; name: string }>) {
    if (typeof request !== 'string' || !DRAW_ID.test(request)) throw new HttpError(400, '抽签请求编号无效');
    return withTransaction(this.db, async () => {
      const active = await this.db.prepare("SELECT id FROM accounts WHERE id = ? AND status = 'active' FOR UPDATE").get(account.id);
      if (!active) throw new HttpError(403, '家长账户已停用');
      const now = this.now();
      const day = divinationDay(now);
      const retry = await this.db.prepare('SELECT * FROM divination_draws WHERE account_id = ? AND request_id = ?')
        .get<DrawRow>(account.id, request);
      const existing = retry ?? await this.findToday(account.id, day.key);
      if (existing) return { draw: drawView(existing), day: day.key, letter: undefined };

      const player = await getPlayer();
      const lot = DIVINATION_LOTS[randomInt(DIVINATION_LOTS.length)];
      const row: DrawRow = {
        id: randomUUID(), day_key: day.key, display_name: player.name, lot_number: lot.number,
        lot_grade: lot.grade, is_head: lot.number === day.head ? 1 : 0, drawn_at: now, interpretation: null,
      };
      await this.db.prepare(`INSERT INTO divination_draws
        (id, account_id, coo_id, player_coo_id, day_key, request_id, display_name, lot_number, lot_grade, is_head, drawn_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.id, account.id, account.cooId, player.id, day.key, request, player.name, lot.number, lot.grade, row.is_head, now);
      const reply = JSON.stringify({ scope: 'private', to: player.id, text: `【解签 ${row.id}】你的解读` });
      const letter = await new MailDb(this.db, { now: () => now }).append({
        to: account.cooId, room: DIVINATION_ROOM, kind: 'whisper', action: DIVINATION_REQUEST, fromName: DIVINATION_NAME,
        text: `家长「${player.name}」抽到了第 ${lot.number} 签（${lot.grade}）。\n${lot.poem}\n宜：${lot.advice}\n${lot.note}\n`
          + '\n解签前，先想想你和家长之间的事。可以是最近聊过的话、一起做过的小事，或一句你还想回应的话。挑一个你确实记得、又和这支签有共鸣的细节，想想签诗里的哪句话或哪个意象让你想起它。\n'
          + '用你平时和家长说话的口吻，把这处联系和你想对家长说的话写成两三句。要是想不起合适的经历，就从签文说起，写一句你此刻真心想对家长说的话。\n\n'
          + `请在抽签后 24 小时内用 parlor_message ${reply}回信，保留开头的解签标记，把「你的解读」换成你写的话。超过时限，回信会作为普通私信送达。把它当作茶余一乐，别替家长做决定。`,
      });
      const draw = drawView(row);
      if (draw.head) {
        try {
          // EventDb.append 用嵌套事务的保存点。播报语句失败时，已写入的签和信仍可提交。
          await this.sayIn(hall, DIVINATION_NAME, `恭喜 ${player.name} 在问卦阁抽中了头签！`, now, true);
        } catch {
          console.warn('parlor: 问卦阁头签播报未写入', { drawId: row.id });
        }
      }
      return { draw, day: day.key, letter };
    });
  }

  private findToday(account: string, day: string) {
    return this.db.prepare('SELECT * FROM divination_draws WHERE account_id = ? AND day_key = ?').get<DrawRow>(account, day);
  }

  async today(account?: string): Promise<{ day: string; draw: DivinationDraw | null; board: DivinationBoardEntry[] }> {
    const day = divinationDay(this.now());
    const [row, board] = await Promise.all([
      account ? this.findToday(account, day.key) : undefined,
      this.db.prepare(`SELECT display_name, lot_number, lot_grade, is_head, drawn_at FROM divination_draws
        WHERE day_key = ? AND lot_grade IN ('上上','上吉') ORDER BY drawn_at DESC, id DESC LIMIT ?`)
        .all<Pick<DrawRow, 'display_name' | 'lot_number' | 'lot_grade' | 'is_head' | 'drawn_at'>>(day.key, DIVINATION_BOARD_LIMIT),
    ]);
    return {
      day: day.key,
      draw: row ? drawView(row) : null,
      board: board.map(entry => ({
        name: entry.display_name, number: entry.lot_number, grade: entry.lot_grade,
        head: entry.is_head === 1, time: entry.drawn_at,
      })),
    };
  }

  async unread(account: string): Promise<DivinationDraw | null> {
    const row = await this.db.prepare(`SELECT * FROM divination_draws
      WHERE account_id = ? AND interpretation IS NOT NULL AND seen_at IS NULL ORDER BY interpreted_at DESC, id DESC LIMIT 1`)
      .get<DrawRow>(account);
    return row ? drawView(row) : null;
  }

  async seen(account: string, id: unknown): Promise<void> {
    if (typeof id !== 'string' || !DRAW_ID.test(id)) throw new HttpError(400, '签的编号无效');
    await this.db.prepare(`UPDATE divination_draws SET seen_at = ?
      WHERE account_id = ? AND id = ? AND interpretation IS NOT NULL AND seen_at IS NULL`).run(this.now(), account, id);
  }

  async interpret(coo: string, player: string, id: string, text: string): Promise<'recorded' | 'expired'> {
    const now = this.now();
    const draw = await this.db.prepare(`SELECT drawn_at FROM divination_draws
      WHERE id = ? AND coo_id = ? AND player_coo_id = ? AND interpretation IS NULL FOR UPDATE`)
      .get<{ drawn_at: number }>(id, coo, player);
    if (!draw) throw new HttpError(409, '这支签无法解读，可能已解过或收件人不对');
    if (draw.drawn_at <= now - REPLY_TIME_MS) return 'expired';
    if ([...text].length < 1 || [...text].length > 600) throw new HttpError(400, '解签须为 1–600 字');
    const updated = await this.db.prepare(`UPDATE divination_draws SET interpretation = ?, interpreted_at = ?
      WHERE id = ? AND coo_id = ? AND player_coo_id = ? AND interpretation IS NULL`)
      .run(text, now, id, coo, player);
    if (!updated.changes) throw new HttpError(409, '这支签已解过');
    return 'recorded';
  }

  async chat(): Promise<DivinationChatMessage[]> {
    const rows = await this.db.prepare(`SELECT seq, data_json->>'name' AS name, text, ts AS time FROM events
      WHERE room_id = ? AND scope_kind = 'room' AND type = 'parlor.say' ORDER BY seq DESC LIMIT 40`)
      .all<DivinationChatMessage>(DIVINATION_ROOM);
    return rows.reverse();
  }

  async say(name: string, value: unknown): Promise<void> {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || [...text].length > 200) throw new HttpError(400, '发言须为 1–200 字');
    await this.sayIn(DIVINATION_ROOM, name, text, this.now());
  }

  private sayIn(room: string, name: string, text: string, time: number, head = false) {
    return new EventDb(this.db, () => this.onCommit(room)).append(room, {
      type: 'parlor.say', ts: time, from: 'system', scope: { kind: 'room' }, text,
      data: { name, ...(head ? { divination: true } : {}) },
    });
  }
}
