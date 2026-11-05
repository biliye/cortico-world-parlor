/**
 * 快局大富翁牌桌：四席固定、坐满开局，6 轮 24 手。
 *
 * 一次回合分两段：`await_roll`（60 秒，掷骰并结算落点）与 `await_buy`
 * （20 秒，只处理「落在无主且买得起的地产」）。两段共用 `turnNo`，
 * 掷骰不交棒、买/放弃才交棒。宿主的 `status` 始终只有 open/playing/ended，
 * 阶段只活在快照与视图的 `phase` 里。
 *
 * 超时由 `tick()` 走完当前回合剩余步骤；被移出客厅的托管席位由 `autoPlay()`
 * 走同一段转移函数。两者都不会重复扣款，也不会重掷已落库的骰点。
 */
import { randomInt } from 'node:crypto';
import { serverClockLabel } from '../clock.ts';
import {
  TableError, secondsLeft,
  type TableEngine, type TableEvent, type TableSeat, type TableStatus, type TableStep,
} from '../table-engine.ts';
import {
  BOARD, BOARD_SIZE, BUY_MS, EVENT_CARDS, MAP_VERSION, PASS_START_CASH, RULES_VERSION,
  ROLL_MS, ROUNDS, SEAT_COUNT, START_CASH, TURNS, cellAt, estateValue, moveOn, propertiesOf,
  rankSeats, validateState,
  type Monopoly2dLastTurn, type Monopoly2dRankRow, type Monopoly2dSeatState,
} from './monopoly2d-rules.ts';

export interface Monopoly2dTableOptions {
  host: TableSeat;
  now: number;
  /** 测试注入：返回 [0,1) 的随机数。 */
  rng?: () => number;
  /** 测试注入：掷骰窗与购买窗。 */
  rollMs?: number;
  buyMs?: number;
}

export type Monopoly2dAction =
  | { move: 'roll'; turnNo?: number }
  | { move: 'buy'; turnNo?: number }
  | { move: 'pass'; turnNo?: number };

interface Seat extends Monopoly2dSeatState {
  kind?: string;
}

const DEFAULT_LABEL = '快局大富翁';

/** 公开视图：网页与 Coo 都从这里取数；`turn` / `deadline` 是宿主调度依赖的字段名。 */
export interface Monopoly2dPublic {
  game: string;
  status: TableStatus;
  host: string;
  phase: 'await_roll' | 'await_buy' | null;
  turn?: string;
  deadline?: number;
  turnNo: number;
  round: number;
  totalRounds: number;
  rulesVersion: number;
  mapVersion: number;
  cells: Array<{ index: number; name: string; kind: string; price?: number; rent?: number }>;
  seats: Array<{ id: string; name: string; cash: number; pos: number; properties: number[]; estate: number }>;
  owners: Array<{ cell: number; seat: string }>;
  pending?: number;
  last?: Monopoly2dLastTurn;
  ranking?: Monopoly2dRankRow[];
  winners?: string[];
  tie?: boolean;
}

export class Monopoly2dTable implements TableEngine {
  readonly game = 'monopoly2d';
  readonly label = DEFAULT_LABEL;
  readonly stateVersion = 1;
  readonly host: string;
  status: TableStatus = 'open';

  private readonly rollMs: number;
  private readonly buyMs: number;
  private readonly rng: () => number;
  private readonly seats: Seat[] = [];
  private firstSeat = 0;
  private turnNo = 0;
  private phase: 'await_roll' | 'await_buy' = 'await_roll';
  private deadline = 0;
  private readonly owners = new Map<number, string>();
  private pending: number | null = null;
  private last: Monopoly2dLastTurn | null = null;
  private ranking: Monopoly2dRankRow[] = [];

  constructor(options: Monopoly2dTableOptions) {
    this.host = options.host.id;
    this.rollMs = options.rollMs ?? ROLL_MS;
    this.buyMs = options.buyMs ?? BUY_MS;
    this.rng = options.rng ?? (() => randomInt(0, 2 ** 31) / 2 ** 31);
    this.seats.push({
      id: options.host.id,
      name: options.host.name,
      cash: START_CASH,
      pos: 0,
      ...(options.host.kind ? { kind: options.host.kind } : {}),
    });
  }

  has(seatId: string): boolean {
    return this.seats.some((seat) => seat.id === seatId);
  }

  seatIds(): string[] {
    return this.seats.map((seat) => seat.id);
  }

  join(seat: TableSeat): TableEvent {
    if (this.status !== 'open') throw new TableError('not_open', '这张桌子已经开始了');
    if (this.has(seat.id)) throw new TableError('seated', '你已经在桌上了');
    if (this.seats.length >= SEAT_COUNT) throw new TableError('full', `快局大富翁正好 ${SEAT_COUNT} 个人`);
    this.seats.push({
      id: seat.id,
      name: seat.name,
      cash: START_CASH,
      pos: 0,
      ...(seat.kind ? { kind: seat.kind } : {}),
    });
    return {
      type: 'parlor.table.join',
      scope: { kind: 'room' },
      text: `${seat.name} 坐到了快局大富翁桌。`,
      data: { game: this.game, seat: seat.id },
    };
  }

  leave(seatId: string): TableEvent {
    if (this.status !== 'open') throw new TableError('not_open', '这张桌子已经开始了，不能中途离开');
    const index = this.seats.findIndex((seat) => seat.id === seatId);
    if (index < 0) throw new TableError('not_seated', '你不在桌上');
    if (seatId === this.host) throw new TableError('not_host', '开桌的人要走请把桌子收掉');
    const [seat] = this.seats.splice(index, 1);
    return {
      type: 'parlor.table.left',
      scope: { kind: 'room' },
      text: `${seat.name} 离开了快局大富翁桌。`,
      data: { game: this.game, seat: seat.id },
    };
  }

  start(by: string, now: number): TableStep {
    if (this.status !== 'open') throw new TableError('not_open', '这张桌子已经开始了');
    if (by !== this.host) throw new TableError('not_host', '只有开桌的人可以开始');
    if (this.seats.length < SEAT_COUNT) {
      throw new TableError('not_open', `要四个玩家坐满才能开局，现在 ${this.seats.length} 个`);
    }
    this.status = 'playing';
    this.firstSeat = Math.min(SEAT_COUNT - 1, Math.max(0, Math.floor(this.rng() * SEAT_COUNT)));
    this.turnNo = 1;
    this.phase = 'await_roll';
    this.deadline = now + this.rollMs;
    this.owners.clear();
    this.pending = null;
    this.last = null;
    this.ranking = [];
    for (const seat of this.seats) {
      seat.cash = START_CASH;
      seat.pos = 0;
    }
    const first = this.currentSeat();
    const names = this.seats.map((seat) => seat.name).join('、');
    return {
      events: [{
        type: 'parlor.table.start',
        scope: { kind: 'room' },
        text: `快局大富翁开始了：${names}。每人 ${START_CASH} 局内金币，${ROUNDS} 轮共 ${TURNS} 手，${first?.name ?? '？'} 先手。`,
        data: { game: this.game, seats: this.seatIds(), first: first?.id },
      }],
      views: first ? [first.id] : [],
    };
  }

  act(seatId: string, input: unknown, now: number): TableStep {
    if (this.status !== 'playing') throw new TableError('not_started', '这张桌子没在玩');
    const seat = this.seats.find((entry) => entry.id === seatId);
    if (!seat) throw new TableError('not_seated', '你不在桌上');
    if (this.currentSeat()?.id !== seatId) throw new TableError('not_turn', '还没轮到你');
    if (now >= this.deadline) throw new TableError('expired', '这个回合已经到期，等服务器推进后再看桌面');
    const action = (input ?? {}) as Monopoly2dAction;
    if (action.turnNo !== undefined && action.turnNo !== this.turnNo) {
      throw new TableError('expired', `这是第 ${this.turnNo} 手，你按的是第 ${String(action.turnNo)} 手；刷新桌面再来`);
    }
    if (action.move === 'roll') {
      if (this.phase !== 'await_roll') throw new TableError('bad_action', '现在是在决定买不买：用 move:"buy" 或 "pass"');
      return this.roll(seat, now, 'player');
    }
    if (action.move === 'buy') {
      if (this.phase !== 'await_buy' || this.pending === null) throw new TableError('bad_action', '现在没有可买的地产，先掷骰');
      return this.buyNow(seat, now);
    }
    if (action.move === 'pass') {
      if (this.phase !== 'await_buy' || this.pending === null) throw new TableError('bad_action', '现在没有待买的地产，先掷骰');
      return this.passNow(seat, now, 'player');
    }
    throw new TableError('bad_action', '动作只能是 roll、buy 或 pass');
  }

  /** 到点推进当前回合剩余步骤：待掷骰就代掷并跳过购买；待购买就自动放弃。 */
  tick(now: number): TableStep | null {
    if (this.status !== 'playing') return null;
    if (now < this.deadline) return null;
    const seat = this.currentSeat();
    if (!seat) return null;
    if (this.phase === 'await_buy') return this.passNow(seat, now, 'timeout');
    return this.roll(seat, now, 'timeout');
  }

  /**
   * 托管代打：被移出客厅的席位轮到就由服务器走一步，不等截止。
   * 一次只交棒一次——掷骰后直接跳过购买（与超时默认一致）。
   */
  autoPlay(seatId: string, now: number): TableStep | null {
    if (this.status !== 'playing') return null;
    if (this.currentSeat()?.id !== seatId) return null;
    if (this.phase === 'await_buy') return this.passNow(this.seats.find((seat) => seat.id === seatId)!, now, 'auto');
    return this.roll(this.seats.find((seat) => seat.id === seatId)!, now, 'auto');
  }

  nextWakeAt(): number | undefined {
    if (this.status !== 'playing') return undefined;
    return this.deadline;
  }

  view(seatId: string): unknown | null {
    const seat = this.seats.find((entry) => entry.id === seatId);
    if (!seat) return null;
    const playing = this.status === 'playing';
    const yourTurn = playing && this.currentSeat()?.id === seat.id;
    const pendingCell = this.pending === null ? null : cellAt(this.pending);
    const movable = playing && !yourTurn ? [] : (this.phase === 'await_roll' ? ['roll'] : ['buy', 'pass']);
    return {
      game: this.game,
      seat: seat.id,
      name: seat.name,
      status: this.status,
      phase: playing ? this.phase : null,
      turn: playing ? this.currentSeat()?.id : undefined,
      deadline: playing ? this.deadline : undefined,
      turnNo: this.turnNo,
      round: this.roundOf(this.turnNo),
      totalRounds: ROUNDS,
      cash: seat.cash,
      pos: seat.pos,
      yourTurn,
      canAct: yourTurn,
      moves: yourTurn ? movable : [],
      properties: propertiesOf(seat.id, this.owners),
      estate: estateValue(propertiesOf(seat.id, this.owners).map((cell) => cellAt(cell).price ?? 0)),
      pending: pendingCell && yourTurn
        ? {
          index: pendingCell.index,
          name: pendingCell.name,
          price: pendingCell.price ?? 0,
          rent: pendingCell.rent ?? 0,
          affordable: seat.cash >= (pendingCell.price ?? 0),
          cashAfter: seat.cash - (pendingCell.price ?? 0),
        }
        : null,
      last: this.last ?? null,
      ranking: this.status === 'ended' ? this.ranking : undefined,
    };
  }

  public(): Monopoly2dPublic {
    const playing = this.status === 'playing';
    const current = playing ? this.currentSeat() : undefined;
    return {
      game: this.game,
      status: this.status,
      host: this.host,
      phase: playing ? this.phase : null,
      turn: current?.id,
      deadline: playing ? this.deadline : undefined,
      turnNo: this.turnNo,
      round: this.roundOf(this.turnNo),
      totalRounds: ROUNDS,
      rulesVersion: RULES_VERSION,
      mapVersion: MAP_VERSION,
      cells: BOARD.map((cell) => ({ ...cell })),
      seats: this.seats.map((seat) => {
        const properties = propertiesOf(seat.id, this.owners);
        return {
          id: seat.id,
          name: seat.name,
          cash: seat.cash,
          pos: seat.pos,
          properties,
          estate: estateValue(properties.map((cell) => cellAt(cell).price ?? 0)),
        };
      }),
      owners: [...this.owners.entries()].map(([cell, seat]) => ({ cell, seat })),
      ...(this.pending !== null ? { pending: this.pending } : {}),
      ...(this.last ? { last: this.last } : {}),
      ...(this.status === 'ended'
        ? {
          ranking: this.ranking,
          winners: this.ranking.filter((row) => row.rank === 1).map((row) => row.seat),
          tie: this.ranking.filter((row) => row.rank === 1).length > 1,
        }
        : {}),
    };
  }

  privateText(seatId: string, now: number): string | null {
    const seat = this.seats.find((entry) => entry.id === seatId);
    if (!seat) return null;
    if (this.status === 'open') return '【快局大富翁】还没有开始，坐满四席后由开桌的人开始。';
    if (this.status === 'ended') {
      const line = this.ranking.map((row) => {
        const name = this.seats.find((entry) => entry.id === row.seat)?.name ?? '？';
        const mine = row.seat === seatId ? '（你）' : '';
        return `${row.rank} 位 ${name}${mine} ${row.total}（金币 ${row.cash} + 地产 ${row.estate}）`;
      }).join('；');
      return `【快局大富翁·结束】${line}。`;
    }
    const current = this.currentSeat();
    const yourTurn = current?.id === seatId;
    const lines: string[] = [];
    const header = yourTurn
      ? `【快局大富翁·轮到你】第 ${this.roundOf(this.turnNo)}/${ROUNDS} 轮第 ${this.turnNo} 手`
      : `【快局大富翁·等 ${current?.name ?? '？'}】第 ${this.roundOf(this.turnNo)}/${ROUNDS} 轮第 ${this.turnNo} 手`;
    lines.push(header);
    lines.push(this.statusLine(seat));
    lines.push(`其他三家：${this.seats.filter((entry) => entry.id !== seatId).map((entry) => `${entry.name} 在 ${cellAt(entry.pos).name}（金币 ${entry.cash}）`).join('；')}。`);
    if (!yourTurn) {
      lines.push('等对方行动；桌面变化会随牌桌事件推给你。');
      return lines.join('\n');
    }
    if (this.phase === 'await_buy' && this.pending !== null) {
      const cell = cellAt(this.pending);
      const price = cell.price ?? 0;
      lines.push(`你落在「${cell.name}」：售价 ${price}，租金 ${cell.rent ?? 0}。买下后剩 ${seat.cash - price} 金币。`);
      lines.push(`截止 ${serverClockLabel(this.deadline)}，还剩 ${secondsLeft(this.deadline, now)} 秒：parlor_game_action {action:"buy",params:{turnNo:${this.turnNo}}} 买下，或 {move:"pass", turnNo:${this.turnNo}} 放弃。`);
      return lines.join('\n');
    }
    lines.push(`截止 ${serverClockLabel(this.deadline)}，还剩 ${secondsLeft(this.deadline, now)} 秒：parlor_game_action {action:"roll",params:{turnNo:${this.turnNo}}} 掷骰。`);
    return lines.join('\n');
  }

  publicText(): string {
    if (this.status === 'open') {
      return `【快局大富翁】还开着，桌上：${this.seats.map((seat) => seat.name).join('、')}。`;
    }
    if (this.status === 'ended') {
      const top = this.ranking.filter((row) => row.rank === 1)
        .map((row) => `${this.seats.find((seat) => seat.id === row.seat)?.name ?? '？'} ${row.total}`)
        .join('、');
      return `【快局大富翁】结束：${top}。`;
    }
    const current = this.currentSeat();
    const board = this.seats.map((seat) => `${seat.name} ${seat.cash}`).join('、');
    return `【快局大富翁】第 ${this.roundOf(this.turnNo)}/${ROUNDS} 轮，轮到 ${current?.name ?? '？'}${this.phase === 'await_buy' ? ' 决定买地' : ' 掷骰'}；金币：${board}。`;
  }

  exportState(): unknown {
    return {
      version: this.stateVersion,
      rulesVersion: RULES_VERSION,
      mapVersion: MAP_VERSION,
      status: this.status,
      host: this.host,
      seats: this.seats.map((seat) => ({ id: seat.id, name: seat.name, cash: seat.cash, pos: seat.pos })),
      firstSeat: this.firstSeat,
      turnNo: this.turnNo,
      phase: this.status === 'playing' ? this.phase : null,
      deadline: this.status === 'playing' ? this.deadline : 0,
      owners: Object.fromEntries(this.owners),
      pending: this.pending,
      last: this.last,
      ranking: this.ranking,
    };
  }

  restoreState(state: unknown): void {
    const parsed = validateState(state, this.host, this.stateVersion);
    this.status = parsed.status;
    this.seats.splice(0, this.seats.length, ...parsed.seats);
    this.firstSeat = parsed.firstSeat;
    this.turnNo = parsed.turnNo;
    this.phase = parsed.phase ?? 'await_roll';
    this.deadline = parsed.deadline;
    this.owners.clear();
    for (const [cell, seat] of Object.entries(parsed.owners)) this.owners.set(Number(cell), seat);
    this.pending = parsed.pending;
    this.last = parsed.last;
    this.ranking = parsed.ranking;
  }

  /**
   * 短停机恢复：当前窗口（掷骰或购买）取「停机前剩余时间」与宿主重连宽限的
   * 较大值；已落库的骰点与待买地块不动，所以不会重掷、也不会重复扣款。
   */
  rearm(now: number, downtimeMs: number, minHumanMs: number): void {
    if (this.status !== 'playing') return;
    const remaining = Math.max(0, this.deadline - (now - downtimeMs));
    this.deadline = now + Math.max(remaining, minHumanMs);
  }

  /* —— 内部转移 —— */

  private roundOf(turnNo: number): number {
    return turnNo <= 0 ? 0 : Math.min(ROUNDS, Math.ceil(turnNo / SEAT_COUNT));
  }

  private currentSeat(): Seat | undefined {
    if (this.status === 'open' || this.turnNo <= 0) return undefined;
    return this.seats[(this.firstSeat + this.turnNo - 1) % this.seats.length];
  }

  private rollDie(): number {
    const value = Math.floor(this.rng() * 6) + 1;
    return Math.min(6, Math.max(1, value));
  }

  private drawCard(): { label: string; amount: number } {
    const index = Math.min(EVENT_CARDS.length - 1, Math.max(0, Math.floor(this.rng() * EVENT_CARDS.length)));
    const card = EVENT_CARDS[index];
    return { label: card.label, amount: card.amount };
  }

  /**
   * 掷骰并结算落点。`source`：
   * - `player` 掷出可买地块时进入 await_buy；
   * - `timeout` / `auto` 跳过购买直接交棒（计划里的超时与托管默认）。
   */
  private roll(seat: Seat, now: number, source: 'player' | 'timeout' | 'auto'): TableStep {
    const die = this.rollDie();
    const from = seat.pos;
    const { to, passedStart } = moveOn(from, die);
    seat.pos = to;
    const events: TableEvent[] = [];
    const notes: string[] = [];
    let startCash = 0;
    if (passedStart) {
      seat.cash += PASS_START_CASH;
      startCash = PASS_START_CASH;
      notes.push(`路过起点 +${PASS_START_CASH}`);
    }
    const last: Monopoly2dLastTurn = { seat: seat.id, die, from, to, passedStart, rent: 0 };
    if (source !== 'player') last.auto = true;
    // 先在分支前算好措辞：进入购买分支后 TS 会把 source 收窄成 'player'。
    const autoNote = source === 'timeout' ? '（超时代掷）' : source === 'auto' ? '（托管代掷）' : '';
    const autoPrefix = source === 'timeout' ? '超时，服务器代掷：' : source === 'auto' ? '托管代掷：' : '';

    const cell = cellAt(to);
    if (cell.kind === 'property') {
      const price = cell.price ?? 0;
      const rent = cell.rent ?? 0;
      const owner = this.owners.get(to);
      if (owner === undefined) {
        if (source === 'player' && seat.cash >= price) {
          this.pending = to;
          this.phase = 'await_buy';
          this.deadline = now + this.buyMs;
          last.pending = to;
          this.last = last;
          events.push(this.actionEvent(
            `${seat.name} 掷出 ${die}，走到「${cell.name}」，售价 ${price}、租金 ${rent}${startCash ? `，路过起点 +${startCash}` : ''}${autoNote}。等待决定买不买。`,
            { seat: seat.id, die, from, to, pending: to, price, ...(startCash ? { startCash } : {}) },
          ));
          return { events, views: [seat.id] };
        }
        notes.push(seat.cash < price ? `买不起「${cell.name}」（售价 ${price}）` : `跳过「${cell.name}」`);
      } else if (owner !== seat.id) {
        const ownerSeat = this.seats.find((entry) => entry.id === owner)!;
        const paid = Math.min(seat.cash, rent);
        seat.cash -= paid;
        ownerSeat.cash += paid;
        last.rent = paid;
        last.rentTo = owner;
        notes.push(`踩到 ${ownerSeat.name} 的「${cell.name}」，付租 ${paid}`);
      } else {
        notes.push(`回到自己的「${cell.name}」，免租`);
      }
    } else if (cell.kind === 'event') {
      const card = this.drawCard();
      const before = seat.cash;
      seat.cash = Math.max(0, seat.cash + card.amount);
      const delta = seat.cash - before;
      last.card = { label: card.label, amount: delta };
      notes.push(`事件「${card.label}」${delta >= 0 ? `+${delta}` : `${delta}`}`);
    } else if (cell.kind === 'start') {
      notes.push('停在茶馆门口');
    } else {
      notes.push(`在「${cell.name}」休息`);
    }

    this.last = last;
    events.push(this.actionEvent(
      `${autoPrefix}${seat.name} 掷出 ${die}，走到「${cell.name}」${notes.length ? `（${notes.join('，')}）` : ''}。`,
      {
        seat: seat.id, die, from, to,
        ...(startCash ? { startCash } : {}),
        ...(last.rent ? { rent: last.rent, rentTo: last.rentTo } : {}),
        ...(last.card ? { card: last.card } : {}),
        ...(source !== 'player' ? { auto: true } : {}),
      },
    ));
    return this.handoff(now, events, seat, source);
  }

  private buyNow(seat: Seat, now: number): TableStep {
    const cellIndex = this.pending!;
    const cell = cellAt(cellIndex);
    const price = cell.price ?? 0;
    if (seat.cash < price) throw new TableError('bad_action', `金币不够：${cell.name} 要 ${price}，你有 ${seat.cash}`);
    seat.cash -= price;
    this.owners.set(cellIndex, seat.id);
    if (this.last) this.last.bought = cellIndex;
    this.pending = null;
    const event = this.actionEvent(
      `${seat.name} 买下「${cell.name}」（${price} 金币，租金 ${cell.rent ?? 0}），余额 ${seat.cash}。`,
      { seat: seat.id, bought: cellIndex, price, cash: seat.cash },
    );
    return this.handoff(now, [event], seat, 'player');
  }

  private passNow(seat: Seat, now: number, source: 'player' | 'timeout' | 'auto'): TableStep {
    const cellIndex = this.pending;
    const cell = cellIndex === null ? null : cellAt(cellIndex);
    this.pending = null;
    const why = source === 'timeout' ? '（超时自动放弃）' : source === 'auto' ? '（托管放弃）' : '';
    const event = this.actionEvent(
      cell ? `${seat.name} 放弃购买「${cell.name}」${why}。` : `${seat.name} 放弃购买${why}。`,
      { seat: seat.id, passed: cellIndex ?? undefined, ...(source !== 'player' ? { auto: true } : {}) },
    );
    return this.handoff(now, [event], seat, source);
  }

  /** 交棒：回合号 +1，轮次按座次循环；第 24 手之后结算（结算时保留 24）。 */
  private handoff(now: number, events: TableEvent[], _seat: Seat, _source: string): TableStep {
    this.pending = null;
    if (this.turnNo >= TURNS) return this.finish(events);
    this.turnNo += 1;
    this.phase = 'await_roll';
    this.deadline = now + this.rollMs;
    const next = this.currentSeat();
    return { events, views: next ? [next.id] : [] };
  }

  private finish(events: TableEvent[]): TableStep {
    this.status = 'ended';
    this.deadline = 0;
    this.pending = null;
    this.ranking = rankSeats(this.seats, this.owners);
    const winners = this.ranking.filter((row) => row.rank === 1).map((row) => row.seat);
    const rankText = this.ranking.map((row) => {
      const name = this.seats.find((seat) => seat.id === row.seat)?.name ?? '？';
      return `${row.rank} 位 ${name} ${row.total}（金币 ${row.cash} + 地产 ${row.estate}）`;
    }).join('；');
    events.push({
      type: 'parlor.table.end',
      scope: { kind: 'room' },
      text: `快局大富翁结束：${rankText}。`,
      data: {
        game: this.game,
        winners,
        tie: winners.length > 1,
        ranking: this.ranking,
      },
    });
    return { events, views: [], ended: true };
  }

  private actionEvent(text: string, data: Record<string, unknown>): TableEvent {
    return {
      type: 'parlor.table.action',
      scope: { kind: 'room' },
      text,
      data: { game: this.game, ...data },
    };
  }

  /** 私视图里那行「你在哪、有多少钱、几块地」。 */
  private statusLine(seat: Seat): string {
    const properties = propertiesOf(seat.id, this.owners);
    const names = properties.map((cell) => cellAt(cell).name).join('、') || '还没有地产';
    const estate = estateValue(properties.map((cell) => cellAt(cell).price ?? 0));
    return `你：${seat.cash} 金币，站在「${cellAt(seat.pos).name}」；地产 ${names}（估值 ${estate}）。`;
  }

  /** 供测试与排错：当前四个坐位（不含 kind）。 */
  seatStates(): Monopoly2dSeatState[] {
    return this.seats.map((seat) => ({ id: seat.id, name: seat.name, cash: seat.cash, pos: seat.pos }));
  }

  /** 供测试：当前棋盘大小，避免测试里写死 16。 */
  static get size(): number {
    return BOARD_SIZE;
  }
}
