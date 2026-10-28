/**
 * 大富翁数值批量模拟：不连服务器、不连模型，只跑纯规则。
 * 用途是调数值：看一圈几圈、租金占多少、多少人破产、赢家靠什么。
 *
 *   pnpm tsx scripts/sim-monopoly.ts [局数] [人数...]
 *
 * 默认跑 4 人与 6 人各 500 局，对比两种策略：
 *   eager  见地就买、见地就升
 *   reserve 手上留 250 金币才买、留 350 才升
 * 策略只影响买/升级，不用道具（道具另测）。
 */
import { randomInt } from 'node:crypto';
import { MONOPOLY_RULES, MonopolyGame, cellAt, seatCompensationStep } from '../src/room/games/monopoly-rules.ts';

interface Policy {
  name: string;
  reserveBuy: number;
  reserveUpgrade: number;
}

const POLICIES: Policy[] = [
  { name: 'eager', reserveBuy: 0, reserveUpgrade: 0 },
  { name: 'reserve', reserveBuy: 250, reserveUpgrade: 350 },
];

const die = (): number => randomInt(1, 7);

interface Row {
  rounds: number;
  reason: string;
  bankrupt: number;
  rentTotal: number;
  rentEvents: number;
  buys: number;
  upgrades: number;
  owned: number;
  spread: number;
  tie: boolean;
  winnerAssets: number;
  cashTotal: number;
}

/** 跑一局并统计租金：从每次动作的事实里数「付租金 N」。 */
function playWithRent(size: number, policy: Policy): Row {
  const seats = Array.from({ length: size }, (_, index) => ({ seatId: `s${index}`, name: `S${index}` }));
  const game = MonopolyGame.start({ seats, shuffle: (list) => list.map((value) => ({ value, key: Math.random() })).sort((a, b) => a.key - b.key).map((entry) => entry.value) });
  let rentTotal = 0;
  let rentEvents = 0;
  let guards = 0;
  const watch = (facts: string[]): void => {
    for (const fact of facts) {
      const match = /付租金 (\d+) 金币/.exec(fact);
      if (match) {
        rentTotal += Number(match[1]);
        rentEvents += 1;
      }
    }
  };
  while (!game.ended) {
    if (++guards > 5000) throw new Error('模拟没收敛');
    const seatId = game.currentSeatId;
    const player = game.player(seatId);
    if (game.phase === 'prepare') {
      watch(game.roll(seatId, [die(), die()]).facts);
    } else if (game.phase === 'buy') {
      const index = game.legal().pending!;
      const price = cellAt(index).price ?? 0;
      if (player.cash - price >= policy.reserveBuy) watch(game.buy(seatId).facts);
      else watch(game.pass(seatId, [1, 1]).facts);
    } else if (game.phase === 'upgrade') {
      const index = game.legal().pending!;
      const cost = cellAt(index).upgrade ?? 0;
      if (player.cash - cost >= policy.reserveUpgrade) watch(game.upgrade(seatId).facts);
      else watch(game.pass(seatId, [1, 1]).facts);
    } else {
      watch(game.pass(seatId, [1, 1]).facts);
    }
  }
  const state = game.snapshot();
  const ended = state.ended!;
  const assets = ended.ranking.filter((entry) => !entry.bankrupt).map((entry) => entry.assets);
  return {
    rounds: state.round - 1,
    reason: ended.reason,
    bankrupt: ended.ranking.filter((entry) => entry.bankrupt).length,
    rentTotal,
    rentEvents,
    buys: state.properties.filter((property) => property.owner !== null).length,
    upgrades: state.properties.filter((property) => property.level > 0).length,
    owned: state.properties.filter((property) => property.owner !== null).length,
    spread: assets.length > 1 ? Math.max(...assets) - Math.min(...assets) : 0,
    tie: ended.tie,
    winnerAssets: assets.length > 0 ? Math.max(...assets) : 0,
    cashTotal: ended.ranking.reduce((sum, entry) => sum + entry.cash, 0),
  };
}

const mean = (values: number[]): number => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
const pct = (count: number, total: number): string => `${((count / total) * 100).toFixed(1)}%`;

function report(size: number, games: number): void {
  console.log(`\n=== ${size} 人，${games} 局 ===`);
  for (const policy of POLICIES) {
    const rows: Row[] = [];
    for (let index = 0; index < games; index++) rows.push(playWithRent(size, policy));
    const reasons = new Map<string, number>();
    for (const row of rows) reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1);
    const reasonText = [...reasons.entries()].map(([reason, count]) => `${reason} ${pct(count, games)}`).join(' / ');
    console.log(`策略 ${policy.name}`);
    console.log(`  结束原因：${reasonText}`);
    console.log(`  平均轮数：${mean(rows.map((row) => row.rounds)).toFixed(2)} / ${MONOPOLY_RULES.rounds}`);
    console.log(`  平均租金：${mean(rows.map((row) => row.rentTotal)).toFixed(0)} 金币（${mean(rows.map((row) => row.rentEvents)).toFixed(1)} 笔）`);
    console.log(`  平均买地：${mean(rows.map((row) => row.buys)).toFixed(1)} / 12 块，升级 ${mean(rows.map((row) => row.upgrades)).toFixed(1)} 块`);
    console.log(`  平均破产人数：${mean(rows.map((row) => row.bankrupt)).toFixed(2)} / ${size}`);
    console.log(`  并列：${pct(rows.filter((row) => row.tie).length, games)}；赢家资产 ${mean(rows.map((row) => row.winnerAssets)).toFixed(0)}；首尾差 ${mean(rows.map((row) => row.spread)).toFixed(0)}`);
    const startingTotal = Array.from({ length: size }, (_, index) => (
      MONOPOLY_RULES.startingCash + seatCompensationStep(size) * index
    )).reduce((sum, value) => sum + value, 0);
    console.log(`  场上现金合计：${mean(rows.map((row) => row.cashTotal)).toFixed(0)}（起始 ${startingTotal}，含后手补偿）`);
  }
}

const args = process.argv.slice(2).map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
const games = args[0] ?? 500;
const sizes = args.slice(1).length > 0 ? args.slice(1) : [4, 6];
for (const size of sizes) report(size, games);
