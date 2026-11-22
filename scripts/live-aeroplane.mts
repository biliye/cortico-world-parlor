/**
 * 真机验证（公网 + 真实 World 客户端，三个独立临时身份，不碰本机 companion）：
 *   A. 三个身份进飞行棋客厅；甲开桌，乙丙坐下
 *   B. 甲方开局，轮流掷骰，至少完成一次选飞机移动
 *   C. 当前玩家认输 → 三人局继续，认输方读到「你已认输，可以继续观战」、飞机退场
 *   D. 再一位认输 → 只剩一人，终局 endReason=resign、胜者正确；账本记下两负一胜
 * 使用本轮创建的私密厅，确认归档后才删临时目录。
 */
import { rmSync } from 'node:fs';
import { ReleaseQaRoom } from './release-qa-room.ts';
import { leaveQaSeat, makeQaClient, qaRun } from './release-qa-client.mts';

if (process.env.DRY === '1') { console.log('imports ok（DRY）'); process.exit(0); }

const { base, scratch } = qaRun();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const rows: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = '') => {
  rows.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const step = (text: string) => console.log(`\n── ${text}`);

interface SeatView { id: string; name: string; planes: number[]; resigned?: true }
interface Snapshot {
  table: {
    id: string; revision: number; status: string; phase?: string; turn?: string; die?: number;
    seats: SeatView[]; winners?: string[]; endReason?: 'resign';
  } | null;
  tablePrivate: { yourTurn?: boolean; moves?: Array<{ plane: number; to: number }>; text?: string } | null;
  availableActions: Array<{ action: string }>;
}

type QaClient = Awaited<ReturnType<typeof makeQaClient>> & { snap(): Promise<Snapshot> };
const clients: QaClient[] = [];
let room: ReleaseQaRoom | undefined;

async function makeClient(name: string): Promise<QaClient> {
  const client = await makeQaClient(base, scratch, name);
  const participant = {
    ...client,
    snap: async () => JSON.parse(await client.call('parlor_game_info', { op: 'state' })) as Snapshot,
  };
  clients.push(participant);
  return participant;
}

let a: Awaited<ReturnType<typeof makeClient>> | undefined;
let b: Awaited<ReturnType<typeof makeClient>> | undefined;
let c: Awaited<ReturnType<typeof makeClient>> | undefined;
let tableId = '';

try {
  step('A1 三个身份进飞行棋客厅');
  a = await makeClient('QA飞行甲');
  b = await makeClient('QA飞行乙');
  c = await makeClient('QA飞行丙');
  check('三个身份都拿到席位令牌',
    [a, b, c].every(client => !!client!.secrets.PARLOR_SEAT_TOKEN),
    [a, b, c].map(client => client!.name).join(' / '));
  room = await ReleaseQaRoom.create(base, a.token);
  console.log('本轮 QA 厅', room.id);
  await room.allow(b.token());
  await room.allow(c.token());
  for (const client of [a, b, c]) {
    const visit = await client.call('parlor_room_visit', { room: room.id });
    await room.captureSeat(client.token());
    check(`${client!.name} 已进客厅`, !visit.includes('失败'), visit.replace(/\s+/g, ' ').slice(0, 50));
  }

  step('A2 甲开桌，乙丙坐下');
  const opened = await a.call('parlor_table_open', { game: 'aeroplane' });
  check('桌子已开', !opened.includes('"failed":true') && /飞行棋/.test(opened), opened.replace(/\s+/g, ' ').slice(0, 70));
  let sa = await a.snap();
  tableId = sa.table?.id ?? '';
  room.trackTable(tableId);
  check('拿到桌号', !!tableId, tableId);
  const joinedB = await b.call('parlor_table_join', { table: tableId });
  const joinedC = await c.call('parlor_table_join', { table: tableId });
  check('乙坐下', !joinedB.includes('"failed":true'), joinedB.replace(/\s+/g, ' ').slice(0, 40));
  check('丙坐下', !joinedC.includes('"failed":true'), joinedC.replace(/\s+/g, ' ').slice(0, 40));
  sa = await a.snap();
  check('桌上三人', sa.table?.seats?.length === 3, (sa.table?.seats ?? []).map(seat => seat.name).join(' / '));

  step('B1 甲方开局');
  const started = await a.call('parlor_table_start', {});
  check('已开局', !started.includes('"failed":true'), started.replace(/\s+/g, ' ').slice(0, 60));
  sa = await a.snap();
  check('状态为 playing', sa.table?.status === 'playing', `${sa.table?.status} / phase=${sa.table?.phase}`);

  step('B2 轮流掷骰，至少完成一次移动');
  const all = () => [a!, b!, c!];
  let moved = 0;
  let turns = 0;
  for (let i = 0; i < 60; i += 1) {
    const snaps = await Promise.all(all().map(client => client.snap()));
    const live = snaps.map((snap, index) => ({ client: all()[index], snap }))
      .find(entry => entry.snap.table?.status === 'playing');
    if (!live) break;
    const actor = snaps.map((snap, index) => ({ client: all()[index], snap }))
      .find(entry => entry.snap.tablePrivate?.yourTurn);
    if (!actor) { await sleep(400); continue; }
    turns += 1;
    const revision = actor.snap.table!.revision;
    if (actor.snap.table?.phase === 'await_move') {
      const plane = actor.snap.tablePrivate?.moves?.[0]?.plane;
      if (!plane) { await sleep(300); continue; }
      const out = await actor.client.call('parlor_game_action', { action: 'move', params: { plane }, revision });
      if (/"ok":true/.test(out)) moved += 1;
      console.log(`    ${actor.client.name} 移动 ${plane} 号机：${out.replace(/\s+/g, ' ').slice(0, 60)}`);
    } else {
      await actor.client.call('parlor_game_action', { action: 'roll', params: {}, revision });
    }
    if (moved >= 1) break;
    await sleep(250);
  }
  check('掷骰/移动链路可用', turns >= 1, `turns=${turns}`);
  check('完成过至少一次移动', moved >= 1, `moved=${moved}`);

  step('C1 当前玩家认输，三人局继续');
  let snaps = await Promise.all(all().map(client => client.snap()));
  let current = snaps.map((snap, index) => ({ client: all()[index], snap }))
    .find(entry => entry.snap.tablePrivate?.yourTurn);
  check('轮到某一位玩家', !!current, current?.client.name ?? 'no turn');
  if (!current) throw new Error('没有等到任何一方的回合');
  const first = current;
  const firstSeat = first.snap.table!.seats.find(seat => seat.name === first.client.name)!;
  const resign1 = await first.client.call('parlor_game_action', {
    action: 'resign', params: {}, revision: first.snap.table!.revision,
  });
  check('第一次认输被接受', /"ok":true/.test(resign1), resign1.replace(/\s+/g, ' ').slice(0, 40));

  await sleep(600);
  snaps = await Promise.all(all().map(client => client.snap()));
  const afterFirst = snaps.map((snap, index) => ({ client: all()[index], snap }))
    .find(entry => entry.client === first.client)!;
  check('游戏仍在进行', afterFirst.snap.table?.status === 'playing', afterFirst.snap.table?.status ?? 'null');
  const firstGone = afterFirst.snap.table?.seats.find(seat => seat.id === firstSeat.id)!;
  check('认输席位已标记', firstGone?.resigned === true, JSON.stringify(firstGone?.resigned));
  check('四架飞机退出棋盘', firstGone?.planes.every(plane => plane === -1), JSON.stringify(firstGone?.planes));
  check('认输方读到观战提示', !!afterFirst.snap.tablePrivate?.text?.includes('你已认输，可以继续观战'),
    afterFirst.snap.tablePrivate?.text?.slice(0, 80));

  step('C2 再一位认输，只剩一人终局');
  current = snaps.map((snap, index) => ({ client: all()[index], snap }))
    .find(entry => entry.snap.tablePrivate?.yourTurn);
  check('剩余玩家中有当前手', !!current, current?.client.name ?? 'no turn');
  if (!current) throw new Error('第一次认输后没有等到下一位玩家的回合');
  const second = current;
  const secondSeat = second.snap.table!.seats.find(seat => seat.name === second.client.name)!;
  const remaining = second.snap.table!.seats.filter(seat => seat.id !== secondSeat.id && !seat.resigned);
  check('终局前只剩一位未认输', remaining.length === 1, remaining.map(seat => seat.name).join(' / '));
  const winnerSeat = remaining[0];
  const resign2 = await second.client.call('parlor_game_action', {
    action: 'resign', params: {}, revision: second.snap.table!.revision,
  });
  check('第二次认输被接受', /"ok":true/.test(resign2), resign2.replace(/\s+/g, ' ').slice(0, 40));

  await sleep(600);
  snaps = await Promise.all(all().map(client => client.snap()));
  const ended = snaps[0];
  check('终局状态 ended', ended.table?.status === 'ended', ended.table?.status ?? 'null');
  check('终局原因是认输', ended.table?.endReason === 'resign', String(ended.table?.endReason));
  check('胜者是最后留下的人', ended.table?.winners?.length === 1 && ended.table.winners[0] === winnerSeat.id,
    `winners=${JSON.stringify(ended.table?.winners)} winner=${winnerSeat.name}`);
  check('第二位认输者飞机也退场',
    ended.table?.seats.find(seat => seat.id === secondSeat.id)?.planes.every(plane => plane === -1) === true,
    JSON.stringify(ended.table?.seats.find(seat => seat.id === secondSeat.id)?.planes));

  step('D1 账本记下两负一胜');
  await sleep(800);
  const ledgerFirst = await first.client.call('parlor_ledger');
  const ledgerSecond = await second.client.call('parlor_ledger');
  const ledgerWinner = await all().find(client => client.name === winnerSeat.name)!.call('parlor_ledger');
  check('第一位认输方记负', /飞行棋/.test(ledgerFirst) && /0 胜 1 负/.test(ledgerFirst),
    ledgerFirst.replace(/\s+/g, ' ').slice(0, 90));
  check('第二位认输方记负', /飞行棋/.test(ledgerSecond) && /0 胜 1 负/.test(ledgerSecond),
    ledgerSecond.replace(/\s+/g, ' ').slice(0, 90));
  check('留下的一方记胜', /飞行棋/.test(ledgerWinner) && /1 胜 0 负/.test(ledgerWinner),
    ledgerWinner.replace(/\s+/g, ' ').slice(0, 90));

} catch (error) {
  console.error('QA 飞行棋中断：', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  try {
    if (room) {
      console.log('QA 清理计划', await room.plan());
      await room.cleanup();
    }
    for (const client of clients) await leaveQaSeat(base, client.token());
    check('本轮临时客厅和席位已清理', true);
  } catch (error) {
    process.exitCode = 1;
    check('本轮临时客厅和席位已清理', false, error instanceof Error ? error.message : String(error));
    console.error('请保留凭据目录', scratch);
  } finally {
    await Promise.allSettled(clients.map(client => client.stop()));
  }
  const failed = rows.filter(([, ok]) => !ok);
  if (rows.at(-1)?.[1] && clients.length === 3) rmSync(scratch, { recursive: true });
  else if (clients.length < 3) console.error('临时客户端启动不完整，请保留凭据目录', scratch);
  console.log(`合计 ${rows.length} 项：${rows.length - failed.length} 通过 / ${failed.length} 失败`);
  if (failed.length) process.exitCode = 1;
}
