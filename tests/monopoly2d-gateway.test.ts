import { toolForOperation } from './helpers/tool-operations.ts';
/**
 * 快局大富翁的联机验收：
 *
 * 1. 四个隔离身份经 `/v1/join` 入厅、开桌、入座、开局，用真实 HTTP 网关打完一局；
 *    同时验证无押注玩法、严格版本、以及「别人在购买阶段就能看到骰点」的 SSE 刷新。
 * 2. 用源码 World 工具走通「掷骰 → 回执给出购买选项 → 买或放弃」，
 *    确认工具注册、桌号补全、revision 注入和回执私视图都接上了。
 *
 * 这层测试的证据是协议与工具链；浏览器实玩与真实 Coo 会话另记。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pgServerStorage } from './helpers/pg.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { WorldServer } from '../src/room/world-server.ts';
import { PARLOR } from '../src/definition.ts';
import type { ParlorConfigSection } from '../src/config.ts';
import { ParlorClient } from '../src/room/client.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { WorldContext } from 'cortico/world.ts';
import type { ToolCallContext } from 'cortico/core/types.ts';

const A = 'coo-m2d-a00001';
const B = 'coo-m2d-b00002';
const C = 'coo-m2d-c00003';
const D = 'coo-m2d-d00004';

type Json = Record<string, unknown>;

let server: WorldServer | undefined;
let world: ReturnType<typeof PARLOR.create> | undefined;
let scratchDir = '';

afterEach(async () => {
  await world?.stop();
  world = undefined;
  await server?.close();
  server = undefined;
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  scratchDir = '';
});

const start = async (): Promise<WorldServer> => {
  server = await WorldServer.create({ allowGuestJoin: true, ...(await pgServerStorage(':memory:')), port: 0, inviteCode: 'inv' });
  await server.listen();
  return server;
};

const secretFor = (cooId: string): string => `secret-${cooId}-0123456789`;

const cooHeaders = (cooId: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-parlor-coo': cooId,
  'x-parlor-coo-secret': secretFor(cooId),
});

const post = async (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Json };
};

const get = async (base: string, path: string, token: string) => {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() as Json };
};

/** 四个身份都走正常入厅接口，不直插账号表。 */
const enter = async (app: WorldServer, cooId: string, name: string): Promise<string> => {
  const joined = await post(app.url, '/v1/join', { name }, { ...cooHeaders(cooId), 'x-parlor-invite': 'inv' });
  expect(joined.status).toBe(200);
  return joined.body.token as string;
};

const act = async (app: WorldServer, token: string, body: unknown) => post(app.url, '/v1/action', body, {
  authorization: `Bearer ${token}`,
});

const until = async (predicate: () => boolean, timeout = 8000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待超时');
};

/** 边读边攒的 SSE：用来证明「别人在购买阶段就能看到骰点」。 */
const openStream = async (url: string): Promise<{ text: () => string; stop: () => void }> => {
  const controller = new AbortController();
  let buffer = '';
  const response = await fetch(url, { signal: controller.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
    } catch { /* abort 是正常收尾 */ }
  })();
  return { text: () => buffer, stop: () => controller.abort() };
};

interface TurnView {
  token: string;
  cooId: string;
  revision: number;
  turnNo: number;
  phase: string;
  canAct: boolean;
  pending?: number;
  text: string;
}

/** 读一个人的桌面：公开视图给回合号和阶段，私视图给能不能动与版本。 */
const viewOf = async (app: WorldServer, token: string, cooId: string): Promise<TurnView> => {
  const snap = await get(app.url, '/v1/room?limit=1', token);
  const table = (snap.body.table ?? {}) as Json;
  const priv = (snap.body.tablePrivate ?? {}) as Json;
  return {
    token,
    cooId,
    revision: Number(priv.revision ?? table.revision ?? 0),
    turnNo: Number(table.turnNo ?? 0),
    phase: String(table.phase ?? ''),
    canAct: priv.canAct === true,
    ...(typeof table.pending === 'number' ? { pending: table.pending } : {}),
    text: String(priv.text ?? ''),
  };
};

const myTurn = async (app: WorldServer, players: { token: string; cooId: string }[]): Promise<TurnView | null> => {
  for (const player of players) {
    const view = await viewOf(app, player.token, player.cooId);
    if (view.canAct) return view;
  }
  return null;
};

describe('快局大富翁：四个身份经真实网关打完一局', () => {
  it('入厅、拒绝押注、四人开局、掷骰进购买窗、别人能看见骰点、旧版本被拒', async () => {
    const app = await start();
    const tokens = {
      A: await enter(app, A, '阿岚'),
      B: await enter(app, B, '小满'),
      C: await enter(app, C, '小柚'),
      D: await enter(app, D, '小禾'),
    };
    const players = [
      { token: tokens.A, cooId: A },
      { token: tokens.B, cooId: B },
      { token: tokens.C, cooId: C },
      { token: tokens.D, cooId: D },
    ];

    // 无押注玩法：直接 HTTP 也拦住，不靠网页藏按钮。
    const staked = await act(app, tokens.A, { type: 'table_open', game: 'monopoly2d', stake: 5, requestId: 'm2d-stake' });
    expect(staked.status).toBe(400);
    expect(JSON.stringify(staked.body)).toContain('局内金币');

    const opened = await act(app, tokens.A, { type: 'table_open', game: 'monopoly2d', requestId: 'm2d-open' });
    expect(opened.status).toBe(200);
    const table = opened.body.tableId as string;
    for (const [index, token] of [tokens.B, tokens.C, tokens.D].entries()) {
      const joined = await act(app, token, { type: 'table_join', table, requestId: `m2d-join-${index}` });
      expect(joined.status).toBe(200);
    }

    const started = await act(app, tokens.A, { type: 'table_start', table, requestId: 'm2d-start' });
    expect(started.status).toBe(200);
    const startView = await viewOf(app, tokens.A, A);
    expect(startView.turnNo).toBe(1);
    expect(startView.phase).toBe('await_roll');

    // 非行动方的推送：购买阶段也得看见骰点和新落点。
    const watcher = await openStream(`${app.url}/v1/stream?token=${tokens.B}&since=0`);

    let bought = false;
    let sawBuyWindow = false;
    let staleChecked = false;
    for (let step = 0; step < 40 && !bought; step += 1) {
      const turn = await myTurn(app, players);
      expect(turn).not.toBeNull();
      const current = turn!;
      if (current.phase === 'await_buy') {
        sawBuyWindow = true;
        expect(current.pending).toBeTypeOf('number');
        // 购买回执里要有买/放弃两条路，Coo 才不用再刷一次。
        expect(current.text).toContain('买');
        expect(current.text).toContain('pass');
        const decided = await act(app, current.token, {
          type: 'monopoly2d_action', move: 'buy', turnNo: current.turnNo,
          table, revision: current.revision, requestId: `m2d-buy-${step}`,
        });
        expect(decided.status).toBe(200);
        bought = true;
        // 同一版本再打一次必须被拒：这一手已经过去了。
        const stale = await act(app, current.token, {
          type: 'monopoly2d_action', move: 'pass', turnNo: current.turnNo,
          table, revision: current.revision, requestId: `m2d-stale-${step}`,
        });
        expect(stale.status).toBe(409);
        staleChecked = true;
        break;
      }

      const rolled = await act(app, current.token, {
        type: 'monopoly2d_action', move: 'roll', turnNo: current.turnNo,
        table, revision: current.revision, requestId: `m2d-roll-${step}`,
      });
      expect(rolled.status).toBe(200);
    }

    expect(sawBuyWindow).toBe(true);
    expect(bought).toBe(true);
    expect(staleChecked).toBe(true);

    // 旁观者（非行动方）在购买阶段就看到骰点了，不需要额外刷新。
    await until(() => /掷出|走到/.test(watcher.text()));
    watcher.stop();
  });

  it('四个身份一路打到结算：24 手、四行排名、金币与估值对得上', async () => {
    const app = await start();
    const seats = [
      { token: await enter(app, A, '阿岚'), cooId: A },
      { token: await enter(app, B, '小满'), cooId: B },
      { token: await enter(app, C, '小柚'), cooId: C },
      { token: await enter(app, D, '小禾'), cooId: D },
    ];

    const opened = await act(app, seats[0].token, { type: 'table_open', game: 'monopoly2d', requestId: 'm2d-full-open' });
    expect(opened.status).toBe(200);
    const table = opened.body.tableId as string;
    for (const [index, seat] of seats.slice(1).entries()) {
      expect((await act(app, seat.token, {
        type: 'table_join', table, requestId: `m2d-full-join-${index}`,
      })).status).toBe(200);
    }
    expect((await act(app, seats[0].token, { type: 'table_start', table, requestId: 'm2d-full-start' })).status).toBe(200);

    const startedAt = Date.now();
    let turns = 0;
    for (let step = 0; step < 80; step += 1) {
      const snap = await get(app.url, '/v1/room?limit=1', seats[0].token);
      const tableView = (snap.body.table ?? {}) as Json;
      if (tableView.status === 'ended') break;
      expect(tableView.status).toBe('playing');
      const turn = await myTurn(app, seats);
      expect(turn).not.toBeNull();
      const view = turn!;
      // 买得起就买：这条用例只验流程与结算，不验策略。
      const move = view.phase === 'await_buy' ? 'buy' : 'roll';
      const acted = await act(app, view.token, {
        type: 'monopoly2d_action', move, turnNo: view.turnNo,
        table, revision: view.revision, requestId: `m2d-full-${step}`,
      });
      expect(acted.status).toBe(200);
      if (move === 'roll') turns += 1;
    }
    const elapsedMs = Date.now() - startedAt;

    const final = await get(app.url, '/v1/room?limit=1', seats[0].token);
    const ended = (final.body.table ?? {}) as Json;
    expect(ended.status).toBe('ended');
    expect(turns).toBe(24);
    expect(ended.round).toBe(6);

    const ranking = ended.ranking as { seat: string; cash: number; estate: number; total: number; rank: number }[];
    expect(ranking).toHaveLength(4);
    for (const row of ranking) {
      // 结算口径：现金 + 地产按 85% 折价，合计后只取整一次。
      expect(row.total).toBe(row.cash + row.estate);
    }
    expect(ranking.map((row) => row.rank).sort()).toEqual([1, 2, 3, 4]);
    expect(ranking[0].total).toBeGreaterThanOrEqual(ranking[ranking.length - 1].total);

    // 给验收报告留一条可引用的实测：24 手全走 HTTP，含每次快照。
    expect(elapsedMs).toBeLessThan(60_000);
  });
});

describe('快局大富翁：源码 World 工具走通两段动作', () => {
  it('掷骰后回执直接给购买选项，能接着买下', async () => {
    const app = await start();
    scratchDir = mkdtempSync(join(tmpdir(), 'parlor-m2d-world-'));
    const secrets: Record<string, string> = { PARLOR_INVITE_CODE: 'inv', PARLOR_ALLOW_GUEST_JOIN: '1' };
    const base = fakeWorldContext(PARLOR, { scratchDir });
    const ctx: WorldContext<ParlorConfigSection> = {
      ...base,
      secret: (name) => secrets[name] ?? '',
      storeSecret: (name, value) => { secrets[name] = value; },
    };
    ctx.cfg.serverUrl = app.url;
    ctx.cfg.identityUrl = app.url;
    ctx.cfg.room = 'lobby';
    ctx.cfg.seatName = '小满';
    world = PARLOR.create(ctx);
    await world.start(new FakeHost());

    const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
      const tool = toolForOperation(world!, name);
      if (!tool) throw new Error(`没有工具 ${name}`);
      const result = await tool.handler(args, {} as ToolCallContext);
      return typeof result === 'string' ? result : result.text;
    };

    // 三个 Coo 从身份接口进来，Coo 自己开桌占第一席。
    const guests = [
      { client: new ParlorClient(app.url, { cooId: B, cooSecret: secretFor(B) }), name: '小满' },
      { client: new ParlorClient(app.url, { cooId: C, cooSecret: secretFor(C) }), name: '小柚' },
      { client: new ParlorClient(app.url, { cooId: D, cooSecret: secretFor(D) }), name: '小禾' },
    ];
    const guestTokens: string[] = [];
    for (const guest of guests) {
      const joined = await guest.client.join('inv', { name: guest.name }, 'lobby');
      guestTokens.push(joined.token);
    }

    // 三位 Coo 的回合由脚本代走（掷骰或放弃），到了 Coo 自己那一手改走 World 工具。
    // 骰子决定落点：一小部分牌局里 Coo 六手都踩不到空地，所以整局最多打两盘。
    let rolledByTool = false;
    let boughtByTool = false;
    for (let attempt = 0; attempt < 2 && !boughtByTool; attempt += 1) {
      if (attempt > 0) {
        // 上一盘结束了还占着席位，先退桌再开新盘。
        await call('parlor_table_leave');
        for (const [index, guest] of guests.entries()) {
          await guest.client.action(guestTokens[index]!, { type: 'table_leave', requestId: `m2d-world-leave-${index}` }, 'lobby');
        }
      }
      expect(await call('parlor_table_open', { game: 'monopoly2d' })).toContain('桌开了');
      const opened = await guests[0].client.snapshot(guestTokens[0]!, 0, 1, 'lobby');
      const table = opened.table!.id;
      for (const [index, guest] of guests.entries()) {
        await guest.client.action(guestTokens[index]!, {
          type: 'table_join', table, requestId: `m2d-world-join-${attempt}-${index}`,
        }, 'lobby');
      }
      expect(await call('parlor_table_start')).toContain('开局');

      for (let step = 0; step < 40 && !boughtByTool; step += 1) {
        const snap = await guests[0].client.snapshot(guestTokens[0]!, 0, 1, 'lobby');
        const tableView = (snap.table ?? {}) as Json;
        if (tableView.status !== 'playing') break;
        const turnNo = Number(tableView.turnNo);
        const phase = String(tableView.phase ?? '');
        let moved = false;
        for (const [index, guest] of guests.entries()) {
          const own = await guest.client.snapshot(guestTokens[index]!, 0, 1, 'lobby');
          const priv = (own.tablePrivate ?? {}) as Json;
          if (priv.canAct !== true) continue;
          moved = true;
          await guest.client.action(guestTokens[index]!, {
            type: 'monopoly2d_action', move: phase === 'await_buy' ? 'pass' : 'roll', turnNo,
            table, revision: Number(priv.revision), requestId: `m2d-world-guest-${attempt}-${step}`,
          }, 'lobby');
          break;
        }
        if (moved) continue;

        // 三位都不动，说明轮到 Coo 自己。
        if (phase === 'await_buy') {
          expect(await call('parlor_monopoly2d_action', { move: 'buy', turnNo })).toContain('买下');
          boughtByTool = true;
          break;
        }
        expect(await call('parlor_monopoly2d_action', { move: 'roll', turnNo })).toContain('掷');
        rolledByTool = true;
        // 回执里就要给出购买选项或下一手信息，不用再问一次。
        const after = await guests[0].client.snapshot(guestTokens[0]!, 0, 1, 'lobby');
        const afterTable = (after.table ?? {}) as Json;
        if (afterTable.phase === 'await_buy') expect(String(afterTable.pending)).not.toBe('');
      }
    }

    expect(rolledByTool).toBe(true);
    // 六手之内踩到空地的概率约 99.6%，两盘都没踩到说明回合推进或落点结算有问题。
    expect(boughtByTool).toBe(true);
  });
});
