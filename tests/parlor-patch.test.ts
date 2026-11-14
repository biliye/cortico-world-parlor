import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ api: vi.fn(), toast: vi.fn() }));
const navigation = vi.hoisted(() => ({ assign: vi.fn(), pushState: vi.fn(), replaceState: vi.fn() }));
vi.mock('../web-src/api/client.ts', () => ({
  api: mocks.api, scopedPath: (path: string) => path, takeKeyFromHash: () => null,
  beginGlobalEntry: vi.fn(), finishGlobalEntry: vi.fn(), parentPlay: vi.fn(),
}));
vi.mock('../web-src/stores/chat.ts', () => ({ noteChatEvent: vi.fn(), resetChatState: vi.fn() }));
vi.mock('../web-src/stores/dm.ts', () => ({ noteWhisper: vi.fn(), resetDmState: vi.fn() }));
vi.mock('../web-src/stores/ui.ts', () => ({ showToast: mocks.toast }));
vi.mock('../web-src/stores/session.ts', async () => {
  const { ref } = await import('vue');
  return { seat: ref(null), saveSeat: vi.fn(), clearSeat: vi.fn(), readStoredSeat: vi.fn(), adoptSeat: vi.fn(), STORE_KEY: 'parlor-play-v1' };
});
vi.mock('../web-src/stores/view.ts', async () => {
  const { ref } = await import('vue');
  return { watchTableId: ref(''), backToRoom: vi.fn(), enterTable: vi.fn(), readView: vi.fn() };
});

class Stream {
  static last: Stream;
  private opened = false;
  private resolve!: (response: Response) => void;
  readonly response = new Promise<Response>(resolve => { this.resolve = resolve; });
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private readonly body = new ReadableStream<Uint8Array>({ start: controller => { this.controller = controller; } });
  constructor(readonly url: string, readonly token: string, readonly signal: AbortSignal) { Stream.last = this; }
  onopen() {
    if (this.opened) return;
    this.opened = true;
    this.resolve(new Response(this.body));
  }
  onerror() { if (!this.signal.aborted) this.resolve(new Response(null, { status: 503 })); }
  chunk(text: string) {
    this.onopen();
    this.controller.enqueue(new TextEncoder().encode(text));
  }
  onmessage(message: { data: string }) { this.chunk(`data: ${message.data}\n\n`); }
  emit(seq: number, type = 'parlor.table.action') { this.onmessage({ data: JSON.stringify({ seq, type }) }); }
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
  vi.stubGlobal('fetch', vi.fn((path: string, init: RequestInit) => new Stream(path,
    new Headers(init.headers).get('Authorization') ?? '', init.signal!).response));
  vi.stubGlobal('location', { pathname: '/play', search: '?room=room1', hash: '', reload: vi.fn(), assign: navigation.assign });
  vi.stubGlobal('history', { state: null, pushState: navigation.pushState, replaceState: navigation.replaceState });
  mocks.api.mockReset(); mocks.toast.mockReset();
  // 计算式 import 让 Node 侧 tsconfig 不把整套 DOM 源码纳入服务端类型检查。
  const sessionPath = '../web-src/stores/session.ts';
  const storePath = '../web-src/stores/parlor.ts';
  session = await import(sessionPath);
  store = await import(storePath);
  session.saveSeat.mockReset().mockImplementation((next:any) => { session.seat.value = next; });
  session.adoptSeat.mockReset().mockImplementation((next:any) => { session.seat.value = next; });
  session.clearSeat.mockReset().mockImplementation(() => { session.seat.value = null; });
  session.readStoredSeat.mockReset().mockImplementation(() => session.seat.value);
  session.seat.value = { token: 'test-token', room: 'room1', seatId: 's1', cooId: 'c1' };
  store.snapshot.value = snap();
});
afterEach(() => { store.disconnect(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const roomCalls = () => mocks.api.mock.calls.filter(([path]) => path === '/v1/room?limit=1');
const tableCalls = () => mocks.api.mock.calls.filter(([path]) => path === '/v1/table');

describe('H2/H3：多个窗口跟随最新席位', () => {
  let stored: any;
  let address: any;
  let browserHistory: any;
  const nextSeat = (room = 'hall', token = 'new-token', seatId = 's2') => ({ ...stored, room, token, seatId });
  const currentSnapshot = () => ({ ...snap(), id: stored.room, seat: { id: stored.seatId }, latest: 5 });
  const changed = () => store.onSeatStorage({ key: 'parlor-play-v1', storageArea: null });
  beforeEach(() => {
    stored = { ...session.seat.value };
    address = { pathname: '/play', search: '?room=room1&view=table&table=t1', hash: '', reload: vi.fn() };
    browserHistory = { state: null, replaceState: vi.fn((state: any, _title: string, url: string) => {
      browserHistory.state = state; address.search = new URL(url, 'http://localhost').search;
    }), pushState: vi.fn() };
    vi.stubGlobal('location', address); vi.stubGlobal('history', browserHistory);
    session.readStoredSeat.mockImplementation(() => stored);
    session.saveSeat.mockImplementation((next:any) => { stored = next; session.seat.value = next; });
    mocks.api.mockImplementation((path: string) => Promise.resolve(path === '/v1/me/location'
      ? { room: stored.room, seat: { id: stored.seatId, name: '当前席位' } }
      : path.startsWith('/v1/replay') ? { events: [] } : currentSnapshot()));
  });

  it('另一窗换厅后就地更新令牌、URL和快照，清旧私视图，不重写storage或发switch', async () => {
    store.log.value = [{ seq: 900, text: '旧厅私密消息' }];
    stored = nextSeat(); changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.seat.value).toMatchObject({ room: 'hall', token: 'new-token' });
    expect(store.snapshot.value.id).toBe('hall');
    expect(store.log.value).toEqual([]);
    expect(address.search).toBe('?room=hall');
    expect(Stream.last.token).toBe('Bearer new-token');
    expect(Stream.last.url).not.toContain('new-token');
    expect(session.saveSeat).not.toHaveBeenCalled();
    expect(mocks.api.mock.calls.some(([path]) => path.endsWith('/switch'))).toBe(false);
    expect(address.reload).not.toHaveBeenCalled();
  });

  it('同厅再次下场只轮换令牌时保留牌桌地址和已有记录', async () => {
    store.log.value = [{ seq: 1, text: '仍在当前牌桌' }];
    stored = nextSeat('room1', 'rotated', 's1'); changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(Stream.last.token).toBe('Bearer rotated');
    expect(address.search).toContain('table=t1');
    expect(store.log.value[0].text).toBe('仍在当前牌桌');
  });

  it('漏掉storage事件的断线重试也先采用新令牌；旧连接迟到的error不干扰新连接', async () => {
    store.connect(); const old = Stream.last;
    stored = nextSeat(); (old as any).onerror();
    await vi.advanceTimersByTimeAsync(5000);
    const current = Stream.last;
    expect(current.token).toBe('Bearer new-token');
    expect(session.seat.value.room).toBe('hall');
    (old as any).onerror();
    await vi.advanceTimersByTimeAsync(35000);
    expect(Stream.last).toBe(current);
    expect(address.reload).not.toHaveBeenCalled();
  });

  it('旧位置请求未返回时，新席位能独立恢复；迟到的旧位置不能覆盖它', async () => {
    const old = deferred(); mocks.api.mockReturnValueOnce(old.promise);
    const pending = store.syncLocation();
    stored = nextSeat(); changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.snapshot.value.id).toBe('hall');
    old.resolve({ room: 'room1', seat: { id: 's1' } });
    await pending;
    expect(session.seat.value.token).toBe('new-token');
    expect(store.snapshot.value.id).toBe('hall');
  });

  it('共享席位被移除时清掉本页私密状态且不重连；忽略无关键', async () => {
    stored = null;
    store.onSeatStorage({ key: 'other-key', storageArea: null });
    expect(session.seat.value).not.toBeNull();
    changed(); await vi.advanceTimersByTimeAsync(0);
    expect(session.seat.value).toBeNull(); expect(store.snapshot.value).toBeNull();
    expect(mocks.api).not.toHaveBeenCalled();
    expect(session.clearSeat).not.toHaveBeenCalled();
  });

  it.each(['reload', 'back_forward'])('%s旧客厅URL跟随最新位置，不发反向换厅', async navigationType => {
    stored = nextSeat(); session.seat.value = stored;
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: navigationType }] as any);
    expect(await store.boot()).toBe(true);
    expect(address.search).toBe('?room=hall');
    expect(mocks.api.mock.calls.some(([path]) => path.endsWith('/switch'))).toBe(false);
  });

  it('新分享链接仍进入目标厅及指定桌；已消费的地址再次boot不重复切厅', async () => {
    address.search = '?room=room2&view=table&table=t2';
    mocks.api.mockImplementation((path: string) => {
      if (path.endsWith('/switch')) return Promise.resolve({ room: 'room2', token: 'share-token', seat: { id: 'share-seat', name: '玩家' }, snapshot: { ...snap(), id: 'room2', seat: { id: 'share-seat' } } });
      return Promise.resolve(path === '/v1/me/location' ? { room: stored.room, seat: { id: stored.seatId } } : path.startsWith('/v1/replay') ? { events: [] } : currentSnapshot());
    });
    expect(await store.boot()).toBe(true);
    expect(session.seat.value.room).toBe('room2');
    expect(browserHistory.replaceState).toHaveBeenCalledWith({ parlor: true }, '', '/play?room=room2&view=table&table=t2');
    stored = nextSeat('hall', 'latest-token', 'latest-seat');
    expect(await store.boot()).toBe(true);
    expect(mocks.api.mock.calls.filter(([path]) => path.endsWith('/switch'))).toHaveLength(1);
    expect(address.search).toBe('?room=hall');
  });

  it('真正失效且没有替代令牌时仍清席位，不会永久重连', async () => {
    mocks.api.mockRejectedValue(Object.assign(new Error('expired'), { status: 401, seatToken: stored.token }));
    await expect(store.refreshSnapshot()).rejects.toThrow('expired');
    expect(session.clearSeat).toHaveBeenCalled();
  });

  it('只有SSE断线、没有其他快照请求时，位置接口401也能结束无效令牌重连', async () => {
    store.connect(); const original = Stream.last;
    mocks.api.mockRejectedValue(Object.assign(new Error('expired'), { status: 401 }));
    (original as any).onerror();
    await vi.advanceTimersByTimeAsync(5000);
    expect(session.clearSeat).toHaveBeenCalled();
    expect(session.seat.value).toBeNull(); expect(Stream.last).toBe(original);
  });

  it('本窗换厅迟到回执不能覆盖另一窗的新席位，随后自动恢复', async () => {
    const response = deferred(); mocks.api.mockReturnValueOnce(response.promise);
    const pending = store.goRoom('room2');
    stored = nextSeat(); changed();
    response.resolve({ room: 'room2', token: 'obsolete', seat: { id: 'obsolete', name: '旧回包' } });
    expect(await pending).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.seat.value.token).toBe('new-token');
    expect(session.saveSeat).not.toHaveBeenCalled();
  });

  it('网络失败时若席位已经变化，不把旧动作重发给新客厅', async () => {
    mocks.api.mockImplementationOnce(() => { stored = nextSeat(); return Promise.reject(new TypeError('network')); });
    expect(await store.act({ type: 'ddz_action', move: 'pass' })).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.api.mock.calls.filter(([path]) => path === '/v1/action')).toHaveLength(1);
    expect(session.seat.value.room).toBe('hall');
  });
});

describe('E3：直接应用回执并合并牌桌 SSE', () => {
  it('网页补历史与实时事件都隐藏被限频的进出，实时游标和成员刷新继续', async () => {
    const visible = { seq: 10, type: 'parlor.joined', text: '进入一次', data: { presenceWeb: true } };
    const hidden = { seq: 11, type: 'parlor.left', text: '重复离开', data: { presenceWeb: false } };
    mocks.api.mockResolvedValueOnce({ events: [visible, hidden] });
    await store.seedLog();
    expect(store.log.value.map((event:any) => event.text)).toEqual(['进入一次']);
    const chatPath = '../web-src/stores/chat.ts';
    const chat = await import(chatPath);
    chat.noteChatEvent.mockClear();
    store.connect();
    Stream.last.onmessage?.({ data: JSON.stringify({ ...hidden, seq: 12 }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.latest.value).toBe(12);
    expect(chat.noteChatEvent).not.toHaveBeenCalled();
    expect(store.log.value.map((event:any) => event.text)).toEqual(['进入一次']);
    mocks.api.mockResolvedValue(snap());
    await vi.advanceTimersByTimeAsync(1000);
    expect(roomCalls().length).toBeGreaterThan(0);
  });

  it('断流时不拉整厅快照，按退避重连', async () => {
    mocks.api.mockRejectedValue(new Error('offline'));
    store.connect();
    (Stream.last as any).onerror();
    await vi.advanceTimersByTimeAsync(2999);
    expect(store.connection.value).toBe('off');
    expect(mocks.api).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.api).toHaveBeenCalledWith('/v1/me/location');
    expect(roomCalls()).toHaveLength(0);
  });

  it('SSE 支持跨分片和 CRLF，心跳与损坏的消息不会写入日志', async () => {
    store.connect(false);
    Stream.last.chunk(': ping\r\n\r\ndata: {bad}\r\n\r\nda');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.log.value).toEqual([]);
    Stream.last.chunk('ta: {"seq":42,"type":"parlor.say","text":"你好"}\r\n\r');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.log.value).toEqual([]);
    Stream.last.chunk('\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.log.value.map((event: { text: string }) => event.text)).toEqual(['你好']);
  });
  it('服务器迁厅后清旧日志并采用 canonical 席位，迟到的位置响应不覆盖新身份', async () => {
    vi.stubGlobal('location', { pathname:'/play',search:'?room=room1&view=table' });
    vi.stubGlobal('history', { replaceState:vi.fn() });
    session.saveSeat.mockImplementation((next:any) => { session.seat.value=next; });
    store.log.value=[{seq:900,text:'旧厅私密消息'}];
    mocks.api.mockImplementation((path:string) => {
      if (path==='/v1/me/location') return Promise.resolve({room:'hall',seat:{id:'s2',name:'小满'}});
      if (path.startsWith('/v1/replay')) return Promise.resolve({events:[]});
      return Promise.resolve({...snap(),id:'hall',table:null,tablePrivate:null});
    });
    expect(await store.syncLocation()).toBe(true);
    expect(session.seat.value.room).toBe('hall');
    expect(store.log.value).toEqual([]);
    const old=deferred();
    mocks.api.mockReturnValueOnce(old.promise);
    const pending=store.syncLocation();
    session.seat.value={...session.seat.value,token:'new-identity',seatId:'new-seat'};
    old.resolve({room:'room1',seat:{id:'old-seat',name:'旧身份'}});
    expect(await pending).toBe(false);
    expect(session.seat.value.token).toBe('new-identity');
  });
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
    store.connect(false);
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
    store.connect(false);
    Stream.last.emit(2); Stream.last.emit(3, 'parlor.table.turn');
    await vi.advanceTimersByTimeAsync(300);
    expect(tableCalls()).toHaveLength(1);
    expect(roomCalls()).toHaveLength(0);
    expect(store.snapshot.value.table.revision).toBe(3);
  });

  it('在途旧 table 响应不能覆盖更新的动作回执', async () => {
    const old = deferred();
    mocks.api.mockImplementation((path) => path === '/v1/table' ? old.promise : Promise.resolve(patch(4)));
    store.connect(false); Stream.last.emit(2);
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
    store.connect(false); Stream.last.emit(2);
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
    store.connect(false); Stream.last.emit(2);
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

describe('大厅与客厅就地转场', () => {
  beforeEach(() => {
    Object.values(navigation).forEach(mock => mock.mockClear());
    vi.stubGlobal('location', { pathname: '/play', search: '?room=room1', hash: '', assign: navigation.assign });
    vi.stubGlobal('history', { pushState: navigation.pushState, replaceState: navigation.replaceState });
    session.saveSeat.mockImplementation((next: any) => { session.seat.value = next; });
  });
  const moved = (room = 'hall') => ({ room, token: 'next-token', seat: { id: 's2', name: '小满' } });
  const destination = (id = 'hall') => ({ ...snap(), id, latest: 5, table: null, tables: [], tablePrivate: null });

  it('切厅响应带首屏时只等一次请求，SSE首次连接不再重复取快照', async () => {
    const first = { ...destination(), seat: { id: 's2', name: '小满' }, online: [] };
    mocks.api.mockImplementation((path: string) => Promise.resolve(path.endsWith('/switch')
      ? { ...moved(), snapshot: first } : { events: [] }));
    expect(await store.goRoom('hall')).toBe(true);
    expect(JSON.parse(mocks.api.mock.calls[0][1].body)).toMatchObject({ to: 'hall', includeSnapshot: true });
    expect(roomCalls()).toHaveLength(0);
    expect(store.snapshot.value).toMatchObject({ id: 'hall', seat: { id: 's2' } });
    (Stream.last as any).onopen();
    await vi.advanceTimersByTimeAsync(500);
    expect(roomCalls()).toHaveLength(0);
    expect(store.snapshot.value.online).toContain('s2');
    // 真正的恢复连接仍补一次快照，不能沿用首次连接的省略策略。
    mocks.api.mockResolvedValue(first);
    store.connect();
    (Stream.last as any).onopen();
    await vi.advanceTimersByTimeAsync(150);
    expect(roomCalls()).toHaveLength(1);
  });

  it.each([
    { ...destination('other'), seat: { id: 's2' } },
    { ...destination(), seat: { id: 'someone-else' } },
  ])('附带快照的客厅或席位不匹配时，仍用新令牌单独补读', async (wrong) => {
    mocks.api.mockImplementation((path: string) => Promise.resolve(path.endsWith('/switch')
      ? { ...moved(), snapshot: wrong } : path.startsWith('/v1/replay') ? { events: [] } : destination()));
    expect(await store.goRoom('hall')).toBe(true);
    expect(roomCalls()).toHaveLength(1);
    expect(store.snapshot.value.id).toBe('hall');
  });

  it('返回大厅不重载页面，快照到达就完成，不等待历史回放', async () => {
    const replay = deferred();
    mocks.api.mockImplementation((path: string) => {
      if (path.endsWith('/switch')) return Promise.resolve(moved());
      if (path.startsWith('/v1/replay')) return replay.promise;
      return Promise.resolve(destination());
    });
    store.log.value = [{ seq: 900, text: '旧厅消息' }];
    expect(await store.goRoom('hall')).toBe(true);
    expect(navigation.assign).not.toHaveBeenCalled();
    expect(navigation.pushState).toHaveBeenCalledWith({ parlor: true }, '', '/play?room=hall');
    expect(store.snapshot.value.id).toBe('hall');
    expect(store.log.value).toEqual([]);
    expect(store.connection.value).toBe('connecting');
    expect(store.roomTransition.value).toBeNull();
    expect(mocks.api.mock.calls.map(([path]) => path)).not.toContain('/v1/me/location');
    replay.resolve({ events: [] });
  });

  it('去客厅时立即显示目的地，连续点击只发一次换厅', async () => {
    const post = deferred();
    store.rooms.value = [{ id: 'room2', name: '月光客厅' }];
    mocks.api.mockImplementation((path: string) => path.endsWith('/switch') ? post.promise
      : Promise.resolve(path.startsWith('/v1/replay') ? { events: [] } : destination('room2')));
    const first = store.goRoom('room2');
    expect(store.roomTransition.value).toMatchObject({ to: 'room2', name: '月光客厅', error: '' });
    expect(await store.goRoom('room2')).toBe(false);
    expect(mocks.api).toHaveBeenCalledTimes(1);
    post.resolve(moved('room2'));
    expect(await first).toBe(true);
  });

  it('换厅失败保留原席位与画面，不写入新的浏览历史', async () => {
    mocks.api.mockRejectedValue(new Error('客厅已满'));
    expect(await store.goRoom('hall')).toBe(false);
    expect(session.seat.value.room).toBe('room1');
    expect(store.snapshot.value.id).toBe('room1');
    expect(store.roomTransition.value).toBeNull();
    expect(navigation.pushState).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith('客厅已满', 'bad');
  });

  it('已换到大厅但快照失败时，重试只读快照，不重复换席位', async () => {
    let unavailable = true;
    mocks.api.mockImplementation((path: string) => {
      if (path.endsWith('/switch')) return Promise.resolve(moved());
      if (path.startsWith('/v1/replay')) return Promise.resolve({ events: [] });
      return unavailable ? Promise.reject(new Error('快照超时')) : Promise.resolve(destination());
    });
    expect(await store.goRoom('hall')).toBe(false);
    expect(session.seat.value.room).toBe('hall');
    expect(store.roomTransition.value.error).toBe('快照超时');
    unavailable = false;
    expect(await store.finishRoomTransition()).toBe(true);
    expect(mocks.api.mock.calls.filter(([path]) => path.endsWith('/switch'))).toHaveLength(1);
    expect(store.roomTransition.value).toBeNull();
  });

  it('旧厅快照在途不阻塞新厅，迟到响应和回放不串厅', async () => {
    const oldSnapshot = deferred();
    const oldReplay = deferred();
    mocks.api.mockImplementation((path: string) => path.startsWith('/v1/replay') ? oldReplay.promise : oldSnapshot.promise);
    const refreshing = store.refreshSnapshot();
    const replaying = store.seedLog();
    mocks.api.mockImplementation((path: string) => Promise.resolve(path.endsWith('/switch') ? moved()
      : path.startsWith('/v1/replay') ? { events: [{ seq: 1, text: '大厅消息' }] } : destination()));
    expect(await store.goRoom('hall')).toBe(true);
    oldSnapshot.resolve(snap(99));
    oldReplay.resolve({ events: [{ seq: 900, text: '旧厅私密消息' }] });
    await Promise.all([refreshing, replaying]);
    expect(store.snapshot.value.id).toBe('hall');
    expect(store.log.value.map((event: any) => event.text)).toEqual(['大厅消息']);
  });

  it('切厅途中前台位置恢复和动作不能发起第二次迁移或污染旧厅', async () => {
    const post = deferred();
    mocks.api.mockReturnValue(post.promise);
    const pending = store.goRoom('hall');
    expect(await store.syncLocation()).toBe(false);
    expect(await store.act({ type: 'say', text: 'hello' })).toBeNull();
    expect(mocks.api).toHaveBeenCalledTimes(1);
    mocks.api.mockImplementation((path: string) => Promise.resolve(path.startsWith('/v1/replay') ? { events: [] } : destination()));
    post.resolve(moved());
    await pending;
  });

  it('前进后退使用替换历史，定向牌桌参数保留', async () => {
    mocks.api.mockImplementation((path: string) => Promise.resolve(path.endsWith('/switch') ? moved('room2')
      : path.startsWith('/v1/replay') ? { events: [] } : destination('room2')));
    expect(await store.goRoom('room2', 't2', true)).toBe(true);
    expect(navigation.replaceState).toHaveBeenCalledWith({ parlor: true }, '', '/play?room=room2&view=table&table=t2');
    expect(navigation.pushState).not.toHaveBeenCalled();
  });

  it('首次进入也不等待聊天回放，后补历史与实时消息按序去重', async () => {
    const replay = deferred();
    mocks.api.mockImplementation((path: string) => path.startsWith('/v1/replay') ? replay.promise
      : Promise.resolve(path === '/v1/me/location' ? { room: 'room1', seat: { id: 's1', name: '小满' } } : snap()));
    expect(await store.boot()).toBe(true);
    Stream.last.emit(3, 'parlor.say');
    replay.resolve({ events: [{ seq: 1 }, { seq: 2 }, { seq: 3 }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.log.value.map((event: any) => event.seq)).toEqual([1, 2, 3]);
  });
});
