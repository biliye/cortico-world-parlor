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
let inboxCalls: Array<{ topics: string[]; afterPublish: number; afterId: string; room?: string }>;
/** 模拟回退到 0.38.0：inbox 路由不存在。 */
let inboxFails = false;
/** 拿到 ctx.cfg 的引用，热更新用例要在 start 之后改。 */
let cfg: Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-09T02:00:00Z'));
  dir = mkdtempSync(join(tmpdir(), 'parlor-world-inbox-'));
  seq = 1;
  inboxQueue = [];
  inboxCalls = [];
  inboxFails = false;
  vi.spyOn(ParlorClient.prototype, 'inbox').mockImplementation(async (_token, query) => {
    inboxCalls.push(query);
    if (inboxFails) throw new ParlorHttpError(404, '没有这个反馈通道地址');
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
  cfg = ctx.cfg as unknown as Record<string, unknown>;
  tune?.(cfg);
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

describe('说书厅搭便车', () => {
  const story = { id: 'story-a', speaker: '阿岚', title: '桥边的灯', endsAt: 1_000_000 };

  beforeEach(() => {
    vi.mocked(ParlorClient.prototype.initializeIdentity).mockImplementation(async function (this: ParlorClient) {
      this.storySupported = true;
      return true;
    });
    vi.spyOn(ParlorClient.prototype, 'storyNotice').mockResolvedValue({ now: 0, queued: false, readyUntil: null, round: null });
  });

  it('同场只挂一条搭便车，渲染时复核，重启后也不重复', async () => {
    const deferred = vi.spyOn(FakeHost.prototype, 'pushDeferred');
    inboxQueue = [{ story }, { story }];
    await start();
    expect(inboxCalls[0].topics).toContain('story');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deferred).toHaveBeenCalledTimes(1);
    const [event, options] = deferred.mock.calls[0];
    expect(options?.trigger).toBe('piggyback');
    expect(host.events.some(item => item.text.includes('要不要去听听'))).toBe(false);

    inboxQueue = [{ story }];
    expect(await event.render()).toContain('阿岚 正在讲《桥边的灯》。要不要去听听？');
    expect(inboxCalls.at(-1)?.topics).toEqual(['story']);
    await world.stop();
    inboxQueue = [{ story }];
    await start();
    expect(deferred).toHaveBeenCalledTimes(1);
  });

  it('排队期间散场、换场或静音时不投递', async () => {
    const deferred = vi.spyOn(FakeHost.prototype, 'pushDeferred');
    inboxQueue = [{ story }, { story: null }];
    await start();
    expect(await deferred.mock.calls[0][0].render()).toBeNull();

    const next = { ...story, id: 'story-b' };
    inboxQueue = [{ story: next }, { story: { ...next, id: 'story-c' } }];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await deferred.mock.calls[1][0].render()).toBeNull();

    inboxQueue = [{ story: next }];
    await vi.advanceTimersByTimeAsync(60_000);
    cfg.wakeTier = 'off';
    const calls = inboxCalls.length;
    expect(await deferred.mock.calls[2][0].render()).toBeNull();
    expect(inboxCalls).toHaveLength(calls);
  });

  it('旧场的搭便车回调还没执行时，新场也能挂单并正常投递', async () => {
    const deferred = vi.spyOn(FakeHost.prototype, 'pushDeferred');
    const first = { ...story, endsAt: Date.now() + 600_000 };
    const next = { ...first, id: 'story-b', title: '灯下的人' };
    inboxQueue = [{ story: first }, { story: next }];
    await start();
    // 第一场提前散场，没有自然唤醒，也没有宿主回调。
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deferred).toHaveBeenCalledTimes(2);
    const calls = inboxCalls.length;
    expect(await deferred.mock.calls[0][0].render()).toBeNull();
    expect(inboxCalls).toHaveLength(calls);
    inboxQueue = [{ story: next }];
    expect(await deferred.mock.calls[1][0].render()).toContain('《灯下的人》');
  });
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

  it('旧网关没有 inbox：404 回落旧公告接口，并记住不再每轮撞', async () => {
    inboxFails = true;
    const support = vi.spyOn(ParlorClient.prototype, 'support').mockResolvedValue({
      announcements: [{ id: 'ann-legacy', text: '今晚维护', created_at: Date.now() }],
    });
    await start();
    const announced = () => host.events.filter((event) => event.type === 'parlor.announcement');
    expect(announced()).toHaveLength(1);
    expect(announced()[0].text).toContain('今晚维护');

    await vi.advanceTimersByTimeAsync(120_000);
    // 探测结果缓存：之后两轮只走旧公告接口，没有再去撞 inbox。
    expect(inboxCalls).toHaveLength(1);
    expect(support.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(announced()).toHaveLength(1);
  });

  it('服务器升上来以后 10 分钟内自动重探 inbox，不用重启 Coo', async () => {
    inboxFails = true;
    vi.spyOn(ParlorClient.prototype, 'support').mockResolvedValue({ announcements: [] });
    await start();
    expect(inboxCalls).toHaveLength(1);

    inboxFails = false;
    inboxQueue = [{ news: newsEvent('升级后的第一期') }];
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(inboxCalls.length).toBeGreaterThan(1);
    expect(host.events.some((event) => event.type === 'parlor.news' && event.text.includes('升级后的第一期'))).toBe(true);
  });

  it('关掉招募时，已经排在队列里的 discovery 也不再发出去', async () => {
    await start('full');
    emit({ type: 'parlor.say', text: '先说一句' });
    emit({
      type: 'parlor.table.discovery', text: '阿岚 在「五子棋」桌开放了快速匹配（1/2 人）。',
      data: { tableId: 't-1', game: 'gomoku', seats: 1, capacity: 2, matchOpen: true, recruit: false, recruitVersion: 1 },
    });
    // 两条都已经进队列，这时才把开关关掉：交给宿主前还要再筛一次。
    cfg.recruitNotice = false;
    await vi.advanceTimersByTimeAsync(6_000);
    const digest = host.events.find((event) => event.type === 'parlor.digest');
    expect(digest?.text).toContain('先说一句');
    expect(digest?.text).not.toContain('快速匹配');
  });

  it('队列里只剩招募事件时，关掉开关就整次唤醒都不发', async () => {
    await start('full');
    emit({
      type: 'parlor.table.discovery', text: '阿岚 在「五子棋」桌开放了快速匹配（1/2 人）。',
      data: { tableId: 't-1', game: 'gomoku', seats: 1, capacity: 2, matchOpen: true, recruit: false, recruitVersion: 1 },
    });
    cfg.recruitNotice = false;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(host.events.filter((event) => event.type === 'parlor.digest')).toHaveLength(0);
  });

  it('关掉招募时开桌事件照常报，但不再带 join 引导', async () => {
    await start('full');
    emit({
      type: 'parlor.table.open', text: '阿岚 开了一张五子棋桌。',
      data: { game: 'gomoku', tableId: 't-1', matchOpen: true, seats: 1, capacity: 2, recruitVersion: 1 },
    });
    cfg.recruitNotice = false;
    await vi.advanceTimersByTimeAsync(6_000);
    const digest = host.events.find((event) => event.type === 'parlor.digest');
    expect(digest?.text).toContain('开了一张五子棋桌');
    expect(digest?.text).not.toContain('parlor_table {op:"join"');
  });

  it('两次 pushWake 并发时，同一版本只带出一次', async () => {
    inboxQueue = [{ recruit: { tables: [table()] } }, {}];
    await start('full');
    // 第一轮 inbox 已经把候选收进 hint，现在让第一次推送卡在宿主前面。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let carried = 0;
    const original = host.pushEvent.bind(host);
    host.pushEvent = async (event, opts) => {
      if (event.text.includes('桌在等人')) { carried++; await gate; }
      return original(event, opts);
    };

    emit({ type: 'parlor.say', text: '第一句' });
    await vi.advanceTimersByTimeAsync(6_000);
    // 第一个 pushWake 占住了 hint 并挂起；第二个（点名私聊直接投递）不能把同一版本再带一次。
    emit({ type: 'parlor.whisper', text: '悄悄话', from: 'other', scope: { kind: 'seat', seatId: 'mine' } });
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(carried).toBe(1);
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

  it('热切 off 挡在投递口：服务端确认前队列留着，恢复后补投一次', async () => {
    await start('full');
    emit({
      type: 'parlor.table.discovery', text: '阿岚 在「五子棋」桌开放了快速匹配（1/2 人）。',
      data: { tableId: 't-1', game: 'gomoku', seats: 1, capacity: 2, matchOpen: true, recruit: true, recruitVersion: 1 },
    });
    emit({ type: 'parlor.say', text: '顺带一句' });
    // 事件已经排进队列、合并窗口还没到，这时把总闸关上：席位档位要等下一次
    // reconcileTier 才同步，不能指望它已经生效。
    cfg.wakeTier = 'off';
    await vi.advanceTimersByTimeAsync(6_000);
    expect(host.events.filter((event) => event.type === 'parlor.digest')).toHaveLength(0);

    // 这里只是「服务端还没确认 off」的窗口：档位一直没推成功，队列才留得住。
    // 确认之后本地队列会被清空，那批不再补投（见下一条用例）。
    cfg.wakeTier = 'full';
    await vi.advanceTimersByTimeAsync(60_000);
    const digests = host.events.filter((event) => event.type === 'parlor.digest');
    expect(digests).toHaveLength(1);
    expect(digests[0].text).toContain('顺带一句');
    expect(digests[0].text).toContain('开放了快速匹配');
  });

  it('服务端确认 off 之后本地队列清空：那一批不会再补投', async () => {
    vi.spyOn(ParlorClient.prototype, 'action').mockResolvedValue({} as never);
    await start('full');
    emit({ type: 'parlor.say', text: '清空前的这句话' });
    // 摘要定时器到点先同步档位：set_tier 被接受就等于服务端确认了 off，本地队列当场清空。
    cfg.wakeTier = 'off';
    await vi.advanceTimersByTimeAsync(60_000);
    cfg.wakeTier = 'full';
    await vi.advanceTimersByTimeAsync(120_000);
    expect(host.events.filter((event) => event.type === 'parlor.digest')).toHaveLength(0);
  });

  it('开桌即开放匹配后紧接同版本「开放匹配」：事实留两条，join 引导只加一次', async () => {
    await start('full');
    // 开桌就带 matchOpen：服务端在这里写 recruit_version=1，但不会再发 discovery。
    emit({
      type: 'parlor.table.open', text: '阿岚 开了一张五子棋桌。',
      data: { game: 'gomoku', tableId: 't-1', matchOpen: true, seats: 1, capacity: 2, recruitVersion: 1 },
    });
    // 紧接着再提交一次「开放匹配」：状态没变，版本仍是 1。
    emit({
      type: 'parlor.table.discovery', text: '阿岚 在「五子棋」桌开放了快速匹配（1/2 人）。',
      data: { tableId: 't-1', game: 'gomoku', seats: 1, capacity: 2, matchOpen: true, recruit: false, recruitVersion: 1 },
    });
    await vi.advanceTimersByTimeAsync(6_000);
    const digest = host.events.filter((event) => event.type === 'parlor.digest');
    expect(digest).toHaveLength(1);
    // 两条事实都在：开桌那句、开放匹配那句。
    expect(digest[0].text).toContain('开了一张五子棋桌');
    expect(digest[0].text).toContain('开放了快速匹配');
    expect(digest[0].text.split('parlor_table {op:"join"').length - 1).toBe(1);

    // 真的改了招募（版本 +1）就是新提醒，引导照常再补一次。
    emit({
      type: 'parlor.table.discovery', text: '阿岚 在「五子棋」桌发了招募（1/2 人）。',
      data: { tableId: 't-1', game: 'gomoku', seats: 1, capacity: 2, matchOpen: true, recruit: true, recruitVersion: 2 },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const next = host.events.filter((event) => event.type === 'parlor.digest');
    expect(next).toHaveLength(2);
    expect(next[1].text).toContain('发了招募');
    expect(next[1].text).toContain('有招募原话');
    expect(next[1].text.split('parlor_table {op:"join"').length - 1).toBe(1);
  });

  it('同一桌同一版本的两条招募事件，只补一次加入引导；换版本才再补', async () => {
    await start('full');
    const discovery = {
      type: 'parlor.table.discovery', text: '阿岚 在「五子棋」桌开放了快速匹配（1/2 人）。',
      data: { tableId: 't-1', game: 'gomoku', seats: 1, capacity: 2, matchOpen: true, recruit: true, recruitVersion: 1 },
    };
    // 重连补发会把同一句提示重放一遍：两条都进合并窗口。
    emit(discovery);
    emit(discovery);
    await vi.advanceTimersByTimeAsync(6_000);
    const digest = host.events.filter((event) => event.type === 'parlor.digest');
    expect(digest).toHaveLength(1);
    expect(digest[0].text.split('parlor_table {op:"join"').length - 1).toBe(1);

    // 换了版本（改了招募文案或重新开放匹配）就是新提醒，照常再说一次。
    emit({ ...discovery, data: { ...discovery.data, recruitVersion: 2 } });
    await vi.advanceTimersByTimeAsync(60_000);
    const next = host.events.filter((event) => event.type === 'parlor.digest');
    expect(next).toHaveLength(2);
    expect(next[1].text).toContain('开放了快速匹配');
  });
});
