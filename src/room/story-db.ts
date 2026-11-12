import { randomUUID } from 'node:crypto';
import { withTransaction, type Db } from './db.ts';
import { resolveGift } from './gifts/catalog.ts';
import { LedgerDb } from './ledger-db.ts';
import {
  STORY_CHAT_LIMIT, STORY_DRAW_SIZE, STORY_NOTE_LIMIT, STORY_PART_LIMIT, STORY_QUEUE_MS, STORY_RETENTION_MS,
  STORY_TALK_MS, STORY_TITLE_LIMIT, STORY_TOTAL_MS,
  type StoryArchive, type StoryChatPage, type StoryCursor, type StoryLiveHint, type StoryNotice,
  type StoryPage, type StoryPart, type StoryState,
} from './story-protocol.ts';

type StoryActor = { id: string; name: string };
type QueueRow = { coo_id: string; queued_at: number; ready_at: number | null };
type RoundRow = {
  id: string; speaker_id: string; speaker_name: string; title: string;
  started_at: number; notes_at: number; ends_at: number; ended_at: number | null;
  part_count: number; snack_count: number; batch_ready: number;
};
type Note = { coo_id: string; name: string; text: string };
type ChatRound = Pick<RoundRow, 'id' | 'speaker_name' | 'title'>;

function confirmationDeadline(entry: QueueRow | undefined, now: number): number | null {
  if (entry?.ready_at == null) return null;
  const until = entry.ready_at + STORY_QUEUE_MS;
  return until > now ? until : null;
}

export class StoryError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function text(value: unknown, max: number, label: string): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || [...result].length > max) throw new StoryError(400, `${label}须为 1–${max} 字`);
  return result;
}

function summary(row: RoundRow) {
  return {
    id: row.id, speaker: row.speaker_name, title: row.title, startedAt: row.started_at,
    endedAt: row.ended_at!, snacks: row.snack_count,
  };
}

export class StoryDb {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly ledgerRoom: () => string;

  constructor(db: Db, now: () => number, ledgerRoom: () => string) {
    this.db = db;
    this.now = now;
    this.ledgerRoom = ledgerRoom;
  }

  private current() {
    return this.db.prepare('SELECT * FROM story_rounds WHERE ended_at IS NULL').get<RoundRow>();
  }

  private head() {
    return this.db.prepare('SELECT * FROM story_queue ORDER BY queued_at, coo_id LIMIT 1').get<QueueRow>();
  }

  private parts(id: string, after = 0) {
    return this.db.prepare('SELECT seq, text FROM story_parts WHERE round_id = ? AND seq > ? ORDER BY seq')
      .all<StoryPart>(id, after);
  }

  private draw(id: string) {
    return this.db.prepare('SELECT coo_id, name, text FROM story_notes WHERE round_id = ? ORDER BY draw, coo_id LIMIT ?')
      .all<Note>(id, STORY_DRAW_SIZE);
  }

  private async batch(round: RoundRow): Promise<Note[]> {
    // 等截止前已拿到台席锁的投稿提交，再读取按固定随机顺序排出的同一批纸条。
    if (!round.batch_ready) await this.tick();
    return this.draw(round.id);
  }

  async notice(actor: string): Promise<StoryNotice> {
    const now = this.now();
    const round = await this.db.prepare(
      'SELECT * FROM story_rounds WHERE ended_at IS NULL AND ends_at > ? AND speaker_id = ?',
    ).get<RoundRow>(now, actor);
    const queued = await this.db.prepare('SELECT ready_at FROM story_queue WHERE coo_id = ?').get<QueueRow>(actor);
    return {
      now, queued: !!queued, readyUntil: confirmationDeadline(queued, now),
      round: round ? {
        id: round.id, notesAt: round.notes_at, endsAt: round.ends_at, snacks: round.snack_count,
        batch: now >= round.notes_at ? (await this.batch(round)).map(({ name, text }) => ({ name, text })) : null,
      } : null,
    };
  }

  async liveHint(actor: string): Promise<StoryLiveHint | null> {
    const row = await this.db.prepare(`
      SELECT id, speaker_name, title, ends_at FROM story_rounds r
      WHERE ended_at IS NULL AND ends_at > ? AND part_count > 0 AND speaker_id <> ?
        AND NOT EXISTS (SELECT 1 FROM story_attendance a WHERE a.round_id = r.id AND a.coo_id = ?)
    `).get<Pick<RoundRow, 'id' | 'speaker_name' | 'title' | 'ends_at'>>(this.now(), actor, actor);
    return row ? { id: row.id, speaker: row.speaker_name, title: row.title, endsAt: row.ends_at } : null;
  }

  private latestFinished(now: number, current?: RoundRow): Promise<ChatRound | undefined> {
    // 即使时钟还没落库，读到的空台也应当关联刚到期的场次。
    if (current && current.ends_at <= now && current.ends_at > now - STORY_RETENTION_MS && current.part_count > 0) {
      return Promise.resolve(current);
    }
    return this.db.prepare(`
      SELECT id, speaker_name, title FROM story_rounds
      WHERE ended_at > ? AND part_count > 0 ORDER BY ended_at DESC, started_at DESC, id DESC LIMIT 1
    `).get<ChatRound>(now - STORY_RETENTION_MS);
  }

  private async chatPage(round: ChatRound | undefined, now: number, before?: number): Promise<StoryChatPage> {
    const rows = await this.db.prepare(`
      SELECT seq, name, text FROM story_chat
      WHERE ${round ? 'round_id = ?' : 'round_id IS NULL'} AND created_at > ?
        ${before === undefined ? '' : 'AND seq < ?'} ORDER BY seq DESC LIMIT 21
    `).all<StoryChatPage['messages'][number]>(
      ...(round ? [round.id] : []), now - STORY_RETENTION_MS, ...(before === undefined ? [] : [before]),
    );
    const messages = rows.slice(0, 20).reverse();
    return { round: round ? { id: round.id, speaker: round.speaker_name, title: round.title } : null,
      messages, before: rows.length > messages.length ? messages[0].seq : null };
  }

  async discussion(id?: string, before?: number): Promise<StoryChatPage> {
    const now = this.now();
    if (id) {
      const round = await this.db.prepare(`
        SELECT id, speaker_name, title FROM story_rounds
        WHERE id = ? AND part_count > 0 AND (ended_at > ? OR (ended_at IS NULL AND ends_at > ? AND ends_at <= ?))
      `).get<ChatRound>(id, now - STORY_RETENTION_MS, now - STORY_RETENTION_MS, now);
      if (!round) throw new StoryError(404, '这场说书已过期或找不到');
      return this.chatPage(round, now, before);
    }
    const current = await this.current();
    if (current && current.ends_at > now) throw new StoryError(409, '台上正在说书，现场聊天暂时关闭');
    return this.chatPage(await this.latestFinished(now, current), now, before);
  }

  private attend(round: string, actor: string) {
    return this.db.prepare('INSERT INTO story_attendance (round_id, coo_id) VALUES (?, ?) ON CONFLICT DO NOTHING')
      .run(round, actor);
  }

  async state(actor?: string, roundId?: string, after = 0): Promise<StoryState> {
    const now = this.now();
    const [current, head] = await Promise.all([this.current(), this.head()]);
    const round = current && current.ends_at > now ? current : undefined;
    const queued = actor ? await this.db.prepare('SELECT * FROM story_queue WHERE coo_id = ?').get<QueueRow>(actor) : undefined;
    const position = queued ? await this.db.prepare(`
      SELECT COUNT(*) AS ahead FROM story_queue
      WHERE queued_at < ? OR (queued_at = ? AND coo_id < ?)
    `).get<{ ahead: number }>(queued.queued_at, queued.queued_at, queued.coo_id) : undefined;
    const queue = {
      position: position ? Number(position.ahead) + 1 : null,
      readyUntil: confirmationDeadline(queued, now),
      open: !round && !head,
    };
    if (!round) return { now, queue, round: null,
      ...(actor ? { chat: await this.chatPage(await this.latestFinished(now, current), now) } : {}) };
    const id = round.id;
    const speaking = actor === round.speaker_id;
    const notesOpen = now < round.notes_at;
    const [parts, attendance, note, snack] = await Promise.all([
      this.parts(id, id === roundId ? after : 0),
      actor ? this.db.prepare('SELECT 1 FROM story_attendance WHERE round_id = ? AND coo_id = ?').get(id, actor) : null,
      actor && !speaking ? this.db.prepare('SELECT text FROM story_notes WHERE round_id = ? AND coo_id = ?')
        .get<{ text: string }>(id, actor) : null,
      actor && !speaking ? this.db.prepare('SELECT 1 FROM story_snacks WHERE round_id = ? AND coo_id = ?').get(id, actor) : null,
    ]);
    const picked = !notesOpen && (speaking || note) ? await this.batch(round) : null;
    return {
      now, queue, round: {
        id, speaker: round.speaker_name, title: round.title, startedAt: round.started_at,
        notesAt: round.notes_at, endsAt: round.ends_at, speaking, listening: !!attendance,
        parts, snacks: round.snack_count, sentSnack: !!snack,
        note: note ? { text: note.text, status: notesOpen ? 'waiting' : picked!.some(row => row.coo_id === actor) ? 'delivered' : 'skipped' } : null,
        batch: speaking && picked ? picked.map(({ name, text }) => ({ name, text })) : null,
      },
    };
  }

  private async advance(now: number): Promise<RoundRow | undefined> {
    const round = await this.current();
    if (round && round.ends_at > now) {
      if (now >= round.notes_at && !round.batch_ready) {
        await this.db.prepare('UPDATE story_rounds SET batch_ready = 1 WHERE id = ?').run(round.id);
        round.batch_ready = 1;
      }
      return round;
    }
    if (round) {
      await this.db.prepare('UPDATE story_rounds SET ended_at = ends_at WHERE id = ?').run(round.id);
    }
    const head = await this.head();
    if (head && head.ready_at !== null && head.ready_at + STORY_QUEUE_MS <= now) {
      await this.db.prepare('DELETE FROM story_queue WHERE coo_id = ?').run(head.coo_id);
    }
    await this.offerNext(now);
    return undefined;
  }

  private async offerNext(now: number) {
    const head = await this.head();
    if (head && head.ready_at === null) {
      await this.db.prepare('UPDATE story_queue SET ready_at = ? WHERE coo_id = ?').run(now, head.coo_id);
    }
  }

  private async lock() {
    // 串行化主讲换班、纸条截止和零食结算。收听和读正文不需要占用这把锁。
    if (this.db.kind === 'postgres') {
      await this.db.prepare('SELECT pg_advisory_xact_lock(836008, 1)').get();
    }
  }

  async tick(): Promise<number | undefined> {
    const [round, head] = await Promise.all([this.current(), this.head()]);
    const now = this.now();
    if (round && (round.batch_ready || round.notes_at > now) && round.ends_at > now) {
      return round.batch_ready ? round.ends_at : round.notes_at;
    }
    if (!round && !head) return undefined;
    if (!round && head?.ready_at != null && head.ready_at + STORY_QUEUE_MS > now) return head.ready_at + STORY_QUEUE_MS;
    return withTransaction(this.db, async () => {
      await this.lock();
      const active = await this.advance(this.now());
      if (active) return active.batch_ready ? active.ends_at : active.notes_at;
      const next = await this.head();
      return next?.ready_at != null ? next.ready_at + STORY_QUEUE_MS : undefined;
    });
  }

  async action(actor: StoryActor, body: Record<string, unknown>): Promise<StoryState> {
    if (body.action === 'listen') {
      const round = text(body.round, 72, '场次编号');
      const found = await this.db.prepare(`
        INSERT INTO story_attendance (round_id, coo_id)
        SELECT id, ? FROM story_rounds WHERE id = ? AND ended_at IS NULL AND ends_at > ?
        ${this.db.kind === 'postgres' ? 'FOR SHARE' : ''}
        ON CONFLICT DO NOTHING
      `).run(actor.id, round, this.now());
      if (!found.changes) {
        const current = await this.current();
        if (current?.id !== round || current.ends_at <= this.now()) throw new StoryError(409, '本场已结束');
      }
      return this.state(actor.id);
    }
    const preview = await withTransaction(this.db, async () => {
      await this.lock();
      const now = this.now();
      const round = await this.advance(now);
      if (body.action === 'chat') {
        if (round) throw new StoryError(409, '台上正在说书，现场聊天暂时关闭');
        await this.sendChat(actor, body, now);
        return;
      }
      if (body.action === 'queue') {
        if (round?.speaker_id === actor.id) throw new StoryError(409, '你正在台上');
        await this.db.prepare('INSERT INTO story_queue (coo_id, queued_at) VALUES (?, ?) ON CONFLICT DO NOTHING')
          .run(actor.id, now);
        if (!round) await this.offerNext(now);
        return;
      }
      if (body.action === 'cancel') {
        await this.db.prepare('DELETE FROM story_queue WHERE coo_id = ?').run(actor.id);
        if (!round) await this.offerNext(now);
        return;
      }
      if (body.action === 'start') {
        if (round?.speaker_id === actor.id) return;
        if (round) throw new StoryError(409, '台上正在说书，可以先排队');
        const head = await this.head();
        if (head && head.coo_id !== actor.id) throw new StoryError(409, '台席正在等候下一位');
        const title = body.title === undefined || body.title === '' ? '无题' : text(body.title, STORY_TITLE_LIMIT, '题目');
        const id = randomUUID();
        await this.db.prepare(`
          INSERT INTO story_rounds (id, speaker_id, speaker_name, title, started_at, notes_at, ends_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, actor.id, actor.name, title, now, now + STORY_TALK_MS, now + STORY_TOTAL_MS);
        await this.attend(id, actor.id);
        await this.db.prepare('DELETE FROM story_queue WHERE coo_id = ?').run(actor.id);
        return;
      }
      if (!round || body.round !== round.id) throw new StoryError(409, '本场已结束');
      if (body.action === 'peek_notes') {
        if (round.speaker_id !== actor.id) throw new StoryError(403, '只有本场说书人能提前看纸条');
        if (now >= round.notes_at) return; // 收尾阶段直接返回正式批次。
        const notes = (await this.draw(round.id)).map(({ name, text }) => ({ name, text }));
        return { round: round.id, notes };
      }
      if (body.action === 'speak' || body.action === 'finish') {
        if (round.speaker_id !== actor.id) throw new StoryError(403, '只有本场说书人能在台上发言或结束本场');
        if (body.action === 'finish') {
          await this.db.prepare('UPDATE story_rounds SET ended_at = ? WHERE id = ?').run(now, round.id);
          await this.offerNext(now);
        } else {
          await this.speak(round, body, now);
        }
        return;
      }
      if (round.speaker_id === actor.id) throw new StoryError(403, '请从台上发言');
      if (body.action === 'note') {
        if (now >= round.notes_at) throw new StoryError(409, '本场已经停止收纸条');
        await this.db.prepare(`
          INSERT INTO story_notes (round_id, coo_id, name, text, draw) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (round_id, coo_id) DO UPDATE SET text = excluded.text
        `).run(round.id, actor.id, actor.name, text(body.text, STORY_NOTE_LIMIT, '纸条'), randomUUID());
      } else if (body.action === 'snack') {
        await this.snack(round, actor, body.item);
      } else {
        throw new StoryError(400, '未知说书操作');
      }
      await this.attend(round.id, actor.id);
    });
    const state = await this.state(actor.id);
    return preview && preview.round === state.round?.id ? { ...state, preview } : state;
  }

  private async sendChat(actor: StoryActor, body: Record<string, unknown>, now: number): Promise<void> {
    const round = (await this.latestFinished(now))?.id ?? null;
    if (body.round !== undefined && typeof body.round !== 'string') throw new StoryError(400, '场次编号无效');
    if ((body.round ?? null) !== round) throw new StoryError(409, '讨论场次已变，请刷新后再发');
    const message = text(body.text, STORY_CHAT_LIMIT, '聊天消息');
    const requestId = text(body.requestId, 72, '发言编号');
    const inserted = await this.db.prepare(`
      INSERT INTO story_chat (round_id, coo_id, name, text, request_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (coo_id, request_id) DO NOTHING
    `).run(round, actor.id, actor.name, message, requestId, now);
    if (!inserted.changes) {
      const previous = await this.db.prepare('SELECT round_id, text FROM story_chat WHERE coo_id = ? AND request_id = ?')
        .get<{ round_id: string | null; text: string }>(actor.id, requestId);
      if (previous?.round_id !== round || previous.text !== message) throw new StoryError(409, '这个发言编号已用于另一条消息');
    }
  }

  private async speak(round: RoundRow, body: Record<string, unknown>, now: number) {
    const requestId = text(body.requestId, 72, '发言编号');
    const part = text(body.text, STORY_PART_LIMIT, '一段发言');
    const previous = await this.db.prepare('SELECT text FROM story_parts WHERE round_id = ? AND request_id = ?')
      .get<{ text: string }>(round.id, requestId);
    if (previous) {
      if (previous.text !== part) throw new StoryError(409, '这个发言编号已用于另一段文字');
      return;
    }
    // 给收尾保留发言空间，同时限制单场正文和补档响应大小。
    if (round.part_count >= (now < round.notes_at ? 56 : 64)) throw new StoryError(409, '当前阶段的发言段数已用完');
    await this.db.prepare('INSERT INTO story_parts (round_id, seq, request_id, text) VALUES (?, ?, ?, ?)')
      .run(round.id, round.part_count + 1, requestId, part);
    await this.db.prepare('UPDATE story_rounds SET part_count = part_count + 1 WHERE id = ?').run(round.id);
  }

  private async snack(round: RoundRow, actor: StoryActor, item: unknown) {
    const gift = resolveGift(item).item;
    if (!gift || gift.kind !== 'snack') throw new StoryError(400, '请从零食单选一份小零食');
    const receipt = await this.db.prepare('SELECT item FROM story_snacks WHERE round_id = ? AND coo_id = ?')
      .get<{ item: string }>(round.id, actor.id);
    if (receipt) {
      if (receipt.item !== gift.id) throw new StoryError(409, '你本场已经投喂过一份零食');
      return;
    }
    await this.db.prepare('INSERT INTO story_snacks (round_id, coo_id, item) VALUES (?, ?, ?)')
      .run(round.id, actor.id, gift.id);
    await new LedgerDb(this.db, { now: this.now }).record({
      kind: 'gift', room: this.ledgerRoom(), from: actor.id, to: round.speaker_id, text: `在说书厅送了一份${gift.name}`,
      visibility: 'private', data: { fromName: actor.name, toName: round.speaker_name, itemId: gift.id, itemName: gift.name },
    });
    await this.db.prepare('UPDATE story_rounds SET snack_count = snack_count + 1 WHERE id = ?').run(round.id);
  }

  async history(actor?: string, cursor?: StoryCursor, forward = false): Promise<StoryPage> {
    const direction = forward ? 'ASC' : 'DESC';
    const comparison = forward ? '>' : '<';
    const values: Array<number | string> = [this.now() - STORY_RETENTION_MS];
    let filter = 'r.ended_at > ? AND r.part_count > 0';
    if (actor) {
      filter += ' AND EXISTS (SELECT 1 FROM story_attendance a WHERE a.round_id = r.id AND a.coo_id = ?)';
      values.push(actor);
    }
    if (cursor) {
      filter += ` AND (r.ended_at ${comparison} ? OR (r.ended_at = ? AND r.id ${comparison} ?))`;
      values.push(cursor.endedAt, cursor.endedAt, cursor.id);
    }
    const rows = await this.db.prepare(`
      SELECT r.* FROM story_rounds r WHERE ${filter} ORDER BY r.ended_at ${direction}, r.id ${direction} LIMIT 21
    `).all<RoundRow>(...values);
    const rounds = rows.slice(0, 20).map(summary);
    const last = rounds.at(-1);
    return { rounds, next: rows.length > 20 && last ? { endedAt: last.endedAt, id: last.id } : null };
  }

  async archive(id: string, actor?: string): Promise<StoryArchive> {
    const row = await this.db.prepare('SELECT * FROM story_rounds WHERE id = ? AND ended_at > ? AND part_count > 0')
      .get<RoundRow>(id, this.now() - STORY_RETENTION_MS);
    if (!row || (actor && !await this.db.prepare('SELECT 1 FROM story_attendance WHERE round_id = ? AND coo_id = ?').get(id, actor))) {
      throw new StoryError(404, '这场说书已过期或找不到');
    }
    return { ...summary(row), parts: await this.parts(id) };
  }

  async prune(now: number): Promise<void> {
    await this.db.prepare('DELETE FROM story_chat WHERE created_at <= ?').run(now - STORY_RETENTION_MS);
    await this.db.prepare('DELETE FROM story_rounds WHERE ended_at <= ?').run(now - STORY_RETENTION_MS);
  }
}
