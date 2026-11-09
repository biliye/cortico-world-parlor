/**
 * 网页客户端与家长下场：玩家入场、防作弊、公开棋盘、斗地主提示、静态资源。
 * 这些测试不碰浏览器，只走 HTTP；页面本身由 state/tools 里的浏览器冒烟另行目击。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { ParlorServer } from '../src/room/server.ts';
import type { PlayerJoinResponse, RoomSnapshot } from '../src/room/protocol.ts';
import { parentPlayBody, parseEntryKey } from '../web-src/lib/entry.ts';
import { chatChannelAccepts, chatLineMatchesTable, chatLineVisible } from '../web-src/lib/chat-lines.ts';
import { TABLE_ROOM_HINT, TABLE_TALK_PREFIX, TABLE_TALK_SCOPE, tableScopeText } from '../web-src/lib/chat-copy.ts';
import { ENABLED_GAMES, GAMES } from '../web-src/lib/games.ts';
import { GUEST_CLOSED_MESSAGE, SEAT_EXPIRED_MESSAGE, guestJoinEnabled } from '../web-src/lib/join.ts';
import { ROOM_CAPACITY, createRoomBody } from '../web-src/lib/rooms.ts';
import { decideExpiredSeat } from '../web-src/lib/seat-errors.ts';
import { readable } from '../web-src/lib/text.ts';

type Json = Record<string, any>;

interface Player {
  token: string;
  cooId: string;
  cooSecret: string;
  seat: { id: string; name: string; kind: string; tier: string };
}

interface Pet extends Player {
  ownerToken: string;
}

const authHeaders = (auth: { token: string; cooId: string; cooSecret: string }): Record<string, string> => ({
  authorization: 'Bearer ' + auth.token,
  'x-parlor-coo': auth.cooId,
  'x-parlor-coo-secret': auth.cooSecret,
});

describe('网页玩家', () => {
  let scratch: string;
  let server: ParlorServer;

  beforeEach(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'parlor-play-'));
    server = new ParlorServer({ id: 'lobby', inviteCode: 'inv', port: 0, dataFile: join(scratch, 'room.json') });
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(server.url + path, init);
    const text = await response.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body, text, headers: response.headers };
  };

  const joinBody = (name: string, invite = 'inv'): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-parlor-invite': invite },
    body: JSON.stringify({ name }),
  });

  const playerJoin = async (name: string): Promise<Player> => {
    const response = await call('/v1/player/join', joinBody(name));
    expect(response.status, response.text).toBe(200);
    const body = response.body as PlayerJoinResponse;
    return {
      token: body.token,
      cooId: body.identity.cooId,
      cooSecret: body.identity.cooSecret,
      seat: body.seat as unknown as Player['seat'],
    };
  };

  const petJoin = async (name: string): Promise<Pet> => {
    const cooId = randomUUID();
    const cooSecret = randomBytes(32).toString('base64url');
    const response = await call('/v1/join', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-parlor-invite': 'inv',
        'x-parlor-coo': cooId,
        'x-parlor-coo-secret': cooSecret,
      },
      body: JSON.stringify({ name }),
    });
    expect(response.status, response.text).toBe(200);
    const body = response.body as Json;
    return {
      token: body.token,
      ownerToken: body.ownerToken,
      cooId,
      cooSecret,
      seat: body.seat,
    };
  };

  const act = async (auth: Pick<Player, 'token' | 'cooId' | 'cooSecret'>, body: Json) => (
    call('/v1/action', {
      method: 'POST',
      headers: { ...authHeaders(auth), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

  const snap = async (auth: Pick<Player, 'token' | 'cooId' | 'cooSecret'>, query = '?limit=50'): Promise<RoomSnapshot> => {
    const response = await call('/v1/room' + query, { headers: authHeaders(auth) });
    expect(response.status, response.text).toBe(200);
    return response.body as RoomSnapshot;
  };

  it('网页入口与静态资源能从服务器拿到，healthz 报版本', async () => {
    const page = await call('/play');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(page.text).toContain('/play/assets/vue-loader.js');

    const js = await call('/play/assets/vue/main.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    // 旧页已在 0.40.0 下线：旧脚本不再发布，带 ?legacy=1 的书签 302 回默认页。
    expect((await call('/play/assets/play.js')).status).toBe(404);
    const retired = await call('/play?legacy=1&room=hall', { redirect: 'manual' });
    expect(retired.status).toBe(302);
    expect(retired.headers.get('location')).toBe('/play?room=hall');
    expect((await call('/play?legacy=true', { redirect: 'manual' })).headers.get('location')).toBe('/play');
    const css = await call('/play/assets/play.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    const chip = await call('/play/assets/assets/coo-chip.png');
    expect(chip.status).toBe(200);
    expect(chip.headers.get('content-type')).toContain('image/png');
    expect((await call('/play/assets/nope.js')).status).toBe(404);

    const health = await call('/healthz');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(health.body.version).toBe(pkg.version);
  });

  it('文本资源走 gzip 并带 ETag，重开一次只回 304', async () => {
    const raw = (path: string, headers: Record<string, string>) => new Promise<{
      status: number; headers: Record<string, string | string[] | undefined>; body: Buffer;
    }>((resolve, reject) => {
      const req = request(server.url + path, { headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }));
      });
      req.on('error', reject);
      req.end();
    });

    const js = await raw('/play/assets/vue/main.js', { 'accept-encoding': 'gzip' });
    expect(js.status).toBe(200);
    expect(js.headers['content-encoding']).toBe('gzip');
    expect(js.headers['cache-control']).toContain('max-age=300');
    const plain = readFileSync(new URL('../src/web/vue/main.js', import.meta.url));
    expect(gunzipSync(js.body).equals(plain)).toBe(true);
    expect(js.body.length).toBeLessThan(plain.length / 2);

    const etag = String(js.headers.etag);
    expect(etag).toMatch(/^"[\w-]{18}-gz"$/);
    const again = await raw('/play/assets/vue/main.js', { 'accept-encoding': 'gzip', 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);

    // 图片本来就压过，不再 gzip。
    const chip = await raw('/play/assets/assets/coo-chip.png', { 'accept-encoding': 'gzip' });
    expect(chip.status).toBe(200);
    expect(chip.headers['content-encoding']).toBeUndefined();

    // 页面不缓存，但仍带 ETag 与 CSP。
    const page = await raw('/play', { 'accept-encoding': 'gzip' });
    expect(page.headers['cache-control']).toBe('no-cache');
    expect(String(page.headers['content-security-policy'])).toContain("script-src 'self'");
  });

  it('家长用自己的席位与账本身份入场，不占用孩子的账本', async () => {
    const papa = await playerJoin('Papa');
    expect(papa.seat.kind).toBe('human');
    expect(papa.seat.tier).toBe('off');
    const snapshot = await snap(papa, '?limit=1');
    expect(snapshot.seat.id).toBe(papa.seat.id);
    expect(snapshot.ledger?.games).toBe(0);

    const said = await act(papa, { type: 'say', text: '大家好' });
    expect(said.status, said.text).toBe(200);

    const duplicate = await call('/v1/player/join', joinBody('Papa'));
    expect(duplicate.status).toBe(409);
    const badInvite = await call('/v1/player/join', joinBody('Nobody', 'wrong'));
    expect(badInvite.status).toBe(403);
  });

  it('桌上有真人时家长页看不到她的私视图与私牌事件，结束后恢复', async () => {
    const coo = await petJoin('Coo');
    const papa = await playerJoin('Papa');
    expect((await act(coo, { type: 'table_open', game: 'dice' })).status).toBe(200);
    expect((await act(papa, { type: 'table_join' })).status).toBe(200);
    expect((await act(coo, { type: 'table_start' })).status).toBe(200);

    const owner = await call('/v1/room?limit=50', { headers: { authorization: 'Bearer ' + coo.ownerToken } });
    const ownerBody = owner.body as RoomSnapshot;
    expect(ownerBody.ownerPrivateHidden).toBe(true);
    expect(ownerBody.tablePrivate).toBeNull();
    expect((ownerBody.events as Json[]).filter((event) => event.type === 'parlor.table.turn')).toHaveLength(0);

    const pet = await snap(coo);
    expect(pet.tablePrivate?.dice).toHaveLength(2);
    expect((pet.events as Json[]).some((event) => event.type === 'parlor.table.turn')).toBe(true);

    const history = await call('/v1/history?limit=100', { headers: { authorization: 'Bearer ' + coo.ownerToken } });
    expect((history.body.events as Json[]).some((event) => event.type === 'parlor.table.turn')).toBe(false);
    const replay = await call('/v1/replay?limit=100', { headers: { authorization: 'Bearer ' + coo.ownerToken } });
    expect((replay.body.events as Json[]).some((event) => event.type === 'parlor.table.turn')).toBe(false);
    const replayPet = await call('/v1/replay?limit=100', { headers: authHeaders(coo) });
    expect((replayPet.body.events as Json[]).some((event) => event.type === 'parlor.table.turn')).toBe(true);

    // 两边都停牌，这局结束；家长页恢复成能看私视图。
    expect((await act(coo, { type: 'table_action', action: 'stand' })).status).toBe(200);
    expect((await act(papa, { type: 'table_action', action: 'stand' })).status).toBe(200);
    const after = await call('/v1/room?limit=50', { headers: { authorization: 'Bearer ' + coo.ownerToken } });
    const afterBody = after.body as RoomSnapshot;
    expect(afterBody.table?.status).toBe('ended');
    expect(afterBody.ownerPrivateHidden).toBeUndefined();
    expect(afterBody.tablePrivate).not.toBeNull();
  });

  it('大富翁把 24 格棋盘与规则公开，家长对打时同样隐藏', async () => {
    const coo = await petJoin('Coo');
    const papa = await playerJoin('Papa');
    expect((await act(coo, { type: 'monopoly', action: 'open', size: 4, pace: 'quick' })).status).toBe(200);
    expect((await act(papa, { type: 'monopoly', action: 'join' })).status).toBe(200);
    const start = await act(coo, { type: 'monopoly', action: 'start' });
    expect(start.status, start.text).toBe(200);

    const snapshot = await snap(papa, '?limit=1');
    const table = snapshot.table as unknown as Json;
    expect(table.board).toHaveLength(24);
    expect(table.rules.rounds).toBe(12);
    expect((table.board as Json[]).find((cell) => cell.kind === 'property')?.price).toBeGreaterThan(0);
    expect(table.players).toHaveLength(4);

    const owner = await call('/v1/room?limit=50', { headers: { authorization: 'Bearer ' + coo.ownerToken } });
    expect((owner.body as RoomSnapshot).ownerPrivateHidden).toBe(true);
    expect((owner.body as RoomSnapshot).tablePrivate).toBeNull();
    const mail = await call('/v1/mail?recent=1&limit=5', { headers: { authorization: 'Bearer ' + coo.ownerToken } });
    expect(mail.body.ownerPrivateHidden).toBe(true);
  });

  it('斗地主提示与可过判断来自服务器，提示的牌真能出', async () => {
    const a = await playerJoin('A');
    const b = await playerJoin('B');
    const c = await playerJoin('C');
    expect((await act(a, { type: 'table_open', game: 'ddz' })).status).toBe(200);
    expect((await act(b, { type: 'table_join' })).status).toBe(200);
    expect((await act(c, { type: 'table_join' })).status).toBe(200);
    const start = await act(a, { type: 'table_start' });
    expect(start.status, start.text).toBe(200);

    const bidding = await snap(a, '?limit=1');
    expect(bidding.table?.status).toBe('bidding');
    const priv = bidding.tablePrivate as unknown as Json;
    expect(priv.yourTurn).toBe(true);
    expect(typeof priv.hint.bid).toBe('boolean');
    expect(priv.canPass).toBe(false);

    const bid = await act(a, { type: 'ddz_action', move: 'bid', call: true });
    expect(bid.status, bid.text).toBe(200);
    const playing = await snap(a, '?limit=1');
    const playingPriv = playing.tablePrivate as unknown as Json;
    expect(playingPriv.role).toBe('landlord');
    expect(playingPriv.canPass).toBe(false);
    expect(playingPriv.hint).toBeTruthy();
    const cards = playingPriv.hint.cards as string[];
    expect(Array.isArray(cards)).toBe(true);
    expect(cards.length).toBeGreaterThan(0);

    const play = await act(a, { type: 'ddz_action', move: 'play', cards });
    expect(play.status, play.text).toBe(200);
    const after = await snap(a, '?limit=1');
    expect((after.tablePrivate as unknown as Json).yourTurn).toBe(false);
    expect((after.tablePrivate as unknown as Json).hint).toBeUndefined();
  });

  it('网页玩家能开桌、坐下、开局并行动', async () => {
    const a = await playerJoin('A');
    const b = await playerJoin('B');
    expect((await act(a, { type: 'table_open', game: 'dice' })).status).toBe(200);
    expect((await act(b, { type: 'table_join' })).status).toBe(200);
    const start = await act(a, { type: 'table_start' });
    expect(start.status, start.text).toBe(200);

    const snapshot = await snap(a, '?limit=1');
    expect(snapshot.table?.status).toBe('playing');
    expect((snapshot.tablePrivate as unknown as Json).yourTurn).toBe(true);
    const stand = await act(a, { type: 'table_action', action: 'stand' });
    expect(stand.status, stand.text).toBe(200);
    expect(stand.body.turn).toBe('B');
  });

  it('鲸语会馆主题、筹码图同源，聊天三 tab 的边界写清楚', () => {
    const css = readFileSync(new URL('../src/web/play.css', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../src/web/play.html', import.meta.url), 'utf8');
    expect(css).toContain('assets/coo-chip.png');
    expect(html).toContain('content="#10191b"');
    expect(html).toContain('/play/assets/club.css');
    expect(css).not.toContain('底池');
    expect(css).not.toContain('底注');
    expect(css).not.toContain('净胜');

    // 旧文案只改显示，不改事件本身：三个词都在 readable() 里换掉。
    expect(readable('底池 10，底注 2，今晚净胜 3')).toBe('彩头 10，每局 2，今晚的小收获 3');

    // 聊天栏的过滤规则：私聊走浮窗，牌桌动作与大富翁过程不进聊天栏。
    expect(chatLineVisible('parlor.whisper')).toBe(false);
    expect(chatLineVisible('parlor.table.turn')).toBe(false);
    expect(chatLineVisible('parlor.monopoly.roll')).toBe(false);
    expect(chatLineVisible('parlor.table.say')).toBe(true);
    expect(chatLineVisible('parlor.say')).toBe(true);

    // 牌桌栏只放桌内私聊；客厅/大厅栏不收牌桌私聊。
    expect(chatChannelAccepts('table', 'parlor.table.say')).toBe(true);
    expect(chatChannelAccepts('table', 'parlor.say')).toBe(false);
    expect(chatChannelAccepts('room', 'parlor.table.say')).toBe(false);
    expect(chatChannelAccepts('room', 'parlor.say')).toBe(true);
    expect(chatChannelAccepts('mail', 'parlor.say')).toBe(false);
    expect(chatLineMatchesTable('t1', 't1')).toBe(true);
    expect(chatLineMatchesTable('t2', 't1')).toBe(false);
    expect(chatLineMatchesTable(undefined, 't1')).toBe(true);

    // 牌桌私聊的边界说明：只发到这一桌，客厅和不在桌上的人看不见。
    expect(tableScopeText({ tableOpen: true })).toBe(TABLE_TALK_SCOPE);
    expect(TABLE_TALK_SCOPE).toContain('只发到这一桌');
    expect(TABLE_TALK_SCOPE).toContain('客厅和不在桌上的人看不见');
    expect(TABLE_TALK_PREFIX).toContain('只有同桌看得见');
    expect(TABLE_ROOM_HINT).toContain('客厅的聊天在「客厅」那一栏');
    expect(tableScopeText({ tableOpen: true, elsewhere: true })).toContain('你现在看的是另一桌');
    expect(tableScopeText({ tableOpen: false, werewolfActive: true })).toContain('狼人杀进行中');
  });

  it('带钥匙的「我下场玩」链接直接下场；席位被顶掉时不自动重入', () => {
    // 面板的 #key= 链接：从地址栏取一次钥匙，钥匙用完抹掉。
    expect(parseEntryKey('#key=abc')).toBe('abc');
    expect(parseEntryKey('#foo=1&key=%20k%20')).toBe('k');
    expect(parseEntryKey('')).toBe('');
    expect(parseEntryKey('#foo=1')).toBe('');

    // 家长下场的请求体：空钥匙、空客厅都不带上去。
    expect(parentPlayBody('', '')).toEqual({});
    expect(parentPlayBody('key-1', '')).toEqual({ key: 'key-1' });
    expect(parentPlayBody('', 'room-1')).toEqual({ room: 'room-1' });
    expect(parentPlayBody('key-1', 'room-1')).toEqual({ key: 'key-1', room: 'room-1' });

    // 一个家长身份只有一个席位：真失效时给「被顶掉」的说明，不静默重入。
    expect(SEAT_EXPIRED_MESSAGE).toContain('可能被另一台设备顶掉了');
    expect(SEAT_EXPIRED_MESSAGE).toContain('以家长身份下场');
  });

  it('大厅是一个真页面：在线的人、客厅目录、开一间、离开客厅', () => {
    const css = readFileSync(new URL('../src/web/play.css', import.meta.url), 'utf8');
    expect(css).toContain('.view-hall');
    expect(css).toContain('.hall-create');

    // 大厅接口的真实行为由 world-server-table 的 HTTP 用例覆盖；这里验页面契约。
    const lobby = readFileSync(new URL('../web-src/views/LobbyView.vue', import.meta.url), 'utf8');
    for (const line of ['loadHall', 'createRoomBody', '大厅里', 'visibleSeats']) {
      expect(lobby).toContain(line);
    }
    const room = readFileSync(new URL('../web-src/views/RoomView.vue', import.meta.url), 'utf8');
    expect(room).toContain('goRoom');
    expect(room).toContain('backToHall');

    // 旧标签页的 401 不能删掉别的标签页刚写进去的新令牌（否则像被登出）。
    expect(decideExpiredSeat('old-token', 'new-token', 'old-token')).toBe('reload');
    expect(decideExpiredSeat('old-token', 'new-token', 'new-token')).toBe('ignore');
    expect(decideExpiredSeat('same-token', 'same-token', 'same-token')).toBe('clear');
    expect(decideExpiredSeat('', null, null)).toBe('ignore');

    // 家长页能下场；加入页在有家长会话时给「以家长身份下场」。
    const join = readFileSync(new URL('../web-src/views/JoinView.vue', import.meta.url), 'utf8');
    expect(join).toContain('以家长身份下场');
    expect(join).toContain('requestParentPlay');
    const parent = readFileSync(new URL('../src/web/parent.js', import.meta.url), 'utf8');
    expect(parent).toContain('playAsParent');
    expect(parent).toContain("localStorage.setItem('parlor-play-v1'");
    // 家长页能改名字：一个接口同时改账户名、玩家身份名、当前席位名。
    expect(parent).toContain('openRename');
    expect(parent).toContain("'/v1/parent/rename'");
    expect(parent).toContain('改名字');
  });

  it('加入页不会被空刷新重画：窗口一获得焦点，正在填的名字就没了', () => {
    // 加入页没有席位时的空刷新/401 一律忽略，不能把正在填的表单重画掉。
    expect(decideExpiredSeat('x', null, null)).toBe('ignore');
    expect(decideExpiredSeat('', null, null)).toBe('ignore');
    // 真失效时回加入页并说明原因。
    expect(SEAT_EXPIRED_MESSAGE).toContain('席位已经失效');
    expect(SEAT_EXPIRED_MESSAGE).toContain('重新进来');
  });

  it('建房固定 30 人，移除人数选择并提供房主删除入口', () => {
    expect(ROOM_CAPACITY).toBe(30);
    expect(createRoomBody(' 测试厅 ', 'public')).toEqual({ name: '测试厅', visibility: 'public', capacity: 30 });
    expect(createRoomBody('私密厅', 'private').capacity).toBe(ROOM_CAPACITY);
    const lobby = readFileSync(new URL('../web-src/views/LobbyView.vue', import.meta.url), 'utf8');
    expect(lobby).not.toContain('capacitySelect');
    expect(lobby).toContain('固定 {{ ROOM_CAPACITY }} 人');
    const access = readFileSync(new URL('../web-src/components/AccessDialog.vue', import.meta.url), 'utf8');
    expect(access).toContain('/delete');
    expect(access).toContain('删除后从目录移除');
  });

  it('访客入口关闭时不再显示加入表单', () => {
    expect(guestJoinEnabled(null)).toBe(true);
    expect(guestJoinEnabled({ guestJoin: true })).toBe(true);
    expect(guestJoinEnabled({ guestJoin: false })).toBe(false);
    expect(GUEST_CLOSED_MESSAGE).toContain('这个入口已经关闭');
    const join = readFileSync(new URL('../web-src/views/JoinView.vue', import.meta.url), 'utf8');
    expect(join).toContain('guestJoinEnabled');
    expect(join).toContain('GUEST_CLOSED_MESSAGE');
  });

  it('私聊浮窗：入口在信箱旁、可拖拽、点窗外关闭、离线也投递', () => {
    const dm = readFileSync(new URL('../web-src/stores/dm.ts', import.meta.url), 'utf8');
    const win = readFileSync(new URL('../web-src/components/DmWindow.vue', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/web/play.css', import.meta.url), 'utf8');
    for (const line of ["api<{ threads?: DmThread[]; unread?: number }>('/v1/dm/threads')",
      "'/v1/dm?peer='", "'/v1/people?q='", 'parlor-dm-pos-v1']) {
      expect(dm).toContain(line);
    }
    for (const line of ['startDrag', 'savePos', 'outside', "event.key === 'Escape'", "'is-me': message.fromMe"]) {
      expect(win).toContain(line);
    }
    // 私聊只进浮窗，不再混进大厅/客厅的聊天栏。
    expect(chatLineVisible('parlor.whisper')).toBe(false);
    // 点浮窗外面关掉、手机上是全屏。
    expect(win).toContain('win.value.contains(target)');
    expect(css).toContain('.dm {');
    expect(css).toContain('@media (max-width: 820px)');
    expect(css).toContain('.dm-msg.is-me');
  });

  it('网页的游戏入口来自注册表：只露斗地主与狼人杀，骰子和大富翁收起', () => {
    expect(GAMES.ddz.enabled).toBe(true);
    expect(GAMES.werewolf.enabled).toBe(true);
    expect(GAMES.dice.enabled).toBe(false);
    expect(GAMES.monopoly.enabled).toBe(false);
    expect(ENABLED_GAMES).toContain('ddz');
    expect(ENABLED_GAMES).toContain('werewolf');
    expect(ENABLED_GAMES).not.toContain('dice');
    expect(ENABLED_GAMES).not.toContain('monopoly');
    expect(GAMES.ddz.label).toBe('斗地主');
    expect(GAMES.werewolf.guide?.length).toBeGreaterThan(0);
    expect(GAMES.monopoly.blurb).toContain('先收起来了');
    const css = readFileSync(new URL('../src/web/play.css', import.meta.url), 'utf8');
    expect(css).toContain('.ddz-end-seats');
    expect(css).toContain('.ddz-guide');
  });

  it('异步棋盘子包加载失败时有刷新兜底，样式齐全', () => {
    // 发版会换掉带哈希的分包名：升级前开着的标签页首次进五子棋或快局大富翁会 404，
    // 兜底文案必须真的进产物，否则牌桌区域只剩一片空白。
    const dir = new URL('../src/web/vue/', import.meta.url);
    const scripts = readdirSync(dir).filter((name) => name.endsWith('.js'))
      .map((name) => readFileSync(new URL(name, dir), 'utf8'));
    expect(scripts.some((text) => text.includes('这一桌的界面没载入成功'))).toBe(true);
    expect(scripts.some((text) => text.includes('刷新页面'))).toBe(true);
    const css = readFileSync(new URL('../src/web/play.css', import.meta.url), 'utf8');
    expect(css).toContain('.chunk-fallback');
  });

  it('统一身份票据失效的引导文案进了产物', () => {
    // 票据在请求前就离开了地址栏，失效提示必须来自客户端产物本身，否则用户只看到一句 401。
    const dir = new URL('../src/web/vue/', import.meta.url);
    const scripts = readdirSync(dir).filter((name) => name.endsWith('.js'))
      .map((name) => readFileSync(new URL(name, dir), 'utf8'));
    expect(scripts.some((text) => text.includes('重新点一次入场'))).toBe(true);
  });

  it('网页脚本语法正确，家长页有牌桌面板与下场入口', async () => {
    const files = [
      'src/web/common.js',
      'src/web/local-history.js',
      'src/web/games/dice.js',
      'src/web/games/monopoly.js',
      'src/web/vue-loader.js',
      'src/web/vue/main.js',
    ];
    for (const rel of files) {
      const file = fileURLToPath(new URL('../' + rel, import.meta.url));
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      expect(result.status, rel + '\n' + (result.stderr || '')).toBe(0);
    }

    const coo = await petJoin('Coo');
    const page = await call('/v1/owner?token=' + encodeURIComponent(coo.ownerToken));
    expect(page.status).toBe(200);
    expect(page.text).toContain('牌桌');
    expect(page.text).toContain('href="/play"');
    expect(page.text).toContain('防作弊');

    // 家长页是内联脚本：抽出整段单独做语法检查，防止模板里的换行把 JS 截断。
    const inline = page.text.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
    expect(inline.length).toBeGreaterThan(1000);
    const inlineFile = join(scratch, 'owner-page.js');
    writeFileSync(inlineFile, inline);
    const check = spawnSync(process.execPath, ['--check', inlineFile], { encoding: 'utf8' });
    expect(check.status, check.stderr || '').toBe(0);
  });
});
