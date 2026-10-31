#!/usr/bin/env node
/**
 * 狼人杀 HTTP 级端到端：真起网关子进程（独立临时库），九席打完整局。
 *
 * 覆盖（设计稿批次1的「独立临时数据跑通完整九席局」+ 恢复在真进程上的验证）：
 *   fast        1 真人 + 8 Coo：旧客户端开局点名拒绝 → 全员开局 → 中途旁路封堵与
 *               requestId 幂等 → 打到终局 → 历史恰好一条 end、身份揭牌、table-log 路由。
 *   restart     打到第 1 夜杀掉网关进程 → 原库重启 → 截止平移（rearm）→ 续打到终局。
 *   humans2     2 真人 + 7 Coo 完整一局，途中挂一条 SSE 流核对事件真在推。
 *
 * 用法（包根目录）：
 *   node --experimental-strip-types scripts/werewolf-e2e.ts [--turn-ms 300] [--scenarios fast,restart,humans2] [--keep]
 *
 * --turn-ms 是牌桌时限基准（毫秒）：各窗口按比例缩，300ms 一局几十秒。
 * 不带参数 = 正式时长（一局 20 分钟以上，只建议真实验证时用）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PARLOR_CLIENT_VERSION = '0.29.0';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!, process.argv[i + 1]!);
const TURN_MS = Number(args.get('--turn-ms') ?? 300);
const SCENARIOS = (args.get('--scenarios') ?? 'fast,restart,humans2').split(',').map((s) => s.trim()).filter(Boolean);
const KEEP = args.get('--keep') === 'true';

if (!Number.isFinite(TURN_MS) || TURN_MS <= 0) { console.error('--turn-ms 要是正的毫秒数'); process.exit(2); }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    if (address && typeof address === 'object') {
      const port = address.port;
      probe.close(() => resolve(port));
    } else {
      probe.close(() => reject(new Error('拿不到空闲端口')));
    }
  });
  probe.on('error', reject);
});

interface Server {
  child: ChildProcess;
  base: string;
  dbFile: string;
  dir: string;
}

const bootServer = async (dir: string, dbFile: string): Promise<Server> => {
  const port = await freePort();
  const child = spawn(process.execPath, [
    '--experimental-strip-types', join(PACKAGE_ROOT, 'scripts', 'serve-world.ts'),
    '--host', '127.0.0.1', '--port', String(port),
    '--invite', 'e2e-invite', '--db', dbFile, '--default-room', 'lobby',
    '--identity-authority', 'self', '--public-url', `http://127.0.0.1:${port}`,
    '--allow-guest-join', 'true', '--table-turn-ms', String(TURN_MS),
  ], { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[serve] ${chunk}`));
  const base = `http://127.0.0.1:${port}`;
  // 等 healthz 就绪。
  for (let i = 0; i < 200; i++) {
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) return { child, base, dbFile, dir };
    } catch { /* 还没起 */ }
    await sleep(100);
  }
  child.kill();
  throw new Error('网关 20 秒内没起来');
};

const stopServer = (server: Server): Promise<void> => new Promise((resolve) => {
  server.child.once('exit', () => resolve());
  server.child.kill('SIGTERM');
});

const post = async (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: Record<string, unknown>;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { raw: text }; }
  return { status: response.status, body: json };
};

const get = async (base: string, path: string, token: string) => {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const COO_HEADERS = (cooId: string, version?: string): Record<string, string> => ({
  'x-parlor-coo': cooId,
  'x-parlor-coo-secret': `secret-${cooId}-0123456789`,
  ...(version ? { 'x-parlor-client': version } : {}),
});

interface Seat {
  token: string;
  name: string;
  no: number; // 桌上座号（开局后从私视图认）
  seq: number;
  role?: string;
}

/** 组一桌人：humans 个家长下场（各借一只 Coo 的钥匙），其余是 Coo 席位。 */
const setupTable = async (
  base: string,
  humans: number,
  pets: number,
  opts: { stalePet?: number } = {},
): Promise<{ seats: Seat[]; tableId: string; watcherToken: string | null }> => {
  const seats: Seat[] = [];
  // 先进厅的 Coo 当「孩子」，家长借他们的 ownerKey 下场。
  for (let i = 0; i < humans; i++) {
    const kid = await post(base, '/v1/rooms/lobby/join', { name: `孩子${i + 1}` }, { ...COO_HEADERS(`coo-e2e-kid${i}`), 'x-parlor-invite': 'e2e-invite' });
    if (kid.status !== 200) throw new Error(`孩子进厅失败：${JSON.stringify(kid.body)}`);
    const played = await post(base, '/v1/parent/play', { key: kid.body.ownerKey });
    if (played.status !== 200) throw new Error(`家长下场失败：${JSON.stringify(played.body)}`);
    seats.push({ token: played.body.token as string, name: `真人${i + 1}`, no: 0, seq: 0 });
  }
  for (let i = 0; i < pets; i++) {
    const stale = opts.stalePet === i;
    const joined = await post(base, '/v1/rooms/lobby/join', { name: `Coo${i + 1}` }, {
      ...COO_HEADERS(`coo-e2e-pet${i}`, stale ? undefined : PARLOR_CLIENT_VERSION),
      'x-parlor-invite': 'e2e-invite',
    });
    if (joined.status !== 200) throw new Error(`Coo 进厅失败：${JSON.stringify(joined.body)}`);
    seats.push({ token: joined.body.token as string, name: `Coo${i + 1}`, no: 0, seq: 0 });
  }
  // 场外观战者（不坐桌），测旁路放行用。
  let watcherToken: string | null = null;
  const watcher = await post(base, '/v1/rooms/lobby/join', { name: '场外客' }, { ...COO_HEADERS('coo-e2e-watch', PARLOR_CLIENT_VERSION), 'x-parlor-invite': 'e2e-invite' });
  if (watcher.status === 200) watcherToken = watcher.body.token as string;

  const act = (token: string, body: Record<string, unknown>, version?: string) =>
    post(base, '/v1/action', body, { authorization: `Bearer ${token}`, ...(version ? { 'x-parlor-client': version } : {}) });

  const open = async (by: Seat, tag: string, staleIndex?: number): Promise<string> => {
    const opened = await act(by.token, { type: 'table_open', requestId: `${tag}-open`, game: 'werewolf' });
    if (opened.status !== 200) throw new Error(`开桌失败：${JSON.stringify(opened.body)}`);
    const tableId = opened.body.tableId as string;
    // open 已经把开桌者自己坐下；其余席位逐个 join。staleIndex 只在门禁检查那张桌上生效。
    for (const [i, seat] of seats.entries()) {
      if (i === 0) continue;
      const version = staleIndex !== undefined && i - humans === staleIndex ? undefined : PARLOR_CLIENT_VERSION;
      const joined = await act(seat.token, { type: 'table_join', requestId: `${tag}-j${i}`, table: tableId }, version);
      if (joined.status !== 200) throw new Error(`入座失败（${seat.name}）：${JSON.stringify(joined.body)}`);
    }
    return tableId;
  };

  if (opts.stalePet !== undefined) {
    // 旧客户端在场：开局必须被点名拒绝。
    const tableId = await open(seats[0]!, 'stale', opts.stalePet);
    const refused = await act(seats[0]!.token, { type: 'table_start', requestId: 'stale-start', table: tableId });
    if (refused.status !== 400) throw new Error(`旧客户端没被拒：${refused.status}`);
    const message = String(refused.body.error ?? '');
    if (!message.includes(PARLOR_CLIENT_VERSION) || !message.includes('Coo')) {
      throw new Error(`拒绝文案没点名旧客户端与门槛：${message}`);
    }
    console.log(`  ✓ 旧客户端开局被点名拒绝（要求 ≥ ${PARLOR_CLIENT_VERSION}）`);
    const closed = await act(seats[0]!.token, { type: 'table_leave', requestId: 'stale-leave', table: tableId });
    if (closed.status !== 200) throw new Error(`收桌失败：${JSON.stringify(closed.body)}`);
    for (const seat of seats) seat.seq = 0;
  }

  const tableId = await open(seats[0]!, 'main');
  const started = await act(seats[0]!.token, { type: 'table_start', requestId: 'main-start', table: tableId });
  if (started.status !== 200) throw new Error(`开局失败：${JSON.stringify(started.body)}`);

  // 认座号与身份：每人私视图里有 seatNo 与 role。
  for (const seat of seats) {
    const snap = await get(base, '/v1/rooms/lobby/room?limit=1', seat.token);
    const priv = snap.body.tablePrivate as { seatNo?: number; role?: string } | null;
    if (!priv?.seatNo) throw new Error(`${seat.name} 私视图里没有座号`);
    seat.no = priv.seatNo;
    seat.role = priv.role;
  }
  return { seats, tableId, watcherToken };
};

type PolicyResult = Record<string, unknown> | null;

/** 快速终局策略：狼队抱团刀最小座号、抱团投票；好人随机；女巫四成救、毒五成毒人。 */
const quickPolicy = (seat: Seat, priv: Record<string, unknown>): PolicyResult => {
  const rng = Math.random;
  const meNo = priv.seatNo as number;
  const aliveOthers = ((priv.seats as Array<{ seatNo: number; alive: boolean }>) ?? [])
    .filter((entry) => entry.alive && entry.seatNo !== meNo).map((entry) => entry.seatNo);
  const pick = (pool: number[]): number | null => (pool.length ? pool[Math.floor(rng() * pool.length)]! : null);
  const mates = new Set(((priv.teammates as Array<{ seatNo: number }>) ?? []).map((mate) => mate.seatNo));
  switch (priv.myMove as string) {
    case 'speak':
      return rng() < 0.15
        ? { move: 'pass_speech' }
        : { move: 'speak', text: `${meNo}号觉得${pick(aliveOthers) ?? meNo}号今天眼神躲闪（e2e 正文）。` };
    case 'vote': {
      if ((priv.voteVariant as string) === 'pk') {
        const pkSeats = (priv.pkSeats as number[]) ?? [];
        return pkSeats.length ? { move: 'vote', target: pkSeats[Math.floor(rng() * pkSeats.length)] } : { move: 'vote' };
      }
      const pool = seat.role === 'wolf'
        ? aliveOthers.filter((no) => !mates.has(no))
        : aliveOthers;
      const target = pick(pool);
      return target === null ? { move: 'vote' } : { move: 'vote', target };
    }
    case 'wolf_chat':
      return { move: 'wolf_chat', text: `[e2e狼聊] 刀最小座号。` };
    case 'wolf_kill': {
      const targets = aliveOthers.filter((no) => !mates.has(no));
      return targets.length ? { move: 'wolf_kill', target: Math.min(...targets) } : { move: 'wolf_kill' };
    }
    case 'inspect': {
      const target = pick(aliveOthers);
      return target === null ? { move: 'inspect' } : { move: 'inspect', target };
    }
    case 'witch': {
      const potions = (priv.potions ?? {}) as { antidote: number; poison: number };
      const known = priv.knownKill as number | null | undefined;
      if (potions.antidote > 0 && known !== null && known !== undefined && (known !== meNo || priv.day === 1) && rng() < 0.4) {
        return { move: 'witch', choice: 'save' };
      }
      if (potions.poison > 0 && rng() < 0.5) {
        const target = pick(aliveOthers);
        if (target !== null) return { move: 'witch', choice: 'poison', target };
      }
      return { move: 'witch', choice: 'none' };
    }
    case 'shoot': {
      if (rng() < 0.6) {
        const target = pick(aliveOthers);
        if (target !== null) return { move: 'shoot', target };
      }
      return { move: 'shoot' };
    }
    default:
      return null;
  }
};

/** 轮询驱动一整局：每席位轮询私视图，能行动就按策略行动，直到终局。 */
const driveToEnd = async (
  base: string,
  seats: Seat[],
  policy: (seat: Seat, priv: Record<string, unknown>) => PolicyResult,
  hooks: {
    onAct?: (seat: Seat, priv: Record<string, unknown>, result: { status: number; body: Record<string, unknown> }, sent: Record<string, unknown>) => void;
  } = {},
): Promise<{ endEvent: Record<string, unknown>; history: Record<string, unknown> }> => {
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 10 * 60_000) throw new Error('一局 10 分钟没打完（时限基准太小或状态机卡住）');
    for (const seat of seats) {
      const snap = await get(base, '/v1/rooms/lobby/room?limit=1', seat.token);
      if (snap.status !== 200) throw new Error(`快照失败（${seat.name}）：${snap.status}`);
      const table = snap.body.table as { status?: string } | null;
      if (table?.status === 'ended') {
        // history 单次封顶 200 条、since=0 是从最旧开始：终局事件在尾巴上，按 latest 拉尾部。
        const latest = Number(snap.body.latest ?? 0) || 0;
        const since = Math.max(0, latest - 200);
        const history = await get(base, `/v1/rooms/lobby/history?since=${since}&limit=200`, seat.token);
        const events = (history.body.events as Array<{ type: string; data?: Record<string, unknown> }>) ?? [];
        const ends = events.filter((event) => event.type === 'parlor.table.end');
        if (ends.length !== 1) {
          const tail = events.slice(-8).map((event) => `${event.type}: ${String((event as { text?: string }).text ?? '').slice(0, 60)}`);
          throw new Error(`终局事件应该恰好一条，实际 ${ends.length}（触发席位 ${seat.name}，其快照桌 ${JSON.stringify(table)}）；事件总数 ${events.length}，latest=${latest}，末尾：\n  ${tail.join('\n  ')}`);
        }
        return { endEvent: ends[0]!, history: history.body };
      }
      const priv = snap.body.tablePrivate as Record<string, unknown> | null;
      if (!priv?.canAct || !priv.myMove) continue;
      const windowId = priv.windowId as string;
      const body = policy(seat, priv);
      if (!body) continue;
      const requestId = `a-${seat.no}-${windowId}-${priv.myMove}-${++seat.seq}`;
      const sent = { type: 'werewolf_action', requestId, windowId, ...body };
      const result = await post(base, '/v1/action', sent, {
        authorization: `Bearer ${seat.token}`, 'x-parlor-client': PARLOR_CLIENT_VERSION,
      });
      if (result.status !== 200) {
        // 竞态（窗口刚切换）可以容忍，其他失败直接炸出来。
        const message = String(result.body.error ?? '');
        if (!message.includes('窗口') && !message.includes('截止')) {
          throw new Error(`${seat.name} 动作被拒：${JSON.stringify(result.body)}`);
        }
      }
      hooks.onAct?.(seat, priv, result, sent);
    }
    await sleep(120);
  }
};

const assertEndShape = (endEvent: Record<string, unknown>, label: string): void => {
  const data = endEvent.data as { outcome?: string; roles?: unknown[]; winners?: unknown[] } | undefined;
  if (!data || !['good', 'wolf', 'draw'].includes(data.outcome ?? '')) {
    throw new Error(`${label}：结局不合法 ${JSON.stringify(data)}`);
  }
  if ((data.roles ?? []).length !== 9) throw new Error(`${label}：终局没揭满 9 个身份`);
  const roles = (data.roles as Array<{ role: string }>).map((entry) => entry.role).sort().join(',');
  if (roles !== 'hunter,seer,villager,villager,villager,witch,wolf,wolf,wolf') {
    throw new Error(`${label}：身份构成不对：${roles}`);
  }
};

/** 场景：快速完整局 + 旁路封堵 + 幂等 + 历史路由。 */
const scenarioFast = async (): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'parlor-wolf-e2e-'));
  const dbFile = join(dir, 'parlor.db');
  const server = await bootServer(dir, dbFile);
  try {
    console.log('  [fast] 起服、组桌（含旧客户端拒绝检查）');
    const { seats, tableId, watcherToken } = await setupTable(server.base, 1, 8, { stalePet: 7 });

    // 等一窗真实窗口出现，先验旁路与幂等。
    const human = seats[0]!;
    let dedupChecked = false;
    console.log('  [fast] 开局，轮询驱动到终局（途中验旁路/幂等）');
    let bypassChecked = false;
    const { endEvent } = await driveToEnd(server.base, seats, quickPolicy, {
      onAct: async (seat, priv, result, sent) => {
        if (!bypassChecked && (priv.myMove === 'speak' || priv.myMove === 'vote')) {
          bypassChecked = true;
          const tableSay = await post(server.base, '/v1/action', { type: 'table_say', text: '局中桌聊', requestId: 'bypass-ts' }, { authorization: `Bearer ${seat.token}` });
          if (tableSay.status !== 409) throw new Error(`局中 table_say 应 409，实际 ${tableSay.status}`);
          const say = await post(server.base, '/v1/action', { type: 'say', text: '局中客厅喊话', requestId: 'bypass-say' }, { authorization: `Bearer ${seat.token}` });
          if (say.status !== 409) throw new Error(`局中 say 应 409，实际 ${say.status}`);
          const peerName = seat.name === 'Coo1' ? 'Coo2' : 'Coo1';
          const whisper = await post(server.base, '/v1/action', { type: 'whisper', to: peerName, text: '局中私聊' }, { authorization: `Bearer ${seat.token}` });
          if (whisper.status !== 409) throw new Error(`局中同桌 whisper 应 409，实际 ${whisper.status}：${JSON.stringify(whisper.body)}`);
          if (watcherToken) {
            const outsider = await post(server.base, '/v1/action', { type: 'whisper', to: seat.name === 'Coo1' ? 'Coo2' : 'Coo1', text: '场外插一句' }, { authorization: `Bearer ${watcherToken}` });
            if (outsider.status !== 200) throw new Error(`桌外 whisper 应放行，实际 ${outsider.status}`);
          }
          console.log('  ✓ 局中旁路封堵（桌聊/客厅/同桌私聊 409，场外放行）');
        }
        // 幂等：同一个 requestId 原样重发，回执的稳定字段（游标/版本/桌号/截止）应完全一致。
        // 已知小偏差：HTTP 包装层每次响应会重新盖 ts（存的原始回执里的 ts 才是第一次的），
        // 所以这里剥掉 ts 再比；seq 相同就证明没有重复执行。
        if (!dedupChecked && result.status === 200) {
          dedupChecked = true;
          const replay = await post(server.base, '/v1/action', sent, {
            authorization: `Bearer ${seat.token}`, 'x-parlor-client': PARLOR_CLIENT_VERSION,
          });
          const stable = (body: Record<string, unknown>): string => JSON.stringify({ ...body, ts: 0 });
          if (replay.status !== 200 || stable(replay.body) !== stable(result.body)) {
            throw new Error(`同 requestId 重放回执不一致：${JSON.stringify(replay.body)} vs ${JSON.stringify(result.body)}`);
          }
          if (replay.body.seq !== result.body.seq) {
            throw new Error(`重放后游标变了：${replay.body.seq} vs ${result.body.seq}`);
          }
          console.log('  ✓ 同 requestId 重放返回原回执（游标一致；ts 为响应时刻会重盖，见报告）');
        }
      },
    });
    void dedupChecked;

    assertEndShape(endEvent, 'fast');
    console.log(`  ✓ 一局打完：outcome=${(endEvent.data as { outcome: string }).outcome}`);
    console.log('  ✓ 历史恰好一条 parlor.table.end，9 个身份全部揭牌');

    // table-log 路由（公开历史）。
    const log = await get(server.base, `/v1/rooms/lobby/table-log?table=${tableId}&review=1`, human.token);
    if (log.status !== 200) throw new Error(`table-log 路由失败：${log.status}`);
    const logBody = log.body.log as { status?: string; speeches?: unknown[]; votes?: unknown[]; nights?: unknown[] };
    if (logBody.status !== 'ended' || !Array.isArray(logBody.speeches) || !Array.isArray(logBody.votes)) {
      throw new Error(`table-log 形状不对：${JSON.stringify(Object.keys(logBody))}`);
    }
    if (!Array.isArray(logBody.nights) || logBody.nights.length === 0) {
      throw new Error('终局后参与者复盘应给出夜间记录');
    }
    console.log(`  ✓ table-log：${logBody.speeches.length} 条发言、${logBody.votes.length} 轮票、${logBody.nights.length} 夜复盘`);

    // 终局后房间公开发言恢复。
    const say = await post(server.base, '/v1/action', { type: 'say', text: '打完了，聊两句' }, { authorization: `Bearer ${human.token}` });
    if (say.status !== 200) throw new Error(`终局后 say 应恢复，实际 ${say.status}`);
    console.log('  ✓ 终局后客厅发言恢复');
  } finally {
    await stopServer(server);
    if (!KEEP) rmSync(dir, { recursive: true, force: true });
  }
};

/** 场景：第 1 夜杀进程 → 原库重启 → rearm → 续打到终局。 */
const scenarioRestart = async (): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'parlor-wolf-e2e-r-'));
  const dbFile = join(dir, 'parlor.db');
  let server = await bootServer(dir, dbFile);
  try {
    console.log('  [restart] 组桌开局，推进到第 1 夜');
    const { seats } = await setupTable(server.base, 1, 8);
    // 推进：发牌看身份（15s 缩成 TURN_MS）→ 夜 A。等任意席位 phase=night。
    let nightPriv: Record<string, unknown> | null = null;
    for (let i = 0; i < 600 && !nightPriv; i++) {
      for (const seat of seats) {
        const snap = await get(server.base, '/v1/rooms/lobby/room?limit=1', seat.token);
        const priv = snap.body.tablePrivate as Record<string, unknown> | null;
        if (priv && priv.phase === 'night') { nightPriv = { ...priv, token: seat.token }; break; }
      }
      if (!nightPriv) {
        // 看身份窗口期间没人能行动，靠真实时钟过去。
        await sleep(150);
      }
    }
    if (!nightPriv) throw new Error('30 秒内没等到首夜（看身份窗口没推进）');
    const before = nightPriv as { day: number; windowId: string; deadline: number; token: string };
    console.log(`  [restart] 第 ${before.day} 夜（窗口 ${before.windowId}），杀进程`);
    const killAt = Date.now();
    await stopServer(server);
    await sleep(2_000); // 停机 2 秒（< 30 分钟续局线）
    server = await bootServer(dir, dbFile);
    const bootAt = Date.now();
    // 恢复后同一窗口还在，截止被平移。
    for (let i = 0; i < 100; i++) {
      const snap = await get(server.base, '/v1/rooms/lobby/room?limit=1', before.token);
      const priv = snap.body.tablePrivate as { phase?: string; day?: number; windowId?: string; deadline?: number } | null;
      if (priv?.phase === 'night') {
        if (priv.day !== before.day) throw new Error(`重启后夜数变了：${priv.day}`);
        if (priv.windowId !== before.windowId) throw new Error(`重启后窗口变了：${priv.windowId}`);
        if ((priv.deadline ?? 0) <= before.deadline) {
          throw new Error(`重启后截止没有平移：${priv.deadline} <= ${before.deadline}`);
        }
        const shift = (priv.deadline ?? 0) - before.deadline;
        const downtime = bootAt - killAt;
        if (shift < downtime) throw new Error(`截止平移量 ${shift}ms 小于停机 ${downtime}ms`);
        console.log(`  ✓ 停机 ${downtime}ms，截止平移 ${shift}ms，窗口与夜数原样`);
        break;
      }
      await sleep(100);
    }
    console.log('  [restart] 续打到终局');
    const { endEvent } = await driveToEnd(server.base, seats, quickPolicy);
    assertEndShape(endEvent, 'restart');
    console.log(`  ✓ 重启后续局打完：outcome=${(endEvent.data as { outcome: string }).outcome}`);
  } finally {
    await stopServer(server);
    if (!KEEP) rmSync(dir, { recursive: true, force: true });
  }
};

/** 场景：2 真人 + 7 Coo 完整一局 + SSE 推送核对。 */
const scenarioHumans2 = async (): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'parlor-wolf-e2e-h2-'));
  const dbFile = join(dir, 'parlor.db');
  const server = await bootServer(dir, dbFile);
  try {
    console.log('  [humans2] 2 真人 + 7 Coo 组桌开局');
    const { seats } = await setupTable(server.base, 2, 7);
    // 挂一条 SSE 流（旁观第一只 Coo 的席位视角）。
    const controller = new AbortController();
    const seen: string[] = [];
    const stream = fetch(`${server.base}/v1/stream?token=${encodeURIComponent(seats[1]!.token)}&since=0`, {
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`SSE 连不上：${response.status}`);
      return response.body;
    });
    (async () => {
      try {
        const reader = (await stream)?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          for (const match of text.matchAll(/^data: (.+)$/gm)) {
            try {
              const parsed = JSON.parse(match[1]!) as { type?: string };
              if (parsed.type && seen.length < 500) seen.push(parsed.type);
            } catch { /* 半截行 */ }
          }
        }
      } catch { /* 被 abort 是预期 */ }
    })();
    console.log('  [humans2] 驱动到终局');
    const { endEvent } = await driveToEnd(server.base, seats, quickPolicy);
    controller.abort();
    assertEndShape(endEvent, 'humans2');
    const tableEvents = seen.filter((type) => type.startsWith('parlor.table.'));
    if (tableEvents.length === 0) throw new Error(`SSE 没推任何牌桌事件（收到 ${seen.length} 条）`);
    console.log(`  ✓ 2 真人局打完：outcome=${(endEvent.data as { outcome: string }).outcome}；SSE 推了 ${tableEvents.length} 条牌桌事件`);
  } finally {
    await stopServer(server);
    if (!KEEP) rmSync(dir, { recursive: true, force: true });
  }
};

const RUNNERS: Record<string, () => Promise<void>> = {
  fast: scenarioFast,
  restart: scenarioRestart,
  humans2: scenarioHumans2,
};

console.log(`狼人杀 e2e：时限基准 ${TURN_MS}ms，场景 ${SCENARIOS.join(' / ')}`);
const failures: string[] = [];
for (const name of SCENARIOS) {
  const runner = RUNNERS[name];
  if (!runner) { console.error(`不认识的场景：${name}`); process.exit(2); }
  try {
    console.log(`▶ 场景 ${name}`);
    await runner();
  } catch (error) {
    failures.push(name);
    console.error(`✗ 场景 ${name} 失败：${(error as Error).message}`);
    if ((error as Error).stack) console.error((error as Error).stack);
  }
}
if (failures.length > 0) {
  console.error(`\n失败场景：${failures.join(', ')}`);
  process.exit(1);
}
console.log('\n全部场景通过。');
