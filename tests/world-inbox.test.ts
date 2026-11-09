/** inbox 轮询：新闻只补最新一条、招募搭车一次、两条通路的开关与去重。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { PARLOR } from '../src/definition.ts';
import { ParlorClient, ParlorHttpError } from '../src/room/client.ts';
import type { InboxView, RecruitTableHint, RoomEvent, RoomSnapshot, WakeTier } from '../src/room/protocol.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { toolForOperation } from './helpers/tool-operations.ts';

let dir: string;
let world: ReturnType<typeof PARLOR.create>;
let host: FakeHost;
let snapshot: RoomSnapshot;
let receive: (event: RoomEvent) => void;
let seq: number;
let inboxQueue: InboxView[];
let inboxCalls: Array<{ topics: string[]; afterPublish: number; afterId: string }>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-09T02:00:00Z'));
  dir = mkdtempSync(join(tmpdir(), 'parlor-world-inbox-'));
  seq = 1;
  inboxQueue = [];
  inboxCalls = [];
  vi.spyOn(ParlorClient.prototype, 'inbox').mockImplementation(async (_token, query) => {
    inboxCalls.push(query);
    return inboxQueue.shift() ?? {};
  });
  vi.spyOn(ParlorClient.prototype, 'initializeIdentity').mockResolvedValue(true);
  vi.spyOn(ParlorClient.prototype, 'stream').mockImplementation(async (_token, _since, onEvent, signal) => {
    receive = onEvent;
    await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }));
  });
});

afterEach(async () => {
  await world?.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const start = async (tier: WakeTier = 'full', tune?: (cfg: Record<string, unknown>) => void): Promise<void> => {
  const ctx = fakeWorldContext(PARLOR, { scratchDir: dir });
  ctx.cfg.serverUrl = 'http://127.0.0.1:8790';
  ctx.cfg.room = 'hall';
  ctx.cfg.seatName = '小满';
  ctx.cfg.wakeTier = tier;
  tune?.(ctx.cfg as unknown as Record<string, unknown>);
  ctx.secret = (name) => name === 'PARLOR_SEAT_TOKEN' ? 'test-seat-token' : 'inv';
  snapshot = {
    id: 'hall', seat: { id: 'mine', name: '小满', kind: 'pet', tier, joinedAt: Date.now() },
    seats: [], maxSeats: 400, latest: seq, now: Date.now(), at: '测试时刻', events: [], tablePrivate: null,
  };
  vi.spyOn(ParlorClient.prototype, 'snapshot').mockImplementation(async () => snapshot);
  world = PARLOR.create(ctx);
  host = new FakeHost();
  await world.start(host);
  await vi.advanceTimersByTimeAsync(0);
};

const emit = (extra: Partial<RoomEvent> & { type: string }): void => receive({
  seq: ++seq, ts: Date.now(), from: 'system', scope: { kind: 'room' }, text: '', ...extra,
} as RoomEvent);

const newsEvent = (text = '第一期') => ({
  item: { id: 'news-a', issueDate: '2026-11-09', title: text, summary: '摘要', publishAt: Date.now() },
  cursor: { publishAt: Date.now(), id: 'news-a' },
  skipped: 2, capped: false,
});

const table = (over: Partial<RecruitTableHint> = {}): RecruitTableHint => ({
  tableId: 't-1', room: 'r-1', roomName: '茶馆一号', game: 'gomoku',
  seats: 1, capacity: 2, deadlineAt: Date.now() + 3_600_000, recruitVersion: 1, ...over,
});

describe('inbox 轮询', () => {
  it('新闻只推最新一条，把更早的折成 skipped；游标推进后不再重复', async () => {
    inboxQueue = [
      { news: newsEvent() },
      { news: { item: null, cursor: { publishAt: Date.now(), id: 'news-a' }, skipped: 0, capped: false } },
    ];
    await start();
    const pushed = () => host.events.filter((event) => event.type === 'parlor.news');
    expect(pushed()).toHaveLength(1);
    expect(pushed()[0].text).toContain('第一期');
    expect(pushed()[0].text).toContain('另有 2 期');
    expect(pushed()[0].text).toContain('parlor_query {op:"news"}');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pushed()).toHaveLength(1);
  });

  it('关掉新闻时不请求 news、也不推送', async () => {
    inboxQueue = [{ news: newsEvent() }, { news: newsEvent() }];
    await start('full', (cfg) => { cfg.news = false; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(inboxCalls.length).toBeGreaterThan(0);
    expect(inboxCalls.every((call) => !call.topics.includes('news'))).toBe(true);
    expect(host.events.some((event) => event.type === 'parlor.news')).toBe(false);
  });

  it('`wakeTier=off` 是总闸：一次 inbox 都不发', async () => {
    inboxQueue = [{ news: newsEvent() }];
    await start('off');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(inboxCalls).toHaveLength(0);
  });

  it('招募只搭一次自然唤醒，同版本不重复；换版本才会再提', async () => {
    inboxQueue = [
      { recruit: { tables: [table()] } },
      { recruit: { tables: [table()] } },
      { recruit: { tables: [table({ recruitVersion: 2 })] } },
    ];
    await start();
    const digests = () => host.events.filter((event) => event.type === 'parlor.digest');
    expect(digests()).toHaveLength(0);
    emit({ type: 'parlor.say', text: '有人吗' });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(digests()).toHaveLength(1);
    expect(digests()[0].text).toContain('桌在等人');
    expect(digests()[0].text).toContain('茶馆一号（1/2');

    await vi.advanceTimersByTimeAsync(60_000);
    emit({ type: 'parlor.say', text: '还在吗' });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(digests()[1].text).not.toContain('桌在等人');

    await vi.advanceTimersByTimeAsync(60_000);
    emit({ type: 'parlor.say', text: '再来一局' });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(digests()[2].text).toContain('桌在等人');
  });

  it('关掉招募提示后，同厅 discovery 事件也不进待发队列', async () => {
    await start('full', (cfg) => { cfg.recruitNotice = false; });
    emit({
      type: 'parlor.table.discovery', text: '阿岚 在「五子棋」桌开放了快速匹配（1/2 人）。',
      data: { tableId: 't-1', game: 'gomoku', seats: 1, capacity: 2, matchOpen: true, recruit: false, recruitVersion: 1 },
    });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(host.events.some((event) => event.type === 'parlor.digest')).toBe(false);
  });

  it('开桌即开放匹配：桌外 Coo 也能收到，并带 join 提示', async () => {
    await start('full');
    emit({
      type: 'parlor.table.open', text: '阿岚 开了一张五子棋桌。',
      data: { game: 'gomoku', tableId: 't-1', matchOpen: true, seats: 1, capacity: 2, recruitVersion: 1 },
    });
    await vi.advanceTimersByTimeAsync(6_000);
    const digest = host.events.find((event) => event.type === 'parlor.digest');
    expect(digest?.text).toContain('开了一张五子棋桌');
    expect(digest?.text).toContain('parlor_table {op:"join",params:{game:"gomoku"}}');
  });

  it('同厅事件先说过的桌，inbox 搭车不再重复提同一版本', async () => {
    inboxQueue = [{}, { recruit: { tables: [table()] } }];
    await start();
    emit({
      type: 'parlor.table.discovery', text: '阿岚 在「五子棋」桌开放了快速匹配（1/2 人）。',
      data: { tableId: 't-1', game: 'gomoku', seats: 1, capacity: 2, matchOpen: true, recruit: true, recruitVersion: 1 },
    });
    await vi.advanceTimersByTimeAsync(6_000);
    const digests = () => host.events.filter((event) => event.type === 'parlor.digest');
    expect(digests()).toHaveLength(1);
    expect(digests()[0].text).toContain('开放了快速匹配');
    expect(digests()[0].text).not.toContain('桌在等人');

    // 第二轮 inbox 带回同一张桌的同一版本：已经由事件说过，不再搭一行。
    await vi.advanceTimersByTimeAsync(60_000);
    emit({ type: 'parlor.say', text: '还在吗' });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(digests()).toHaveLength(2);
    expect(digests()[1].text).not.toContain('桌在等人');
  });

  it('inbox 先说过的版本，同厅事件不再进队列', async () => {
    inboxQueue = [{ recruit: { tables: [table({ recruitVersion: 2 })] } }, {}];
    await start();
    emit({ type: 'parlor.say', text: '先聊一句' });
    await vi.advanceTimersByTimeAsync(6_000);
    const digests = () => host.events.filter((event) => event.type === 'parlor.digest');
    expect(digests()[0].text).toContain('桌在等人');

    emit({
      type: 'parlor.table.discovery', text: '阿岚 在「五子棋」桌开放了快速匹配（1/2 人）。',
      data: { tableId: 't-1', game: 'gomoku', seats: 1, capacity: 2, matchOpen: true, recruit: true, recruitVersion: 2 },
    });
    emit({ type: 'parlor.say', text: '再说一句' });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(digests()).toHaveLength(2);
    expect(digests()[1].text).not.toContain('快速匹配');
  });

  it('同一批里事件已经说过的桌，不再追加搭车行', async () => {
    inboxQueue = [{}, { recruit: { tables: [table({ recruitVersion: 1 })] } }];
    await start();
    // 第二轮 inbox 先把候选收进 hint，但还没有自然唤醒。
    await vi.advanceTimersByTimeAsync(60_000);
    emit({
      type: 'parlor.table.discovery', text: '阿岚 在「五子棋」桌开放了快速匹配（1/2 人）。',
      data: { tableId: 't-1', game: 'gomoku', seats: 1, capacity: 2, matchOpen: true, recruit: true, recruitVersion: 1 },
    });
    emit({ type: 'parlor.say', text: '顺带一句' });
    await vi.advanceTimersByTimeAsync(6_000);
    const digest = host.events.find((event) => event.type === 'parlor.digest');
    expect(digest?.text).toContain('开放了快速匹配');
    expect(digest?.text).not.toContain('桌在等人');
  });

  it('主动查新闻：默认给全文，list 给目录，没到时间与旧网关都说清楚', async () => {
    await start();
    const queries: Array<Record<string, unknown>> = [];
    const news = vi.spyOn(ParlorClient.prototype, 'news').mockImplementation(async (_token, query) => {
      const asked = query ?? {};
      queries.push(asked as Record<string, unknown>);
      if (asked.list) {
        return { news: [{ id: 'news-a', issueDate: '2026-11-09', title: '第一期', summary: '摘要', publishAt: 1 }] };
      }
      if (asked.id === 'missing') return { news: null };
      return {
        news: {
          id: 'news-a', issueDate: '2026-11-09', title: '第一期', summary: '摘要',
          publishAt: 1, body: '今天的正文', autoPush: true,
        },
      };
    });
    const call = (params: Record<string, unknown>) => toolForOperation(world, 'parlor_query')
      .handler({ op: 'news', params }, {} as never);

    expect(await call({})).toContain('今天的正文');
    expect(queries.at(-1)).toEqual({});
    const listed = await call({ list: true });
    expect(listed).toContain('第一期');
    expect(listed).toContain('parlor_query {op:"news",params:{id:"<新闻编号>"}}');
    expect(await call({ id: 'missing' })).toContain('没有找到新闻 missing');

    // 旧网关没有这条路由：要说是版本问题，别让 Coo 以为「今天没新闻」。
    news.mockRejectedValueOnce(new ParlorHttpError(404, '没有这个反馈通道地址'));
    expect(await call({})).toContain('还没有新闻板块');
  });
});
