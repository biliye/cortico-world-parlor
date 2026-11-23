/** 客厅 World 的消息队列、招募去重、事件渲染、快照与回执格式化工具。 */
import { serverClock, serverClockShort } from './room/clock.ts';
import { gameLabelOf } from './room/game-labels.ts';
import { formatGomokuAdvice, formatGomokuBoard } from './room/games/gomoku-table.ts';
import {
  formatXiangqiAdvice, formatXiangqiBoard, isMove as isXiangqiMove,
  type Point, type XiangqiHint, type XiangqiMove,
} from './room/games/xiangqi.ts';
import {
  WAKE_TIER_LABELS,
  type ActionResponse, type RecruitTableHint, type RoomEvent, type RoomSnapshot,
} from './room/protocol.ts';
import type { TablePrivateSummary, TableSummary } from './room/table-engine.ts';

export const PENDING_MAX = 50;
export const PENDING_TEXT_MAX = 12_000;

export const KIND_LABELS: Readonly<Record<string, string>> = { pet: 'Coo', human: '人', observer: '观看' };

export interface WakeBatch {
  events: RoomEvent[];
  omitted: number;
  focus: boolean;
}

/** 超出待发上限的旧消息仍在服务器历史里，投递时明确提示省略。 */
export class PendingMessages {
  private events: RoomEvent[] = [];
  private omitted = 0;
  private focus = false;
  get length(): number { return this.events.length; }

  push(event: RoomEvent): void {
    this.events.push(event);
    let chars = this.events.reduce((sum, item) => sum + item.text.length, 0);
    while (this.events.length > PENDING_MAX || (chars > PENDING_TEXT_MAX && this.events.length > 1)) {
      chars -= this.events.shift()!.text.length;
      this.omitted += 1;
    }
  }

  merge(batch: WakeBatch): void {
    this.omitted += batch.omitted;
    this.focus ||= batch.focus;
    for (const event of batch.events) this.push(event);
  }

  take(): WakeBatch {
    const batch = { events: this.events, omitted: this.omitted, focus: this.focus };
    this.clear();
    return batch;
  }

  clear(): void {
    this.events = [];
    this.omitted = 0;
    this.focus = false;
  }
}

export function xiangqiTurnAction(view: Record<string, unknown>): string {
  const { tableId, revision, deadline, hintAction } = view;
  const first = Array.isArray(view.hints) ? view.hints[0] : undefined;
  if (view.game !== 'xiangqi' || view.canAct !== true || typeof tableId !== 'string'
    || typeof revision !== 'number' || !isXiangqiMove(first)) return '';
  const { from, to } = first;
  const action = hintAction === 'move_hint'
    ? { table: tableId, revision, action: hintAction, params: { hint: 1 } }
    : { table: tableId, revision, action: 'move', params: { from, to } };
  const clock = typeof deadline === 'number' ? `截止 ${serverClockShort(deadline)}（UTC+8）。` : '';
  const forced = Array.isArray(view.legalMoves) && view.legalMoves.length === 1 ? '这是唯一合法着法。' : '';
  const chooseOther = hintAction === 'move_hint' && !forced ? '改选其他建议时填对应的 hint 编号。' : '';
  return `【象棋轮到你】${clock}先落子，再聊天或复盘。${forced}${chooseOther}拿不定主意时直接走首选：parlor_game_action ${JSON.stringify(action)}`;
}

/** 只裁剪 Coo 工具输出。HTTP 快照仍给网页完整的棋盘数组。 */
export function compactGameResult(result: Record<string, unknown>, from?: Point): Record<string, unknown> {
  const table = result.table as TableSummary | null | undefined;
  const view = result.tablePrivate as TablePrivateSummary | null | undefined;
  const output = { ...result };
  const formatBoard = (game: string, board: number[], last: unknown) => game === 'xiangqi'
    ? formatXiangqiBoard(board, last as XiangqiMove | undefined)
    : formatGomokuBoard(board, last as Parameters<typeof formatGomokuBoard>[1]);
  const isBoardGame = (game?: string) => game === 'gomoku' || game === 'xiangqi';
  const hasPublicBoard = table && isBoardGame(table.game) && Array.isArray(table.board);
  if (hasPublicBoard) {
    output.table = { ...table, board: formatBoard(table.game, table.board as number[], table.last) };
  }
  if (view && isBoardGame(view.game) && Array.isArray(view.board)) {
    const { board, hints, warning, legalMoves, ...rest } = view;
    const hasSameBoard = hasPublicBoard && (table.id ?? table.tableId) === view.tableId && table.revision === view.revision;
    const moves = Array.isArray(hints) ? hints : [];
    const advice = view.game === 'xiangqi'
      ? formatXiangqiAdvice(moves as XiangqiHint[], warning as string | undefined)
      : formatGomokuAdvice(moves as Parameters<typeof formatGomokuAdvice>[0], warning as Parameters<typeof formatGomokuAdvice>[1]);
    const headline = typeof view.text === 'string' ? view.text.split('\n', 1)[0] : '';
    const turnAction = xiangqiTurnAction(view);
    const legalDestinations = from && view.game === 'xiangqi' && view.canAct === true && Array.isArray(legalMoves)
      ? { from, to: (legalMoves as XiangqiMove[]).filter(move => move.from.row === from.row && move.from.col === from.col).map(move => move.to) }
      : undefined;
    output.tablePrivate = {
      ...rest,
      text: [turnAction, headline, advice].filter(Boolean).join('\n'),
      ...(legalDestinations && { legalDestinations }),
      ...(!hasSameBoard && { board: formatBoard(view.game, board, view.last) }),
    };
  }
  if (Array.isArray(result.tables)) {
    output.tables = result.tables.map((entry: TableSummary) => {
      if (!isBoardGame(entry.game)) return entry;
      const { board: _board, ...summary } = entry;
      return summary;
    });
  }
  return output;
}

/** 同一桌、同一版本、同类型的招募事件只留最后一条。 */
export function collapseRecruitEvents(events: RoomEvent[]): RoomEvent[] {
  const out: RoomEvent[] = [];
  const seen = new Map<string, number>();
  for (const event of events) {
    const signal = event.type === 'parlor.table.discovery'
      || (event.type === 'parlor.table.open' && event.data?.matchOpen === true);
    const tableId = signal && typeof event.data?.tableId === 'string' ? event.data.tableId : '';
    if (!tableId) { out.push(event); continue; }
    const key = `${event.type}:${tableId}:${Number(event.data?.recruitVersion ?? 0)}`;
    const at = seen.get(key);
    if (at === undefined) { seen.set(key, out.length); out.push(event); continue; }
    out[at] = event;
  }
  return out;
}

/** 从一批事件里取「这桌在等人」的 tableId → recruitVersion。 */
export function recruitSignalsOf(events: RoomEvent[]): Map<string, number> {
  const signals = new Map<string, number>();
  for (const event of events) {
    const signal = event.type === 'parlor.table.discovery'
      || (event.type === 'parlor.table.open' && event.data?.matchOpen === true);
    if (!signal) continue;
    const tableId = typeof event.data?.tableId === 'string' ? event.data.tableId : '';
    if (tableId) signals.set(tableId, Number(event.data?.recruitVersion ?? 0));
  }
  return signals;
}

export function renderRoomEvents(events: RoomEvent[], recruitNotice: boolean): string {
  const lines = events.length > 1 ? ['[客厅] 刚才房间里：'] : [];
  const guided = new Set<string>();
  const guideOnce = (kind: string, tableId: string, version: number): boolean => {
    const key = `${kind}:${tableId}:${version}`;
    if (guided.has(key)) return false;
    guided.add(key);
    return true;
  };
  for (const event of events) {
    const name = typeof event.data?.name === 'string' ? event.data.name : event.from;
    switch (event.type) {
      case 'parlor.say': lines.push(`${name}：${event.text}`); break;
      case 'parlor.table.say': lines.push(`${name} 在牌桌上对你们说：${event.text}`); break;
      case 'parlor.whisper': lines.push(`${name} 悄悄对你说：${event.text}`); break;
      case 'parlor.joined':
      case 'parlor.left':
      case 'parlor.tier': lines.push(`（系统）${event.text}`); break;
      case 'parlor.invite': lines.push(`（邀请）${event.text}`); break;
      case 'parlor.table.turn': {
        const view = event.data?.table;
        const action = view && typeof view === 'object' ? xiangqiTurnAction(view as Record<string, unknown>) : '';
        lines.push(...(action ? [action, event.text] : [event.text]));
        break;
      }
      case 'parlor.ledger': lines.push(`（账本）${event.text}`); break;
      case 'parlor.table.open':
      case 'parlor.table.discovery': {
        const game = typeof event.data?.game === 'string' ? event.data.game : '';
        let line = `（桌子）${event.text}`;
        const tableId = typeof event.data?.tableId === 'string' ? event.data.tableId : '';
        const version = Number(event.data?.recruitVersion ?? 0);
        if (recruitNotice && game && event.data?.matchOpen === true
          && (!tableId || guideOnce('join', tableId, version))) {
          line += `想去就 parlor_table {op:"join",params:{game:"${game}"}}。`;
        }
        if (recruitNotice && event.data?.recruit === true
          && (!tableId || guideOnce('recruit', tableId, version))) {
          line += '这桌有招募原话，用 parlor_query {op:"rooms",params:{recruitments:true}} 看。';
        }
        lines.push(line);
        break;
      }
      case 'parlor.table.full': {
        const hint = '等待桌主开局。';
        const text = event.text.endsWith(hint) ? event.text : `${event.text} ${hint}`;
        lines.push(`（桌子）${text}`);
        break;
      }
      case 'parlor.table.join':
      case 'parlor.table.start':
      case 'parlor.table.action':
      case 'parlor.table.werewolf.night':
      case 'parlor.table.werewolf.dawn':
      case 'parlor.table.werewolf.speech_open':
      case 'parlor.table.werewolf.speech':
      case 'parlor.table.werewolf.vote_open':
      case 'parlor.table.werewolf.vote':
      case 'parlor.table.werewolf.hunter':
      case 'parlor.table.werewolf.shot':
      case 'parlor.table.end': lines.push(`（桌子）${event.text}`); break;
      default: lines.push(event.text);
    }
  }
  return lines.join('\n');
}

export function formatRecruitLine(tables: RecruitTableHint[], now = Date.now()): string {
  const parts = tables.map(table => {
    const minutes = Math.max(1, Math.round((table.deadlineAt - now) / 60_000));
    return `${gameLabelOf(table.game)} · ${table.roomName}（${table.seats}/${table.capacity}，还有 ${minutes} 分钟）`;
  });
  return `（顺带）现在有 ${tables.length} 桌在等人：${parts.join('、')}。`
    + `想去就 parlor_table {op:"join",params:{game:"${tables[0].game}"}}；`
    + '只看清单用 parlor_query {op:"rooms",params:{recruitments:true}}。';
}

export function formatRoomSnapshot(snapshot: RoomSnapshot, focused: boolean, recruitNotice: boolean): string {
  const speakers = snapshot.seats.filter((seat) => seat.kind !== 'observer');
  const online = new Set(snapshot.online ?? []);
  const lines = [
    `${snapshot.id === 'hall' ? '大厅' : '客厅'}「${snapshot.name ?? snapshot.id}」 · 会说话的席位 ${speakers.length}/${snapshot.maxSeats}`,
    `服务器时刻：${snapshot.at}（UTC+8）`,
    ...(focused ? ['你正坐在牌桌上（专注）：客厅普通聊只攒摘要，牌局结束后一并给你。'] : []),
    ...snapshot.seats.map((seat) => {
      const kind = KIND_LABELS[seat.kind] ?? seat.kind;
      const tier = seat.kind === 'human' ? '' : `·${WAKE_TIER_LABELS[seat.tier] ?? seat.tier}`;
      const handle = seat.handle ? ` #${seat.handle}` : '';
      return `- ${seat.name}${handle}（${kind}${tier}${online.has(seat.id) ? '·在线' : ''}）`;
    }),
    `最新游标 ${snapshot.latest}`,
  ];
  if (snapshot.monopoly?.signup) {
    const signup = snapshot.monopoly.signup;
    lines.push(`大富翁报名：${signup.seats.join('、')}（${signup.seats.length}/${signup.size}），`
      + `${signup.pace === 'quick' ? '试玩 5 分钟/回合' : '标准 30 分钟/回合'}；`
      + `报名截止 ${serverClock(signup.deadlineAt)}（服务器时刻 UTC+8）`
      + `${signup.missing > 0 ? `，还差 ${signup.missing} 人（脚本陪练最多补 2 个）` : '，可以开局'}。`);
  }
  if (snapshot.monopoly?.fault) lines.push(`大富翁故障：${snapshot.monopoly.fault}（这局被冻结，别当成没开）`);
  const tables = snapshot.tables ?? [];
  if (tables.length > 1) {
    lines.push(`这个客厅有 ${tables.filter((table) => table.status !== 'ended').length} 张桌：`);
    for (const table of tables) {
      lines.push(`- ${table.id} · ${table.label} · ${table.status === 'open' ? '等人' : table.status === 'playing' ? '进行中' : table.status}`
        + `${table.tableId === snapshot.tablePrivate?.tableId ? '（你在这桌）' : ''}`);
    }
  }
  if (snapshot.table) lines.push(snapshot.table.text);
  if (snapshot.tablePrivate) lines.push(snapshot.tablePrivate.text);
  if (snapshot.ledger && snapshot.ledger.games > 0) {
    const perGame = (snapshot.ledger.byGame ?? [])
      .map((row) => `${gameLabelOf(row.game, row.label)} ${row.games} 局`)
      .join('、');
    lines.push(`账本：共 ${snapshot.ledger.games} 局，${snapshot.ledger.wins} 胜 ${snapshot.ledger.losses} 负 ${snapshot.ledger.draws} 平${perGame ? `（${perGame}）` : ''}。`);
  }
  if ((snapshot.mailUnread ?? 0) > 0) lines.push(`信箱：${snapshot.mailUnread} 封未读（parlor_query {op:"mail"} 看）。`);
  if (snapshot.events.length === 0) {
    lines.push('从那个位置之后没有你能看到的新消息。');
  } else {
    lines.push('消息：');
    for (const event of snapshot.events) lines.push(`#${event.seq} ${serverClockShort(event.ts)} ${renderRoomEvents([event], recruitNotice)}`);
  }
  return lines.join('\n');
}

/** 动作回执：统一成「服务器已收下 #游标 · 服务器时刻」，再补这次动作的具体结果。 */
export function formatActionReceipt(result: ActionResponse, done: string): string {
  const lines = [`服务器已收下 #${result.seq} · ${result.at}（服务器时刻 UTC+8）。`, done];
  if (result.delivered && result.delivered.length > 0) {
    const inboxes = result.delivered
      .map((delivery) => `${delivery.to} 的信箱（${delivery.at}）`)
      .join('、');
    lines.push(`已投递到：${inboxes}。这只说明信已留底，不代表对方读过。`);
  }
  if (result.seats && result.seats.length > 0) {
    lines.push(`开局时桌上（服务器现读）：${result.seats.join('、')}。`);
  }
  if (result.deadlineAt) {
    lines.push(`下一个截止：${result.deadlineAt}（服务器时刻 UTC+8）${result.turn ? `，轮到 ${result.turn}` : ''}。`);
  }
  return lines.join('\n');
}

export function formatLedgerTime(ts: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(5, 16).replace('T', ' ');
  }
}

export function formatLedgerDay(ts: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}
