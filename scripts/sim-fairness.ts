/**
 * 先手/后手对照：同一批玩家、同一组逐轮骰点，只反转轮序，看位置对胜出的影响。
 * 再试几组「按位次发起始补助」的方案，看能不能把首尾差压平。
 *
 *   pnpm tsx scripts/sim-fairness.ts [对数] [人数...]
 *
 * 默认 4/6 人各 600 对，五个补助方案：0 / 40 / 60 / 80 / 100（每位递增）。
 * 策略统一为「能买就买、能升就升、不用道具」，与模拟报告的口径一致。
 */
import { MonopolyGame, cellAt } from '../src/room/games/monopoly-rules.ts';

const ROUNDS = 12;

/** 固定种子的小随机源，保证同一对局用同一组骰点。 */
function rng(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const die = (value: number): number => 1 + Math.floor(value * 6);

/** 每个玩家每轮的骰点：与轮序无关，只跟种子与玩家有关。 */
function diceBook(seed: number, players: readonly string[]): Map<string, Array<[number, number]>> {
  const book = new Map<string, Array<[number, number]>>();
  for (const [index, player] of players.entries()) {
    const next = rng(seed * 7919 + index * 104729);
    book.set(player, Array.from({ length: ROUNDS + 2 }, () => [die(next()), die(next())] as [number, number]));
  }
  return book;
}

interface Result {
  winner: string | null;
  tie: string[];
  assets: Map<string, number>;
}

function play(order: readonly string[], book: Map<string, Array<[number, number]>>, bonus: readonly number[]): Result {
  const seats = order.map((seatId) => ({ seatId, name: seatId }));
  let game = MonopolyGame.start({ seats, shuffle: (list) => [...list] });
  if (bonus.some((value) => value !== 0)) {
    const state = game.snapshot();
    for (const [index, seatId] of state.order.entries()) state.players[seatId]!.cash += bonus[index] ?? 0;
    game = MonopolyGame.restore(state, new Map(seats.map((seat) => [seat.seatId, seat.name])));
  }

  const used = new Map<string, number>();
  let guard = 0;
  while (!game.ended) {
    if (++guard > 4000) throw new Error('模拟没收敛');
    const seatId = game.currentSeatId;
    const player = game.player(seatId);
    if (game.phase === 'prepare') {
      const round = used.get(seatId) ?? 0;
      const dice = book.get(seatId)?.[round] ?? [1, 1];
      used.set(seatId, round + 1);
      game.roll(seatId, dice);
    } else if (game.phase === 'buy') {
      const index = game.legal().pending!;
      if (player.cash >= (cellAt(index).price ?? 0)) game.buy(seatId);
      else game.pass(seatId, [1, 1]);
    } else if (game.phase === 'upgrade') {
      const index = game.legal().pending!;
      if (player.cash >= (cellAt(index).upgrade ?? 0)) game.upgrade(seatId);
      else game.pass(seatId, [1, 1]);
    } else {
      game.pass(seatId, [1, 1]);
    }
  }

  const ended = game.ended!;
  const assets = new Map(ended.ranking.map((entry) => [entry.seatId, entry.assets]));
  return { winner: ended.winners.length === 1 ? ended.winners[0]! : null, tie: ended.winners, assets };
}

interface Tally {
  first: number;
  last: number;
  byPosition: number[];
  games: number;
}

function run(size: number, pairs: number, bonus: readonly number[], seedBase = 1): Tally {
  const players = Array.from({ length: size }, (_, index) => `p${index}`);
  const forward = [...players];
  const backward = [...players].reverse();
  const forwardShare = new Array(size).fill(0);
  const backwardShare = new Array(size).fill(0);

  for (let pair = 0; pair < pairs; pair++) {
    const seed = seedBase + pair;
    const book = diceBook(seed, players);
    const a = play(forward, book, bonus);
    const b = play(backward, book, bonus);
    const add = (shares: number[], result: Result, order: readonly string[]): void => {
      for (const winner of result.tie) {
        const position = order.indexOf(winner);
        if (position >= 0) shares[position] += 1 / result.tie.length;
      }
    };
    add(forwardShare, a, forward);
    add(backwardShare, b, backward);
  }

  // 同一个玩家在正序里是第一位、在反序里是最后一位；把两个方向的份额按位置对齐
  // 两个方向各占一半，除以 2×对数，份额总和才是 100%
  const byPosition = forwardShare.map((value, index) => (value + backwardShare[index]!) / (2 * pairs));
  return {
    first: byPosition[0]!,
    last: byPosition[size - 1]!,
    byPosition,
    games: pairs * 2,
  };
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** 按位次发起始补助：每位递增 step。 */
const linear = (size: number, step: number): number[] => Array.from({ length: size }, (_, index) => index * step);

const args = process.argv.slice(2).map(Number).filter((value) => Number.isFinite(value) && value > 0);
const pairs = args[0] ?? 600;
const sizes = args.slice(1).length > 0 ? args.slice(1) : [4, 6];
const steps = [0, 40, 60, 80, 100];

for (const size of sizes) {
  console.log(`\n=== ${size} 人，${pairs} 对（${size * 0 + pairs * 2} 局）===`);
  console.log('补助/位次   首位胜出   末位胜出   首尾比   各位置胜出份额');
  for (const step of steps) {
    const tally = run(size, pairs, linear(size, step));
    const ratio = tally.last > 0 ? (tally.first / tally.last).toFixed(2) : '—';
    const spread = tally.byPosition.map(pct).join('  ');
    const label = step === 0 ? '0（基线）' : `+${step}`;
    console.log(`${label.padEnd(10)} ${pct(tally.first).padStart(7)}  ${pct(tally.last).padStart(8)}  ${ratio.padStart(6)}   ${spread}`);
  }
}

