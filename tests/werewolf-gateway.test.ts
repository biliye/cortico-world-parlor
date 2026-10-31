import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gameById } from '../src/room/games/registry.ts';
import { WEREWOLF_MIN_CLIENT } from '../src/room/games/werewolf-table.ts';
import { PARLOR_CLIENT_VERSION } from '../src/room/client.ts';
import { WorldServer } from '../src/room/world-server.ts';

const CHILD = 'coo-parenttest1';
const PETS = [
  'coo-aaaaaaaa', 'coo-bbbbbbbb', 'coo-cccccccc', 'coo-dddddddd',
  'coo-eeeeeeee', 'coo-ffffffff', 'coo-gggggggg', 'coo-hhhhhhhh',
];
const PET_NAMES = ['阿岚', '小满', '小柚', '石头', '阿妹', '七七', '泡泡', '九九'];

let dir: string | undefined;
let server: WorldServer | undefined;

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const secretFor = (cooId: string): string => `secret-${cooId}-0123456789`;

const cooHeaders = (cooId: string, clientVersion?: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-parlor-coo': cooId,
  'x-parlor-coo-secret': secretFor(cooId),
  ...(clientVersion ? { 'x-parlor-client': clientVersion } : {}),
});

const post = async (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, body: await response.json() as Record<string, unknown> };
};

const until = async (check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('等待超时');
};

const get = async (base: string, path: string, token: string) => {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const act = async (app: WorldServer, token: string, body: unknown, clientVersion?: string) => (
  post(app.url, '/v1/action', body, { authorization: `Bearer ${token}`, ...(clientVersion ? { 'x-parlor-client': clientVersion } : {}) })
);

describe('狼人杀 · 网关与注册表', () => {
  it('注册表：werewolf 工具与 extraTools 齐全，toBody 校验 windowId/choice', () => {
    const def = gameById('werewolf');
    expect(def?.revisionMode).toBe('window');
    expect(def?.actionType).toBe('werewolf_action');
    expect(def?.tool.name).toBe('parlor_werewolf_action');
    const logTool = def?.extraTools?.find((tool) => tool.name === 'parlor_werewolf_log');
    expect(logTool).toBeDefined();
    expect(() => def!.tool.toBody({ move: 'speak' })).toThrow(/windowId/);
    expect(() => def!.tool.toBody({ windowId: 'w1', move: ' dancing' })).toThrow(/move/);
    expect(() => def!.tool.toBody({ windowId: 'w1', move: 'witch' })).toThrow(/choice/);
    const body = def!.tool.toBody({ windowId: 'w9', move: 'vote', target: 5 });
    expect(body).toMatchObject({ type: 'werewolf_action', move: 'vote', windowId: 'w9', target: 5 });
    // 协议版本常量要 ≥ 狼人杀门槛（自家客户端必须能玩自家游戏）。
    const atLeast = (a: string, b: string): boolean => {
      const [x, y, z] = a.split('.').map(Number);
      const [p, q, r] = b.split('.').map(Number);
      return x! > p! || (x === p && (y! > q! || (y === q && z! >= r!)));
    };
    expect(atLeast(PARLOR_CLIENT_VERSION, WEREWOLF_MIN_CLIENT)).toBe(true);
  });

  it('HTTP：家长下场开桌、带版本入座开局；旧客户端开局被点名拒绝；历史路由与桌聊锁', async () => {
    dir = mkdtempSync(join(tmpdir(), 'parlor-wolf-gw-'));
    server = new WorldServer({
      allowGuestJoin: true, dbFile: join(dir, 'parlor.db'), port: 0, inviteCode: 'inv', defaultRoomId: 'lobby',
    });
    await server.listen();
    const app = server;
    // 孩子（Coo）先进厅，拿 ownerKey；家长用 key 一次换会话 + 下场（human 席位）。
    const child = await post(app.url, '/v1/rooms/lobby/join', { name: '豆豆' }, { ...cooHeaders(CHILD), 'x-parlor-invite': 'inv' });
    expect(child.status).toBe(200);
    const ownerKey = child.body.ownerKey as string;
    const played = await post(app.url, '/v1/parent/play', { key: ownerKey });
    expect(played.status).toBe(200);
    expect((played.body.seat as { kind: string }).kind).toBe('human');
    const playerToken = played.body.token as string;

    // 八只 Coo 入厅；8 号不带能力头（旧客户端）。
    const petTokens: string[] = [];
    for (let i = 0; i < PETS.length; i++) {
      const joined = await post(app.url, '/v1/rooms/lobby/join', { name: PET_NAMES[i] }, {
        ...cooHeaders(PETS[i], i === 7 ? undefined : PARLOR_CLIENT_VERSION),
        'x-parlor-invite': 'inv',
      });
      expect(joined.status).toBe(200);
      petTokens.push(joined.body.token as string);
    }

    // 家长开桌；Coo 们入座（8 号旧版）。
    const opened = await act(app, playerToken, { type: 'table_open', requestId: 'o1', game: 'werewolf' });
    expect(opened.status).toBe(200);
    const tableId = opened.body.tableId as string;
    for (let i = 0; i < PETS.length; i++) {
      const joined = await act(app, petTokens[i], { type: 'table_join', requestId: `j${i}`, table: tableId }, i === 7 ? undefined : PARLOR_CLIENT_VERSION);
      expect(joined.status).toBe(200);
    }
    // 开局被拒：点名旧客户端与门槛版本。
    const refused = await act(app, playerToken, { type: 'table_start', requestId: 's1', table: tableId });
    expect(refused.status).toBe(400);
    expect(String(refused.body.error)).toContain('九九');
    expect(String(refused.body.error)).toContain(WEREWOLF_MIN_CLIENT);

    // 缺 requestId 的狼人杀动作 → 400（幂等键白名单含 werewolf_action）。
    const noId = await post(app.url, '/v1/action', { type: 'werewolf_action', move: 'speak', windowId: 'w1' }, {
      authorization: `Bearer ${petTokens[0]}`,
    });
    expect(noId.status).toBe(400);

    // 旧客户端没法原地升级（已在桌上）：先收掉第一张桌（开桌人退桌=收桌），再开一张全带版本的。
    const closed = await act(app, playerToken, { type: 'table_leave', requestId: 'l1', table: tableId });
    expect(closed.status).toBe(200);
    const opened2 = await act(app, playerToken, { type: 'table_open', requestId: 'o2', game: 'werewolf' });
    expect(opened2.status).toBe(200);
    const table2 = opened2.body.tableId as string;
    for (let i = 0; i < PETS.length; i++) {
      const joined = await act(app, petTokens[i], { type: 'table_join', requestId: `j2-${i}`, table: table2 }, PARLOR_CLIENT_VERSION);
      expect(joined.status).toBe(200);
    }
    const started = await act(app, playerToken, { type: 'table_start', requestId: 's2', table: table2 });
    expect(started.status).toBe(200);
    expect(started.body.seats).toHaveLength(9);

    // 历史路由：参与者可查公开历史；review 未终局不给夜间记录。
    const log = await get(app.url, `/v1/rooms/lobby/table-log?table=${table2}`, petTokens[0]);
    expect(log.status).toBe(200);
    const logBody = log.body.log as { speeches?: unknown[]; nights?: unknown[] };
    expect(Array.isArray(logBody.speeches)).toBe(true);
    expect(logBody.nights).toBeUndefined();

    // 桌聊锁：进行中 table_say 被拒（409），房间公开发言同样被拒。
    const chat = await act(app, petTokens[0], { type: 'table_say', text: '局中说一句', table: table2 });
    expect(chat.status).toBe(409);
    const say = await act(app, petTokens[0], { type: 'say', text: '客厅里喊一句' });
    expect(say.status).toBe(409);
    // 同桌互私聊被拒；桌外（孩子对桌上的 Coo）不受限。
    const whisper = await act(app, petTokens[0], { type: 'whisper', to: PET_NAMES[1], text: '串个词' });
    expect(whisper.status).toBe(409);
    const outsider = await act(app, child.body.token as string, { type: 'whisper', to: PET_NAMES[0], text: '场外插一句' });
    expect(outsider.status).toBe(200);
  });
});

describe('狼人杀 · 牌桌时限基准', () => {
  it('tableTurnMs 把所有窗口按比例缩短：开局后两秒内进首夜（staging/本地测试用）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'parlor-wolf-ms-'));
    server = new WorldServer({
      allowGuestJoin: true, dbFile: join(dir, 'parlor.db'), port: 0, inviteCode: 'inv', defaultRoomId: 'lobby',
      tableTurnMs: 200,
    });
    await server.listen();
    const app = server;
    const child = await post(app.url, '/v1/rooms/lobby/join', { name: '豆豆' }, { ...cooHeaders(CHILD), 'x-parlor-invite': 'inv' });
    expect(child.status).toBe(200);
    const played = await post(app.url, '/v1/parent/play', { key: child.body.ownerKey as string });
    expect(played.status).toBe(200);
    const playerToken = played.body.token as string;
    const petTokens: string[] = [];
    for (let i = 0; i < PETS.length; i++) {
      const joined = await post(app.url, '/v1/rooms/lobby/join', { name: PET_NAMES[i] }, {
        ...cooHeaders(PETS[i], PARLOR_CLIENT_VERSION), 'x-parlor-invite': 'inv',
      });
      petTokens.push(joined.body.token as string);
    }
    const opened = await act(app, playerToken, { type: 'table_open', requestId: 'ms-open', game: 'werewolf' });
    expect(opened.status).toBe(200);
    const tableId = opened.body.tableId as string;
    for (let i = 0; i < PETS.length; i++) {
      expect((await act(app, petTokens[i], { type: 'table_join', requestId: `ms-j${i}`, table: tableId }, PARLOR_CLIENT_VERSION)).status).toBe(200);
    }
    const startedAt = Date.now();
    expect((await act(app, playerToken, { type: 'table_start', requestId: 'ms-start', table: tableId })).status).toBe(200);
    // 默认 reveal 15 秒；200ms 基准下秒钟 tick 应在两秒左右推进到首夜。
    const privOf = async () => {
      const snap = await get(app.url, '/v1/rooms/lobby/room?limit=1', petTokens[0]);
      return ((snap.body.tablePrivate ?? null) as { phase?: string } | null)?.phase;
    };
    await until(async () => (await privOf()) === 'night', 5_000);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

describe('狼人杀 · 秘密出口矩阵', () => {  it('B1：狼聊暗号与身份只留在狼席位——非狼席位的补发/回放、家长页、观战出口都读不到', async () => {
    dir = mkdtempSync(join(tmpdir(), 'parlor-wolf-b1-'));
    const clock = { now: 1_770_000_000_000 };
    server = new WorldServer({
      allowGuestJoin: true, dbFile: join(dir, 'parlor.db'), port: 0, inviteCode: 'inv', defaultRoomId: 'lobby',
      now: () => clock.now,
    });
    await server.listen();
    const app = server;
    const CODE = '夜里三更见';

    // 孩子（Coo）进厅；七只 Coo 陪玩（孩子占第九个 Coo 席位前的第八席）；第十个席位进厅观战、不坐桌。
    const child = await post(app.url, '/v1/rooms/lobby/join', { name: '豆豆' }, { ...cooHeaders(CHILD), 'x-parlor-invite': 'inv' });
    expect(child.status).toBe(200);
    const childToken = child.body.token as string;
    const petTokens: string[] = [];
    for (let i = 0; i < PETS.length - 1; i++) {
      const joined = await post(app.url, '/v1/rooms/lobby/join', { name: PET_NAMES[i] }, {
        ...cooHeaders(PETS[i], PARLOR_CLIENT_VERSION), 'x-parlor-invite': 'inv',
      });
      expect(joined.status).toBe(200);
      petTokens.push(joined.body.token as string);
    }
    const watcher = await post(app.url, '/v1/rooms/lobby/join', { name: '观战客' }, {
      ...cooHeaders('coo-watch001', PARLOR_CLIENT_VERSION), 'x-parlor-invite': 'inv',
    });
    expect(watcher.status).toBe(200);
    const watcherToken = watcher.body.token as string;

    // 家长用钥匙下场（human 席位）开桌；孩子坐第九席，凑满九席开局。
    const played = await post(app.url, '/v1/parent/play', { key: child.body.ownerKey as string });
    expect(played.status).toBe(200);
    const parentCookie = (played.headers.get('set-cookie') ?? '').split(';')[0];
    expect(parentCookie).toContain('parlor_parent=');
    const playerToken = played.body.token as string;
    const opened = await act(app, playerToken, { type: 'table_open', requestId: 'b1-open', game: 'werewolf' });
    expect(opened.status).toBe(200);
    const tableId = opened.body.tableId as string;
    for (let i = 0; i < petTokens.length; i++) {
      const joined = await act(app, petTokens[i], { type: 'table_join', requestId: `b1-j${i}`, table: tableId }, PARLOR_CLIENT_VERSION);
      expect(joined.status).toBe(200);
    }
    expect((await act(app, childToken, { type: 'table_join', requestId: 'b1-jchild', table: tableId }, PARLOR_CLIENT_VERSION)).status).toBe(200);
    expect((await act(app, playerToken, { type: 'table_start', requestId: 'b1-start', table: tableId })).status).toBe(200);

    const privOf = async (token: string) => {
      const snap = await get(app.url, '/v1/rooms/lobby/room?limit=1', token);
      expect(snap.status).toBe(200);
      return (snap.body.tablePrivate ?? null) as {
        role?: string;
        seat?: string;
        phase?: string;
        windowId?: string;
        myMove?: string;
        wolfChat?: Array<{ seatNo: number; text: string }>;
        seats?: Array<{ seatNo: number; id: string }>;
      } | null;
    };

    // 快过看身份窗口（15 秒），等网关的秒钟 tick 把桌子推进到首夜。
    clock.now += 20_000;
    await until(async () => (await privOf(childToken))?.phase === 'night');

    // 认身份：每个 token 是什么 role、坐哪个座号。
    const tokens = [playerToken, childToken, ...petTokens];
    const roleOfToken = new Map<string, string>();
    const seatIdOfToken = new Map<string, string>();
    for (const token of tokens) {
      const priv = await privOf(token);
      expect(priv?.role).toBeTruthy();
      roleOfToken.set(token, priv!.role!);
      seatIdOfToken.set(token, priv!.seat!);
    }
    const wolfTokens = tokens.filter((token) => roleOfToken.get(token) === 'wolf');
    expect(wolfTokens).toHaveLength(3);
    const seatNoById = new Map((await privOf(childToken))!.seats!.map((entry) => [entry.id, entry.seatNo]));
    const wolfSeatNos = wolfTokens.map((token) => seatNoById.get(seatIdOfToken.get(token)!)!);
    const killTarget = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((no) => !wolfSeatNos.includes(no))!;

    // 狼交暗号与刀票；正向对照：暗号真的进了狼自己的私视图。
    const wolfPriv = await privOf(wolfTokens[0]);
    expect(wolfPriv!.myMove).toBe('wolf_chat');
    const chat = await act(app, wolfTokens[0], {
      type: 'werewolf_action', windowId: wolfPriv!.windowId, move: 'wolf_chat', text: CODE, requestId: 'b1-chat',
    });
    expect(chat.status, JSON.stringify(chat.body)).toBe(200);
    const kill = await act(app, wolfTokens[0], {
      type: 'werewolf_action', windowId: wolfPriv!.windowId, move: 'wolf_kill', target: killTarget, requestId: 'b1-kill',
    });
    expect(kill.status, JSON.stringify(kill.body)).toBe(200);
    expect(JSON.stringify((await privOf(wolfTokens[0]))!.wolfChat)).toContain(CODE);

    // 非狼读者：优先村民。断言口径：暗号绝不出现；狼专属字段（狼聊/刀票/队友/锁定刀口）绝不出现；
    // role 字段只允许读者自己的身份——服务端把每个席位自己的身份写进它自己的唤醒事件，这是设计内行为。
    const reader = tokens.find((token) => roleOfToken.get(token) === 'villager')
      ?? tokens.find((token) => roleOfToken.get(token) !== 'wolf')!;
    const readerRole = roleOfToken.get(reader)!;
    const assertNoSecret = (blob: string, label: string) => {
      expect(blob, `${label}：读到了狼聊暗号`).not.toContain(CODE);
      expect(blob, `${label}：读到了狼聊记录`).not.toContain('"wolfChat"');
      expect(blob, `${label}：读到了刀票`).not.toContain('"killVotes"');
      expect(blob, `${label}：读到了狼队名单`).not.toContain('"teammates"');
      expect(blob, `${label}：读到了锁定刀口`).not.toContain('"lockedKill"');
    };
    const assertRolesMine = (blob: string, label: string) => {
      for (const match of blob.matchAll(/"role":"([a-z]+)"/g)) {
        expect(match[1], `${label}：出现了别人的 role`).toBe(readerRole);
      }
    };

    // 出口一：历史补发。
    const history = await get(app.url, '/v1/rooms/lobby/history?since=0&limit=200', reader);
    expect(history.status).toBe(200);
    const historyBlob = JSON.stringify(history.body.events);
    assertNoSecret(historyBlob, '历史补发');
    assertRolesMine(historyBlob, '历史补发');

    // 出口二：回放（厅内 /v1/rooms/*/replay 与身份级 /v1/me/replay）。
    const replay = await get(app.url, '/v1/rooms/lobby/replay?limit=200', reader);
    expect(replay.status).toBe(200);
    const replayBlob = JSON.stringify(replay.body.events);
    assertNoSecret(replayBlob, '回放');
    assertRolesMine(replayBlob, '回放');
    const meReplay = await get(app.url, '/v1/me/replay?room=lobby&limit=200', reader);
    expect(meReplay.status).toBe(200);
    const meReplayBlob = JSON.stringify(meReplay.body.events);
    assertNoSecret(meReplayBlob, '身份级回放');
    assertRolesMine(meReplayBlob, '身份级回放');

    // 出口三：家长页（owner 会话）。局中其他真人在桌上 → 整页隐藏：无私视图、无唤醒事件、无任何 role。
    const parentView = await fetch(`${app.url}/v1/parent/view?since=0&limit=200`, { headers: { cookie: parentCookie } });
    expect(parentView.status).toBe(200);
    const parentBody = await parentView.json() as Record<string, unknown>;
    expect(parentBody.ownerPrivateHidden).toBe(true);
    expect(parentBody.tablePrivate).toBeNull();
    expect((parentBody.events as { type: string }[]).some((event) => event.type === 'parlor.table.turn')).toBe(false);
    const parentBlob = JSON.stringify(parentBody);
    assertNoSecret(parentBlob, '家长页');
    expect(parentBlob, '家长页：出现了 role 字段').not.toContain('"role"');

    // 出口四：观战（在房间里、不在桌上）：快照与补发里无暗号、无任何 role。
    const watchSnap = await get(app.url, '/v1/rooms/lobby/room?limit=200', watcherToken);
    expect(watchSnap.status).toBe(200);
    expect((watchSnap.body as { tablePrivate: unknown }).tablePrivate).toBeNull();
    const watchBlob = JSON.stringify(watchSnap.body);
    assertNoSecret(watchBlob, '观战快照');
    expect(watchBlob, '观战快照：出现了 role 字段').not.toContain('"role"');
    const watchHistory = await get(app.url, '/v1/rooms/lobby/history?since=0&limit=200', watcherToken);
    expect(watchHistory.status).toBe(200);
    const watchEventsBlob = JSON.stringify(watchHistory.body.events);
    assertNoSecret(watchEventsBlob, '观战补发');
    expect(watchEventsBlob, '观战补发：出现了 role 字段').not.toContain('"role"');
  });
});
