import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ api: vi.fn(), toast: vi.fn() }));
vi.mock('../web-src/api/client.ts', () => ({
  api: mocks.api, scopedPath: (path: string) => path, takeKeyFromHash: () => null,
  beginGlobalEntry: vi.fn(), finishGlobalEntry: vi.fn(), parentPlay: vi.fn(),
}));
vi.mock('../web-src/stores/chat.ts', () => ({ noteChatEvent: vi.fn(), resetChatState: vi.fn() }));
vi.mock('../web-src/stores/dm.ts', () => ({ noteWhisper: vi.fn(), resetDmState: vi.fn() }));
vi.mock('../web-src/stores/ui.ts', () => ({ showToast: mocks.toast }));
vi.mock('../web-src/stores/session.ts', async () => {
  const { ref } = await import('vue');
  return { seat: ref(null), saveSeat: vi.fn(), clearSeat: vi.fn(), readStoredSeat: vi.fn() };
});
vi.mock('../web-src/stores/view.ts', async () => {
  const { ref } = await import('vue');
  return { watchTableId: ref(''), backToRoom: vi.fn(), enterTable: vi.fn() };
});

class Stream {
  static last: Stream;
  onmessage?: (message: { data: string }) => void;
  constructor() { Stream.last = this; }
  close() {}
  emit(seq: number, type = 'parlor.table.action') { this.onmessage?.({ data: JSON.stringify({ seq, type }) }); }
}
const table = (revision: number, id = 't1') => ({ game: 'ddz', status: 'playing', tableId: id, revision });
const patch = (revision: number, seq = revision) => ({
  ok: true, seq, table: table(revision), tablePrivate: { tableId: 't1', revision, hand: ['3'] },
});
const snap = (revision = 1) => ({
  id: 'room1', now: 0, latest: revision, table: table(revision), tables: [table(revision), table(10, 'other')],
  tablePrivate: { tableId: 't1', revision, hand: ['4'] }, ledger: { balance: 100 },
});
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let store: any;
let session: any;
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  vi.stubGlobal('EventSource', Stream);
  mocks.api.mockReset(); mocks.toast.mockReset();
  // 计算式 import 让 Node 侧 tsconfig 不把整套 DOM 源码纳入服务端类型检查。
  const sessionPath = '../web-src/stores/session.ts';
  const storePath = '../web-src/stores/parlor.ts';
  session = await import(sessionPath);
  store = await import(storePath);
  session.seat.value = { token: 'test-token', room: 'room1', seatId: 's1', cooId: 'c1' };
  store.snapshot.value = snap();
});
afterEach(() => { store.disconnect(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const roomCalls = () => mocks.api.mock.calls.filter(([path]) => path === '/v1/room?limit=1');
const tableCalls = () => mocks.api.mock.calls.filter(([path]) => path === '/v1/table');

describe('E3：直接应用回执并合并牌桌 SSE', () => {
  it('有增量只发 POST，更新桌和本人私视图，保留其他桌和账本', async () => {
    mocks.api.mockResolvedValue(patch(2));
    await store.act({ type: 'ddz_action', move: 'play', cards: ['4'] });
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(store.snapshot.value.table.revision).toBe(2);
    expect(store.snapshot.value.tablePrivate.hand).toEqual(['3']);
    expect(store.snapshot.value.tables.find((entry: any) => entry.tableId === 'other').revision).toBe(10);
    expect(store.snapshot.value.ledger.balance).toBe(100);
  });

  it('自己动作的 SSE 先到也等回执覆盖，不重复拉 room 或 table', async () => {
    const post = deferred();
    mocks.api.mockReturnValue(post.promise);
    store.connect();
    const action = store.act({ type: 'ddz_action', move: 'pass' });
    Stream.last.emit(2); Stream.last.emit(3, 'parlor.table.turn');
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.api).toHaveBeenCalledTimes(1);
    post.resolve(patch(2, 3));
    await action;
    await vi.advanceTimersByTimeAsync(500);
    expect(roomCalls()).toHaveLength(0);
    expect(tableCalls()).toHaveLength(0);
  });

  it('其他人的一批牌桌事件只拉一次 table 增量', async () => {
    mocks.api.mockResolvedValue({ ...patch(3), tables: [table(3)] });
    store.connect();
    Stream.last.emit(2); Stream.last.emit(3, 'parlor.table.turn');
    await vi.advanceTimersByTimeAsync(300);
    expect(tableCalls()).toHaveLength(1);
    expect(roomCalls()).toHaveLength(0);
    expect(store.snapshot.value.table.revision).toBe(3);
  });

  it('在途旧 table 响应不能覆盖更新的动作回执', async () => {
    const old = deferred();
    mocks.api.mockImplementation((path) => path === '/v1/table' ? old.promise : Promise.resolve(patch(4)));
    store.connect(); Stream.last.emit(2);
    await vi.advanceTimersByTimeAsync(120);
    await store.act({ type: 'ddz_action', move: 'pass' });
    old.resolve(patch(2));
    await vi.advanceTimersByTimeAsync(300);
    expect(store.snapshot.value.table.revision).toBe(4);
    expect(store.snapshot.value.tablePrivate.revision).toBe(4);
  });

  it('在途旧 room 响应也不能覆盖更新的回执', async () => {
    const old = deferred();
    mocks.api.mockImplementation(path => path === '/v1/room?limit=1' ? old.promise : Promise.resolve(patch(4)));
    const refresh = store.refreshSnapshot();
    await store.act({ type: 'ddz_action', move: 'pass' });
    old.resolve(snap(1));
    await refresh;
    expect(store.snapshot.value.table.revision).toBe(4);
  });

  it('拒绝较低 revision 的桌、列表行和私视图', async () => {
    store.snapshot.value = snap(10);
    mocks.api.mockResolvedValue({ ...patch(2), tables: [table(2), table(1, 'other')] });
    await store.act({ type: 'ddz_action', move: 'pass' });
    expect(store.snapshot.value.table.revision).toBe(10);
    expect(store.snapshot.value.tablePrivate.revision).toBe(10);
    expect(store.snapshot.value.tables.map((entry: any) => entry.revision)).toEqual([10, 10]);
  });

  it('换身份后的迟到回执不污染新席位，也不触发成功清理', async () => {
    const post = deferred(); mocks.api.mockReturnValue(post.promise);
    const action = store.act({ type: 'ddz_action', move: 'pass' });
    session.seat.value = { ...session.seat.value, token: 'new-token', room: 'room2' };
    store.snapshot.value = { ...snap(9), id: 'room2' };
    post.resolve(patch(2));
    expect(await action).toBeNull();
    expect(store.snapshot.value.id).toBe('room2');
    expect(store.snapshot.value.table.revision).toBe(9);
  });

  it('桌消失时的明确 null 清掉桌与本人私视图', async () => {
    mocks.api.mockResolvedValue({ ok: true, seq: 2, table: null, tablePrivate: null, tables: [] });
    await store.act({ type: 'table_leave' });
    expect(store.snapshot.value.table).toBeNull();
    expect(store.snapshot.value.tablePrivate).toBeNull();
    expect(store.snapshot.value.tables).toEqual([]);
  });

  it('非牌桌动作仍取完整快照', async () => {
    mocks.api.mockImplementation(path => Promise.resolve(path === '/v1/action' ? { ok: true, seq: 2 } : snap(2)));
    await store.act({ type: 'say', text: 'hello' });
    expect(roomCalls()).toHaveLength(1);
    expect(store.snapshot.value.table.revision).toBe(2);
  });

  it('旧服务器无 table 接口时回退一次完整快照', async () => {
    mocks.api.mockImplementation(path => path === '/v1/table'
      ? Promise.reject(Object.assign(new Error('not found'), { status: 404 })) : Promise.resolve(snap(2)));
    store.connect(); Stream.last.emit(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(tableCalls()).toHaveLength(1);
    expect(roomCalls()).toHaveLength(1);
  });

  it('网络不确定时仍沿用同一个 requestId 重试', async () => {
    mocks.api.mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(patch(2));
    await store.act({ type: 'ddz_action', move: 'pass' });
    const bodies = mocks.api.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies).toHaveLength(2);
    expect(bodies[0].requestId).toBeTruthy();
    expect(bodies[0]).toEqual(bodies[1]);
  });

  it('table 接口只返回 ok 时也回退完整快照，不误标已同步', async () => {
    mocks.api.mockImplementation(path => Promise.resolve(path === '/v1/table' ? { ok: true } : snap(2)));
    store.connect(); Stream.last.emit(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(tableCalls()).toHaveLength(1);
    expect(roomCalls()).toHaveLength(1);
    expect(store.snapshot.value.table.revision).toBe(2);
  });

  it('409 后后台补快照，错误继续交给调用者', async () => {
    const error = Object.assign(new Error('revision conflict'), { status: 409 });
    mocks.api.mockImplementation(path => path === '/v1/action' ? Promise.reject(error) : Promise.resolve(snap(2)));
    await expect(store.act({ type: 'ddz_action', move: 'pass' })).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(roomCalls()).toHaveLength(1);
    expect(store.snapshot.value.tablePrivate.revision).toBe(2);
  });

  it('开局独立更新账本，不占住动作闸门等待账本回包', async () => {
    const ledger = deferred();
    mocks.api.mockImplementation(path => path === '/v1/me/ledger' ? ledger.promise : Promise.resolve(patch(2)));
    await store.act({ type: 'table_start' });
    await vi.advanceTimersByTimeAsync(0);
    expect(await store.act({ type: 'ddz_action', move: 'pass' })).toBeTruthy();
    expect(roomCalls()).toHaveLength(0);
    ledger.resolve({ ledger: { balance: 80 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.snapshot.value.ledger.balance).toBe(80);
  });
});
