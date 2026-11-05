/**
 * 快局大富翁（monopoly2d）的地图与规则。
 *
 * 这一层是纯计算：16 格环形地图、估值、排名、快照校验，不碰时钟、不发事件、
 * 不掷骰。牌桌（`monopoly2d-table.ts`）负责推进阶段与生成事件；网页与 Coo 都从
 * 服务端视图取数，不自己判断规则。
 *
 * 版本：`RULES_VERSION` 随规则改动走（例如估值系数调整），`MAP_VERSION` 随地图
 * 改动走。两者都写进快照；旧局按旧版本读数，升级不会改历史局面。
 */

export type Monopoly2dCellKind = 'start' | 'property' | 'event' | 'rest';

export interface Monopoly2dCell {
  index: number;
  name: string;
  kind: Monopoly2dCellKind;
  /** 仅地产：售价。 */
  price?: number;
  /** 仅地产：固定租金。 */
  rent?: number;
}

/** 首版地图：16 格环形，四角为 0（起点）、4、8、12（休息）。 */
export const BOARD: readonly Monopoly2dCell[] = Object.freeze([
  { index: 0, name: '茶馆门口', kind: 'start' },
  { index: 1, name: '茶摊', kind: 'property', price: 120, rent: 20 },
  { index: 2, name: '花店', kind: 'property', price: 140, rent: 24 },
  { index: 3, name: '街区消息', kind: 'event' },
  { index: 4, name: '河畔长椅', kind: 'rest' },
  { index: 5, name: '点心铺', kind: 'property', price: 160, rent: 28 },
  { index: 6, name: '二手书店', kind: 'property', price: 180, rent: 32 },
  { index: 7, name: '街区消息', kind: 'event' },
  { index: 8, name: '广场喷泉', kind: 'rest' },
  { index: 9, name: '唱片店', kind: 'property', price: 200, rent: 36 },
  { index: 10, name: '照相馆', kind: 'property', price: 220, rent: 40 },
  { index: 11, name: '街区消息', kind: 'event' },
  { index: 12, name: '路灯转角', kind: 'rest' },
  { index: 13, name: '钟表铺', kind: 'property', price: 240, rent: 44 },
  { index: 14, name: '剧场', kind: 'property', price: 260, rent: 48 },
  { index: 15, name: '街区消息', kind: 'event' },
]);

export const BOARD_SIZE = BOARD.length;
export const MAP_VERSION = 1;
export const RULES_VERSION = 1;

/** 四席固定：坐满才开局，空位不补脚本。 */
export const SEAT_COUNT = 4;
export const START_CASH = 1_000;
export const ROUNDS = 6;
export const TURNS = ROUNDS * SEAT_COUNT;
export const PASS_START_CASH = 120;
/** 终局估值：地产原价合计 × 85%，合计算完只取整一次。 */
export const VALUATION_PERCENT = 85;
export const ROLL_MS = 60_000;
export const BUY_MS = 20_000;

export interface Monopoly2dEventCard {
  readonly label: string;
  readonly amount: number;
}

/** 四张固定事件卡，独立等概率抽取，允许重复。 */
export const EVENT_CARDS: readonly Monopoly2dEventCard[] = Object.freeze([
  { label: '邻里集市', amount: 80 },
  { label: '寄卖到账', amount: 40 },
  { label: '街灯维护', amount: -40 },
  { label: '修雨棚', amount: -70 },
]);

export const cellAt = (index: number): Monopoly2dCell => {
  const wrapped = ((index % BOARD_SIZE) + BOARD_SIZE) % BOARD_SIZE;
  return BOARD[wrapped];
};

export const isProperty = (index: number): boolean => cellAt(index).kind === 'property';

export const propertyIndices = (): number[] => BOARD.filter((cell) => cell.kind === 'property').map((cell) => cell.index);

export interface Monopoly2dSeatState {
  id: string;
  name: string;
  cash: number;
  pos: number;
}

export interface Monopoly2dRankRow {
  seat: string;
  cash: number;
  estate: number;
  total: number;
  /** 竞赛排名：并列同名次，例如 1、1、3、4。 */
  rank: number;
  properties: number[];
}

export interface Monopoly2dLastTurn {
  /** 掷骰的席位。 */
  seat: string;
  die: number;
  from: number;
  to: number;
  passedStart: boolean;
  /** 实付租金（0 表示没付）。 */
  rent: number;
  /** 收到的租金归谁。 */
  rentTo?: string;
  card?: { label: string; amount: number };
  /** 待买地块（未买下时由后续 pass 或超时清掉）。 */
  pending?: number;
  bought?: number;
  /** 这次移动来自超时或托管。 */
  auto?: boolean;
}

export interface Monopoly2dState {
  version: number;
  rulesVersion: number;
  mapVersion: number;
  status: 'open' | 'playing' | 'ended';
  host: string;
  seats: Monopoly2dSeatState[];
  /** 先手席位在 seats 里的下标，开局抽一次后固定。 */
  firstSeat: number;
  /** 1..TURNS；开局前为 0。 */
  turnNo: number;
  phase: 'await_roll' | 'await_buy' | null;
  deadline: number;
  /** 地块 → 席位 id。 */
  owners: Record<string, string>;
  pending: number | null;
  last: Monopoly2dLastTurn | null;
  ranking: Monopoly2dRankRow[];
}

/** 一次移动：返回落点与是否跨过（含恰好停在）起点。 */
export function moveOn(pos: number, die: number): { to: number; passedStart: boolean } {
  const raw = pos + die;
  return { to: raw % BOARD_SIZE, passedStart: raw >= BOARD_SIZE };
}

/** 某席位的地产估值：原价合计 × 85%，只取整一次。 */
export function estateValue(ownedPrices: readonly number[]): number {
  const sum = ownedPrices.reduce((total, price) => total + price, 0);
  return Math.floor((sum * VALUATION_PERCENT) / 100);
}

export function propertiesOf(seatId: string, owners: ReadonlyMap<number, string>): number[] {
  const result: number[] = [];
  for (const [cell, owner] of owners) if (owner === seatId) result.push(cell);
  return result.sort((left, right) => left - right);
}

/** 按席位顺序返回排名：资产高的在前，同分并列，同分按开局座次排。 */
export function rankSeats(
  seats: readonly Monopoly2dSeatState[],
  owners: ReadonlyMap<number, string>,
): Monopoly2dRankRow[] {
  const rows = seats.map((seat) => {
    const properties = propertiesOf(seat.id, owners);
    const estate = estateValue(properties.map((cell) => cellAt(cell).price ?? 0));
    return { seat: seat.id, cash: seat.cash, estate, total: seat.cash + estate, rank: 0, properties };
  });
  const sorted = rows.map((row, index) => ({ row, index }))
    .sort((left, right) => (right.row.total - left.row.total) || (left.index - right.index))
    .map((entry) => entry.row);
  for (const row of sorted) {
    row.rank = 1 + sorted.filter((other) => other.total > row.total).length;
  }
  return sorted;
}

const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

function fail(message: string): never {
  throw new Error(message);
}

/**
 * 快照校验：不认识的版本、坏字段、悬空的席位/地块引用一律抛错，
 * 由宿主把这张桌隔离（`frozen`），不影响同厅其他桌。
 */
export function validateState(raw: unknown, host: string, stateVersion: number): Monopoly2dState {
  if (!raw || typeof raw !== 'object') fail('大富翁存档不是对象');
  const data = raw as Record<string, unknown>;
  if (data.version !== stateVersion) fail(`不认识的大富翁存档版本：${String(data.version)}`);
  if (data.host !== host) fail('大富翁存档的主持席位对不上');
  const status = data.status;
  if (status !== 'open' && status !== 'playing' && status !== 'ended') {
    fail(`大富翁存档的状态不对：${String(status)}`);
  }
  const rulesVersion = data.rulesVersion;
  if (!isInt(rulesVersion) || rulesVersion < 1) fail('大富翁存档的规则版本不对');
  const mapVersion = data.mapVersion;
  if (!isInt(mapVersion) || mapVersion < 1) fail('大富翁存档的地图版本不对');
  const rawSeats = data.seats;
  // 开局前席位随入座/离座增减（1..4 席，空桌 0 席）；开局后必须坐满四席，
  // 否则回合轮转和排名都会少人。这条以前写成「一律四席」，害得第二个人入座时
  // 恢复快照直接抛错。
  if (!Array.isArray(rawSeats)) fail('大富翁存档的席位不是数组');
  if (status === 'open') {
    if (rawSeats.length > SEAT_COUNT) fail(`大富翁存档开局前最多 ${SEAT_COUNT} 席`);
  } else if (rawSeats.length !== SEAT_COUNT) {
    fail('大富翁存档开局后必须正好四席');
  }
  const seats: Monopoly2dSeatState[] = rawSeats.map((entry: unknown) => {
    const seat = entry as Record<string, unknown> | null;
    if (!seat || typeof seat.id !== 'string' || typeof seat.name !== 'string') fail('大富翁存档的席位形状不对');
    const cash = seat.cash;
    const pos = seat.pos;
    if (!isInt(cash) || cash < 0) fail('大富翁存档的金币不对');
    if (!isInt(pos) || pos < 0 || pos >= BOARD_SIZE) fail('大富翁存档的棋子位置不对');
    return { id: seat.id, name: seat.name, cash, pos };
  });
  if (new Set(seats.map((seat) => seat.id)).size !== seats.length) fail('大富翁存档里有重复席位');
  const ids = new Set(seats.map((seat) => seat.id));
  let firstSeat = 0;
  let turnNo = 0;
  if (status !== 'open') {
    const rawFirst = data.firstSeat;
    const rawTurn = data.turnNo;
    if (!isInt(rawFirst) || rawFirst < 0 || rawFirst >= SEAT_COUNT) fail('大富翁存档的先手不对');
    if (!isInt(rawTurn) || rawTurn < 1 || rawTurn > TURNS) fail('大富翁存档的回合序号不对');
    firstSeat = rawFirst;
    turnNo = rawTurn;
  }
  const ownersRaw = data.owners;
  if (!ownersRaw || typeof ownersRaw !== 'object') fail('大富翁存档缺少地产归属');
  const owners = new Map<number, string>();
  for (const [key, value] of Object.entries(ownersRaw as Record<string, unknown>)) {
    const cell = Number(key);
    if (!isInt(cell) || cell < 0 || cell >= BOARD_SIZE) fail('大富翁存档的地块编号不对');
    if (!isProperty(cell)) fail('大富翁存档把非地产记成了有主');
    if (typeof value !== 'string' || !ids.has(value)) fail('大富翁存档的地产所有人不存在');
    owners.set(cell, value);
  }
  const pendingRaw = data.pending;
  const pending = pendingRaw === null || pendingRaw === undefined ? null : Number(pendingRaw);
  if (pending !== null) {
    if (!isInt(pending) || pending < 0 || pending >= BOARD_SIZE) fail('大富翁存档的待买地块不对');
    if (!isProperty(pending)) fail('大富翁存档的待买地块不是地产');
    if (owners.has(pending)) fail('大富翁存档的待买地块已经有主');
  }
  const phase = data.phase;
  if (phase !== null && phase !== 'await_roll' && phase !== 'await_buy') fail('大富翁存档的阶段不对');
  const deadline = status === 'playing' ? data.deadline : 0;
  if (status === 'playing') {
    if (phase !== 'await_roll' && phase !== 'await_buy') fail('进行中的桌子缺少阶段');
    if (!isInt(deadline) || deadline <= 0) fail('进行中的桌子缺少截止时刻');
    if (phase === 'await_buy' && pending === null) fail('待购买阶段缺少待买地块');
    if (phase === 'await_roll' && pending !== null) fail('待掷骰阶段不该有待买地块');
  } else if (phase !== null) {
    fail('没在玩的桌子不该有阶段');
  }
  const lastRaw = data.last;
  let last: Monopoly2dLastTurn | null = null;
  if (lastRaw !== null && lastRaw !== undefined) {
    const row = lastRaw as Record<string, unknown>;
    const seatId = row.seat;
    const dieValue = row.die;
    const from = row.from;
    const to = row.to;
    if (typeof seatId !== 'string' || !ids.has(seatId)) fail('大富翁存档的上一手席位不对');
    if (!isInt(dieValue) || dieValue < 1 || dieValue > 6) fail('大富翁存档的骰点不对');
    if (!isInt(from) || from < 0 || from >= BOARD_SIZE) fail('大富翁存档的起点位置不对');
    if (!isInt(to) || to < 0 || to >= BOARD_SIZE) fail('大富翁存档的落点不对');
    let card: { label: string; amount: number } | undefined;
    if (row.card !== null && row.card !== undefined) {
      const rawCard = row.card;
      if (typeof rawCard !== 'object') fail('大富翁存档的事件卡不对');
      const entry = rawCard as Record<string, unknown>;
      const label = entry.label;
      const amount = entry.amount;
      if (typeof label !== 'string' || !isInt(amount)) fail('大富翁存档的事件卡不对');
      card = { label, amount };
    }
    const rentTo = row.rentTo;
    const lastPending = row.pending;
    const bought = row.bought;
    const rent = row.rent;
    last = {
      seat: seatId,
      die: dieValue,
      from,
      to,
      passedStart: row.passedStart === true,
      rent: isInt(rent) ? rent : 0,
      ...(typeof rentTo === 'string' && ids.has(rentTo) ? { rentTo } : {}),
      ...(card ? { card } : {}),
      ...(isInt(lastPending) ? { pending: lastPending } : {}),
      ...(isInt(bought) ? { bought } : {}),
      ...(row.auto === true ? { auto: true } : {}),
    };
  }
  const rankingRaw = data.ranking;
  const ranking: Monopoly2dRankRow[] = Array.isArray(rankingRaw)
    ? rankingRaw.map((entry: unknown) => {
      const row = entry as Record<string, unknown>;
      const seatId = row.seat;
      const cash = row.cash;
      const estate = row.estate;
      const total = row.total;
      const rank = row.rank;
      if (typeof seatId !== 'string' || !ids.has(seatId)) fail('大富翁存档的排名席位不对');
      if (!isInt(cash) || !isInt(estate) || !isInt(total) || !isInt(rank)) fail('大富翁存档的排名数字不对');
      const properties = row.properties;
      if (!Array.isArray(properties) || properties.some((cell: unknown) => !isInt(cell) || !isProperty(cell))) {
        fail('大富翁存档的排名地产不对');
      }
      return { seat: seatId, cash, estate, total, rank, properties: properties as number[] };
    })
    : [];
  if (status === 'ended' && ranking.length !== SEAT_COUNT) fail('结束的桌子缺少排名');

  return {
    version: stateVersion,
    rulesVersion,
    mapVersion,
    status,
    host,
    seats,
    firstSeat,
    turnNo,
    phase,
    deadline: isInt(deadline) ? deadline : 0,
    owners: Object.fromEntries(owners),
    pending,
    last,
    ranking,
  };
}
