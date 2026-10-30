/**
 * 网页客户端与家长下场：玩家入场、防作弊、公开棋盘、斗地主提示、静态资源。
 * 这些测试不碰浏览器，只走 HTTP；页面本身由 state/tools 里的浏览器冒烟另行目击。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ParlorServer } from '../src/room/server.ts';
import type { PlayerJoinResponse, RoomSnapshot } from '../src/room/protocol.ts';

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
    expect(page.text).toContain('/play/assets/play.js');

    const js = await call('/play/assets/play.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
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

  it('家长用自己的席位与账本身份入场，不占用孩子的账本', async () => {
    const papa = await playerJoin('Papa');
    expect(papa.seat.kind).toBe('human');
    expect(papa.seat.tier).toBe('off');
    const snapshot = await snap(papa, '?limit=1');
    expect(snapshot.seat.id).toBe(papa.seat.id);
    expect(snapshot.ledger?.chips).toBe(1000);

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

  it('奶油客厅没有赌场文案，筹码图同源，聊天三 tab 的边界写清楚', () => {
    const css = readFileSync(new URL('../src/web/play.css', import.meta.url), 'utf8');
    const js = readFileSync(new URL('../src/web/play.js', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../src/web/play.html', import.meta.url), 'utf8');
    expect(css).toContain('assets/coo-chip.png');
    expect(html).toContain('content="#fff8ee"');
    for (const text of [css, js, html]) {
      expect(text).not.toContain('底池');
      expect(text).not.toContain('底注');
      expect(text).not.toContain('净胜');
    }
    // 牌桌 tab 现在发的是桌内私聊；这句话是给玩家看的边界说明。
    expect(js).toContain('只发到这一桌');
    expect(js).toContain('客厅和不在桌上的人看不见');
    expect(js).toContain('你不在这一桌');
    expect(js).toContain("type: 'table_say'");
    // 出牌/过牌这类牌桌动作不进聊天栏，只留人说的话。
    expect(js).toContain("type.startsWith('parlor.table.') && type !== 'parlor.table.say'");
    expect(js).toContain("type.startsWith('parlor.monopoly.')");
    // 牌桌栏只放桌内私聊：客厅的公开发言（哪怕出自桌上席位）只在客厅栏。
    expect(js).toContain("return (event.type || '') === 'parlor.table.say';");
    expect(js).toContain('客厅的聊天在「客厅」那一栏');
  });

  it('带钥匙的「我下场玩」链接直接下场；席位被顶掉时不自动重入', () => {
    const js = readFileSync(new URL('../src/web/play.js', import.meta.url), 'utf8');
    // 面板的 #key= 链接：换家长会话 → 领席位 → 进牌桌；钥匙用完从地址栏抹掉。
    expect(js).toContain('function takeKeyFromHash');
    expect(js).toContain('history.replaceState(null, \'\', location.pathname + location.search)');
    expect(js).toContain('function tryParentEntry');
    expect(js).toContain("fetch('/v1/parent/session'");
    expect(js).toContain("fetch('/v1/parent/play'");
    // 没有钥匙但浏览器已有家长会话：也直接下场（书签/刷新都能进）。
    expect(js).toContain('function hasParentSession');
    // 一个家长身份只有一个席位：401 时给「被另一台顶掉」的提示，不静默重入。
    expect(js).toContain('可能被另一台设备顶掉了');
    expect(js).toContain('点下面的「以家长身份下场」重新进来');
  });

  it('大厅是一个真页面：在线的人、客厅目录、开一间、离开客厅', () => {
    const js = readFileSync(new URL('../src/web/play.js', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/web/play.css', import.meta.url), 'utf8');
    // 大厅是服务器上的位置，不是本地一张空页面：离开客厅要过 /switch。
    for (const line of [
      'view-hall', 'function loadHall', '离开客厅', "api('/v1/hall')", "api('/v1/rooms?all=1')",
      "navButton('hall'", "viewButton('大厅', 'hall')", 'createHallRoom', '先在大厅挑一间客厅进去',
    ]) {
      expect(js).toContain(line);
    }
    expect(css).toContain('.view-hall');
    expect(css).toContain('.hall-create');
    // 旧标签页的 401 不能删掉别的标签页刚写进去的新令牌（否则像被登出）。
    expect(js).toContain('function handleExpiredSeat');
    expect(js).toContain('stored.token !== token');
    // 家长页能下场；加入页在有家长会话时给「以家长身份下场」。
    expect(js).toContain('offerParentPlay');
    expect(js).toContain("'/v1/parent/play'");
    const parent = readFileSync(new URL('../src/web/parent.js', import.meta.url), 'utf8');
    expect(parent).toContain('playAsParent');
    expect(parent).toContain("localStorage.setItem('parlor-play-v1'");
    // 家长页能改名字：一个接口同时改账户名、玩家身份名、当前席位名。
    expect(parent).toContain('openRename');
    expect(parent).toContain("'/v1/parent/rename'");
    expect(parent).toContain('改名字');
  });

  it('加入页不会被空刷新重画：窗口一获得焦点，正在填的名字就没了', () => {
    const js = readFileSync(new URL('../src/web/play.js', import.meta.url), 'utf8');
    // 加入页没有席位时，focus/visibilitychange 触发的刷新会 401；
    // 旧代码把它当成「令牌失效」重画整块表单，名字被清空、还多一行红字，看上去就是进不去。
    const schedule = js.match(/function scheduleRefresh\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(schedule).toContain('if (!state.cfg) return;');
    const expired = js.match(/function handleExpiredSeat\(token\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(expired).toContain('if (!stored && !state.cfg) return;');
    // 真的失效时仍要回加入页并说明原因。
    expect(expired).toContain('renderJoin(');
    expect(expired).toContain('这个席位的令牌已经失效');
  });

  it('建房可选 8/16/30 人', () => {
    const js = readFileSync(new URL('../src/web/play.js', import.meta.url), 'utf8');
    expect(js).toContain('const ROOM_CAPACITY_CHOICES = [8, 16, 30]');
    expect(js).toContain('capacity: Number(ui.hallCreateCap.value)');
    expect(js).toContain('capacity: Number(capInput.value)');
  });

  it('私聊浮窗：入口在信箱旁、可拖拽、点窗外关闭、离线也投递', () => {
    const js = readFileSync(new URL('../src/web/play.js', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/web/play.css', import.meta.url), 'utf8');
    for (const line of [
      'function ensureDmWindow', 'function toggleDm', 'dm-btn', "api('/v1/dm/threads')",
      "'/v1/dm?peer='", "'/v1/people?q='", 'parlor-dm-pos-v1', "event.key === 'Escape'",
      "item.kind === 'whisper' && item.fromCooId",
    ]) {
      expect(js).toContain(line);
    }
    // 私聊只进浮窗，不再混进大厅/客厅的聊天栏。
    expect(js).toContain("if (type === 'parlor.whisper') return null;");
    expect(js).not.toContain('is-whisper');
    // 点浮窗外面关掉、手机上是全屏。
    expect(js).toContain('win.contains(event.target)');
    expect(css).toContain('.dm {');
    expect(css).toContain('@media (max-width: 820px)');
    expect(css).toContain('.dm-msg.is-me');
  });

  it('网页的游戏入口来自注册表：只露斗地主，骰子和大富翁收起', () => {
    const js = readFileSync(new URL('../src/web/play.js', import.meta.url), 'utf8');
    const reg = readFileSync(new URL('../src/web/games/registry.js', import.meta.url), 'utf8');
    const ddz = readFileSync(new URL('../src/web/games/ddz.js', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/web/play.css', import.meta.url), 'utf8');
    // 入口清单只在注册表里；play.js 不再写死游戏名单。
    expect(js).toContain("from './games/registry.js'");
    expect(js).not.toContain("const ENABLED_GAMES = ['ddz']");
    for (const line of ["label: '斗地主'", "label: '骰子'", "label: '大富翁'", 'enabled: true', 'enabled: false', 'guide: [']) {
      expect(reg).toContain(line);
    }
    expect(reg).toContain('先收起来了');
    // 只启用了斗地主：大厅卡片、开桌按钮与玩法说明都从注册表取。
    expect(reg).toMatch(/ddz: \{[\s\S]*enabled: true/);
    expect(js).toContain('gameLabel(hero)');
    expect(js).toContain('renderGuides');
    expect(js).toContain('endEvent');
    expect(ddz).toContain('ddz-end');
    expect(css).toContain('.ddz-end-seats');
    expect(css).toContain('.ddz-guide');
  });

  it('网页脚本语法正确，家长页有牌桌面板与下场入口', async () => {
    const files = [
      'src/web/play.js',
      'src/web/common.js',
      'src/web/games/dice.js',
      'src/web/games/ddz.js',
      'src/web/games/monopoly.js',
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
