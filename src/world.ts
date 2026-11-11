/**
 * 客厅 World：连上房间，把可见事件按提醒挡位交给 Core，提供说话/私聊/查看工具。
 * 它不判断谁能看见什么；服务器只发这个席位能看见的事件。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoragePart, ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { WorldContext } from 'cortico/world.ts';
import { PARLOR_CONFIG_GROUP, DEFAULT_INVITE_CODE, DEFAULT_ROOM_ID, DEFAULT_SERVER_URL, type ParlorConfigSection } from './config.ts';
import { ParlorClient, ParlorHttpError } from './room/client.ts';
import { serverClock, serverClockShort } from './room/clock.ts';
import { gameLabelOf } from './room/game-labels.ts';
import { IDENTITY_FILE, loadOrCreateIdentity, saveIdentity, type CooIdentity } from './room/identity.ts';
import type { MailPage } from './room/mail.ts';
import { ParlorServer } from './room/server.ts';
import { AmbientWakeBudget } from './wake-budget.ts';
import { parseTableLink } from './room/table-discovery-db.ts';
import { LocalHistory, type HistoryQuery } from './local-history.ts';
import {
  WAKE_TIERS, WAKE_TIER_LABELS, decideWake, isAddressed,
  type ActionRequest, type ActionResponse, type HallView, type InboxNews, type MeView,
  type RecruitTableHint, type RoomEvent, type RoomSnapshot, type RoomSummary, type Seat, type WakeTier,
} from './room/protocol.ts';
import { gameById, type GameDefinition } from './room/games/registry.ts';
import { GAME_ACTION_SCHEMA, compactGameState, describeGame, gameActions, gameCatalog, validateParameters, type GameQuery } from './room/game-api.ts';
import { formatGomokuAdvice, formatGomokuBoard } from './room/games/gomoku-table.ts';
import { formatXiangqiAdvice, formatXiangqiBoard, type XiangqiHint, type XiangqiMove } from './room/games/xiangqi.ts';
import { isWerewolfSeatCount, WEREWOLF_SEAT_COUNT } from './room/games/werewolf.ts';
import type { LedgerEntryView } from './room/ledger.ts';
import { GAME_RESPONSE_MAX_BYTES, type TablePrivateSummary, type TableSummary } from './room/table-engine.ts';
import { PARLOR_TOOL_DECLS, OPERATION_DECLS, TOOL_OPERATIONS, operationHelp } from './tool-contract.ts';
export { PARLOR_TOOL_DECLS } from './tool-contract.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const INVITE_SECRET = 'PARLOR_INVITE_CODE';
const SEAT_SECRET = 'PARLOR_SEAT_TOKEN';
const OWNER_SECRET = 'PARLOR_OWNER_TOKEN';
/** 运营者开关：是否在面板给出可转发的网页访客链接。不放进扩展设置页。 */
const GUEST_JOIN_SECRET = 'PARLOR_ALLOW_GUEST_JOIN';
/** 当前客厅；换房后写回，重启时用它找回席位。 */
const CURRENT_ROOM_SECRET = 'PARLOR_CURRENT_ROOM';
const CURSOR_NAME = 'parlor-cursor.json';
const ROOM_NAME = 'parlor-room.json';

const DIGEST_MS = 60_000;
const CHAT_BATCH_MS = 5_000;
const LINK_GAP_MS = 60_000;
const PENDING_MAX = 50;
const PENDING_TEXT_MAX = 12_000;
/** 招募去重表只留最近的桌：桌号一次性，旧条目不会被再用到。 */
const RECRUIT_HINT_MAX = 200;
/** inbox 探到 404 之后隔多久重探一次：服务器升级到 0.39.0 后最多这么久自动恢复。 */
const INBOX_REPROBE_MS = 10 * 60_000;

/** 只限制普通闲聊投递；直接消息、同桌聊天和行动提醒独立。 */
const TIER_BUDGET: Readonly<Record<WakeTier, number>> = {
  full: 60,
  digest: 30,
  quiet: 0,
  off: 0,
};

/** 只裁剪 Coo 工具输出。HTTP 快照仍给网页完整的棋盘数组。 */
function compactGameResult(result: Record<string, unknown>): Record<string, unknown> {
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
    const { board, hints, warning, legalMoves: _legalMoves, ...rest } = view;
    const hasSameBoard = hasPublicBoard && (table.id ?? table.tableId) === view.tableId && table.revision === view.revision;
    const moves = Array.isArray(hints) ? hints : [];
    const advice = view.game === 'xiangqi'
      ? formatXiangqiAdvice(moves as XiangqiHint[], warning as string | undefined)
      : formatGomokuAdvice(moves as Parameters<typeof formatGomokuAdvice>[0], warning as Parameters<typeof formatGomokuAdvice>[1]);
    const headline = typeof view.text === 'string' ? view.text.split('\n', 1)[0] : '';
    output.tablePrivate = {
      ...rest,
      text: [headline, advice].filter(Boolean).join('\n'),
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

interface WakeBatch {
  events: RoomEvent[];
  omitted: number;
  focus: boolean;
}

/** 超出待发上限的旧消息仍在服务器历史里，投递时明确提示省略。 */
class PendingMessages {
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

const KIND_LABELS: Readonly<Record<string, string>> = { pet: 'Coo', human: '人', observer: '观看' };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));


export class ParlorWorld implements World {
  readonly id = 'parlor';

  private readonly ctx: WorldContext<ParlorConfigSection>;
  private readonly cursorFile: string;
  private readonly identityFile: string;
  private identity?: CooIdentity;
  private host?: WorldHost;
  private server?: ParlorServer;
  private client?: ParlorClient;
  private baseUrl = '';
  private inviteCode = '';
  private token = '';
  private ownerToken = '';
  private seat?: Seat;
  /** 当前客厅；普通聊、牌桌与所有默认动作都落在它上面。 */
  private currentRoom = '';
  /** 对面是不是多客厅网关；旧单客厅服务器只认 /v1/... 别名。 */
  private multiRoom = false;
  private lastSeq = 0;
  /** 每个客厅上次读到的游标；回到客厅/重启时用它续读。 */
  private cursors: Record<string, number> = {};
  private mailUnread = 0;
  /** 专注 B：坐在未结束的牌桌上时，客厅普通聊只攒不叫。 */
  private focused = false;
  /** 我在哪张桌上、看到的是哪一版；多桌时动作靠这两个字段选桌与防迟到。 */
  private myTableId?: string;
  private myTableGame?: string;
  /** 换厅期间先收掉旧流，再使用新身份建流；同时挡住另一笔换厅/匹配。 */
  private switchingRoom = false;
  private myTableRevision?: number;
  /** 桌面版本对应的事件游标；慢快照和断线补发不能把它退回上一手。 */
  private tableStateCursor?: { room: string; seat: string; seq: number };
  private focusRefreshQueued = false;
  private readonly focusBacklog = new PendingMessages();
  private abort?: AbortController;
  private streamTask?: Promise<void>;
  private enteringTable = false;
  private digestTimer?: NodeJS.Timeout;
  private readonly pending = new PendingMessages();
  private readonly tableChat = new PendingMessages();
  private readonly ambientBudget = new AmbientWakeBudget();
  private ambientTimer?: NodeJS.Timeout;
  private tableChatTimer?: NodeJS.Timeout;
  private lastLinkAt = 0;
  private stopped = false;
  private supportTimer?: NodeJS.Timeout;
  private supportBusy = false;
  /** 探测过一次 404 就记住：回退到 0.38.0 之后每轮直接走旧公告接口，不再先撞一次。 */
  private inboxMissing = false;
  /** 上次探测失败的时刻；服务器升上来之后最多 10 分钟重新试一次，别永久锁在旧通道。 */
  private inboxProbeAt = 0;
  private seenAnnouncements: string[] = [];
  /** 新闻复合游标：同一毫秒多条时按 id 继续比较，不会重复也不会漏。 */
  private newsCursor: { publishAt: number; id: string } = { publishAt: 0, id: '' };
  /** 还没搭出去的招募提示；投递成功即清空，首版没有单独兜底推送。 */
  private recruitHint?: { fetchedAt: number; tables: RecruitTableHint[] };
  /** 同厅事件与 inbox 共用：tableId -> 已提示过的 recruitVersion。 */
  private readonly hintedRecruits = new Map<string, number>();
  private history?: LocalHistory;
  private historyTimer?: NodeJS.Timeout;
  private cursorTimer?: NodeJS.Timeout;
  private historyTask?: Promise<void>;
  private historySyncUnsupported = false;
  private historyError = '';
  private readonly historySeats = new Set<string>();
  private readonly historyRooms = new Set<string>();
  /** 访客入口由运营者在部署 .env 里控制；默认关。 */
  private readonly allowGuestJoin: boolean;

  constructor(ctx: WorldContext<ParlorConfigSection>) {
    this.ctx = ctx;
    this.cursorFile = join(ctx.dataDir, CURSOR_NAME);
    this.identityFile = join(ctx.dataDir, IDENTITY_FILE);
    const flag = ctx.secret(GUEST_JOIN_SECRET).trim().toLowerCase();
    this.allowGuestJoin = ['1', 'true', 'yes', 'on'].includes(flag);
  }

  envPromptVars(): Record<string, string> {
    const cfg = this.ctx.cfg;
    return {
      'parlor.room': this.currentRoom || cfg.room || DEFAULT_ROOM_ID,
      'parlor.seat': this.seat?.name ?? (cfg.seatName.trim() || this.ctx.botName),
      'parlor.tier': this.seat?.tier ?? cfg.wakeTier,
      'parlor.address': this.baseUrl || '（未连接）',
      'parlor.focus': this.focused ? '专注牌桌' : '普通',
    };
  }

  tools(): ToolDef[] {
    const handlers: Record<string, (args: Record<string, unknown>) => Promise<string | ToolOutcome> | string> = {
      parlor_query: args => {
        const op = args.op === undefined ? 'room' : String(args.op);
        if (op === 'help') {
          const params = (args.params ?? {}) as Record<string, unknown>;
          validateParameters({ type: 'object', additionalProperties: false, properties: { topic: { type: 'string' } } }, params);
          return JSON.stringify(operationHelp(params.topic as string | undefined));
        }
        return this.groupOperation('query', op, args.params);
      },
      parlor_room: args => this.groupOperation('room', String(args.op), args.params),
      parlor_table: args => this.groupOperation('table', String(args.op), args.params),
      parlor_message: args => {
        const { scope, ...params } = args;
        return this.groupOperation('message', String(scope), params);
      },
      parlor_game_info: args => this.gameInfo(args),
      parlor_game_action: args => this.genericGameAct(args),
      parlor_gift: args => this.groupOperation('gift', String(args.op), args.params),
      parlor_set_tier: args => this.setTier(args),
      parlor_feedback: args => this.supportRequest('feedback', args),
    };
    return PARLOR_TOOL_DECLS.map(decl => ({ ...decl, handler: async args => {
      try {
        validateParameters(decl.parameters, args);
        return await handlers[decl.name](args);
      } catch (error) { return this.failed(messageOf(error)); }
    } }));
  }

  private async groupOperation(group: string, op: string, input: unknown): Promise<string | ToolOutcome> {
    const operations = TOOL_OPERATIONS[group];
    if (!operations || !Object.hasOwn(operations, op)) return this.failed('未知操作，请先用 parlor_query help 查询参数');
    const operation = this.operationTools().find(tool => tool.name === operations[op])!;
    const args = input === undefined ? {} : input;
    if (group === 'query' && op === 'feedback') validateParameters({ type: 'object', additionalProperties: false }, args);
    validateParameters(operation.parameters, args);
    return operation.handler(args as Record<string, unknown>, {} as never);
  }

  private operationTools(): ToolDef[] {
    const byName = new Map(OPERATION_DECLS.map((decl) => [decl.name, decl]));
    const tool = (name: string, handler: ToolDef['handler']): ToolDef => ({ ...byName.get(name)!, handler });
    return [
      tool('parlor_game_info', (args) => this.gameInfo(args)),
      tool('parlor_game_action', (args) => this.genericGameAct(args)),
      tool('parlor_feedback', (args) => this.supportRequest('feedback', args)),
      tool('parlor_announcements', () => this.supportRequest('announcements')),
      tool('parlor_news', (args) => this.readNews(args)),
      tool('parlor_look', (args) => this.look(args)),
      tool('parlor_say', (args) => this.say(args)),
      tool('parlor_whisper', (args) => this.whisper(args)),
      tool('parlor_set_tier', (args) => this.setTier(args)),
      tool('parlor_gift_send', (args) => this.sendGift(args)),
      tool('parlor_gift_eat', (args) => this.eatGift(args)),
      tool('parlor_gifts', (args) => this.readGifts(args)),
      tool('parlor_mail', (args) => this.readMail(args)),
      tool('parlor_ledger', (args) => args.kind === undefined ? this.readLedger() : this.readAccountHistory(args)),
      tool('parlor_replay', (args) => this.readReplay(args)),
      tool('parlor_table_open', (args) => this.openTable(args)),
      tool('parlor_table_discovery', (args) => this.setTableDiscovery(args)),
      tool('parlor_table_join', (args) => this.joinTable(args)),
      tool('parlor_table_leave', (args) => this.tableRequest({
        type: 'table_leave',
        ...(typeof args.table === 'string' && args.table.trim() ? { table: args.table.trim() } : {}),
      }, (result) => result.closed
        ? '离开牌桌了；这张桌是你开的，所以一起收起来了。'
        : '离开牌桌了。')),
      tool('parlor_table_start', (args) => this.tableRequest({
        type: 'table_start',
        ...(typeof args.table === 'string' && args.table.trim() ? { table: args.table.trim() } : {}),
      }, '桌子开始了；轮到你时会被叫醒。')),
      tool('parlor_table_view', (args) => this.tableView(args)),
      tool('parlor_table_say', (args) => this.tableSay(args)),
      tool('parlor_monopoly', (args) => this.monopolyAct(args)),
      tool('parlor_rooms', (args) => args.recruitments === true ? this.tableRecruitments() : this.rooms()),
      tool('parlor_room_create', (args) => this.createRoom(args)),
      tool('parlor_room_visit', (args) => this.visitRoom(args)),
      tool('parlor_invite', (args) => this.invite(args)),
      tool('parlor_invite_accept', (args) => this.answerInvite(args, 'accept')),
      tool('parlor_invite_decline', (args) => this.answerInvite(args, 'decline')),
    ];
  }

  webUi(): WorldWebUiDecl {
    const links = this.baseUrl
      ? [
        // 访客入口默认关；关了就不给可转发的公开链接，只留带钥匙的那两条。
        ...(this.allowGuestJoin
          ? [{ label: '客厅 · 网页牌桌（可发给群友）', href: `${this.baseUrl}/play`, inheritTheme: true }]
          : []),
        // 带钥匙的那条只给自己：点开就换家长会话并下场，不能转发。
        ...(this.multiRoom && this.ownerToken
          ? [{
            label: '客厅 · 我下场玩（带钥匙，勿转发）',
            href: `${this.baseUrl}/play#key=${encodeURIComponent(this.ownerToken)}`,
            inheritTheme: true,
          }]
          : []),
        ...(this.ownerToken
          ? [{
            label: '客厅 · 家长页（只读，带钥匙）',
            href: this.multiRoom
              ? `${this.baseUrl}/parent#key=${encodeURIComponent(this.ownerToken)}`
              : `${this.baseUrl}/v1/owner?token=${encodeURIComponent(this.ownerToken)}`,
            inheritTheme: true,
          }]
          : []),
      ]
      : [];
    links.push({ label: '客厅 · 本地消息档案（按时间查看）',
      href: '/api/webui/providers/world%3Aparlor/panels/history/page', inheritTheme: false });
    const storage: StoragePart[] = [];
    if (!this.ctx.cfg.serverUrl.trim()) storage.push(this.roomStorage());
    storage.push(this.cursorStorage(), this.identityStorage());
    return {
      config: [PARLOR_CONFIG_GROUP],
      panels: [{ id: 'history', title: '本地消息档案', getMethods: ['page', 'script', 'query', 'info'],
        description: '孩子电脑上的持久消息记录，按时间查询；无需打开网页也会持续记录。' }],
      invoke: async (panel, method, args) => {
        if (panel !== 'history') throw new Error('没有这个面板');
        if (method === 'page' || method === 'script') {
          const file = method === 'page' ? 'local-history.html' : 'local-history.js';
          return { $binary: { mime: method === 'page' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
            base64: readFileSync(new URL(`./web/${file}`, import.meta.url)).toString('base64') } };
        }
        const history = this.historyStore();
        const privateHidden = this.focused || !this.seat || this.stopped;
        if (method === 'info') return { ...history.info(), error: this.historyError,
          syncing: !!this.historyTask, privateHidden, server: this.baseUrl, name: this.seat?.name };
        if (method === 'query') return history.query((args[0] ?? {}) as HistoryQuery, privateHidden);
        throw new Error('没有这个查询方法');
      },
      links,
      storage,
      promptDocs: [
        {
          key: 'worlds.parlor.envPrompt',
          title: '客厅 · 环境提示词',
          description: '客厅进 system 前缀的那一段。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'parlor.room', description: '当前客厅。' },
            { name: 'parlor.seat', description: '你在这个客厅里的席位名。' },
            { name: 'parlor.tier', description: '当前提醒挡位。' },
            { name: 'parlor.address', description: '客厅地址；未连接时是占位。' },
            { name: 'parlor.focus', description: '专注牌桌 / 普通。' },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.stopped = false;
    this.host = host;
    this.history?.close(); this.history = undefined;
    this.historySeats.clear(); this.historyRooms.clear(); this.historyError = '';
    this.historySyncUnsupported = false;
    await this.connect();
    // connect 可能修复/重建身份；写入必须使用连接后实际的孩子身份。
    this.history = new LocalHistory(this.ctx.dataDir,
      this.ctx.cfg.serverUrl.trim().replace(/\/+$/, '') || 'self', this.identity!.cooId);
    if (this.seat) this.historySeats.add(this.seat.id);
    this.historyRooms.add(this.currentRoom);
    this.scheduleHistorySync();
    this.historyTimer = setInterval(() => this.scheduleHistorySync(), 60_000);
    this.historyTimer.unref?.();
    this.digestTimer = setInterval(() => { void this.flushDigest(); }, DIGEST_MS);
    this.digestTimer.unref?.();
    this.streamTask = this.runStream();
    if (this.multiRoom) {
      this.supportTimer = setInterval(() => { void this.pollInbox(); }, 60_000);
      this.supportTimer.unref?.();
      void this.pollInbox();
    }
    await host.pushEvent({
      type: 'parlor.started',
      ts: nowIso(this.ctx.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: `客厅已连接。席位：${this.seat?.name ?? '未知'}${this.seat?.handle ? ` #${this.seat.handle}` : ''}${this.focused ? '（正在牌桌上：客厅闲聊只攒摘要）' : ''}。${this.mailUnread > 0 ? `信箱里有 ${this.mailUnread} 封未读，用 parlor_query {op:"mail"} 看。` : ''}`,
      meta: { room: this.currentRoom, seat: this.seat?.id, address: this.baseUrl },
    }, { trigger: 'flush' });
  }

  async stop(): Promise<void> {
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    this.cursorTimer = undefined;
    this.writeCursor();
    this.stopped = true;
    if (this.historyTimer) clearInterval(this.historyTimer);
    this.historyTimer = undefined;
    if (this.supportTimer) clearInterval(this.supportTimer);
    this.supportTimer = undefined;
    this.clearPendingMessages();
    this.abort?.abort();
    if (this.digestTimer) clearInterval(this.digestTimer);
    this.digestTimer = undefined;
    await this.streamTask?.catch(() => {});
    this.streamTask = undefined;
    await this.historyTask;
    this.history?.close();
    await this.server?.close();
    this.server = undefined;
  }

  /** 入座用的名字：配置的席位名，留空用 bot 显示名。撞名加序号由服务器做。 */
  private baseSeatName(): string {
    const cfg = this.ctx.cfg;
    return (cfg.seatName.trim() || this.ctx.botName).trim().replace(/\s+/g, ' ').slice(0, 24);
  }

  private async connect(): Promise<void> {
    const cfg = this.ctx.cfg;
    const defaultRoom = cfg.room || DEFAULT_ROOM_ID;
    this.currentRoom = this.ctx.secret(CURRENT_ROOM_SECRET).trim() || defaultRoom;
    let baseUrl = cfg.serverUrl.trim().replace(/\/+$/, '');
    // 自己填的码永远优先。留空、或还是包里那份公开默认值时，先看 .env（老部署把码写在那儿），
    // 再看公开默认值——装完不用动设置就能连上房主的客厅。
    const configured = cfg.inviteCode.trim();
    const fromEnv = this.ctx.secret(INVITE_SECRET).trim();
    let invite = configured;
    if (!configured || configured === DEFAULT_INVITE_CODE) {
      invite = fromEnv || (baseUrl === DEFAULT_SERVER_URL ? DEFAULT_INVITE_CODE : configured);
    }

    if (!baseUrl) {
      const dataFile = this.roomFile();
      // 自己开客厅时不用包里那份公开码：人人都有，等于没锁。读 .env，没有就新生成一个。
      if (invite === DEFAULT_INVITE_CODE) invite = this.ctx.secret(INVITE_SECRET).trim();
      invite = invite || randomBytes(9).toString('base64url');
      // 单间服务器没有「大厅」这种东西（大厅是多客厅网关的目录，网页会按大厅画）；
      // 配置还是默认值时就叫 lobby，免得自己开的客厅在网页上显示成大厅。
      if (this.currentRoom === DEFAULT_ROOM_ID) this.currentRoom = 'lobby';
      if (!this.ctx.secret(INVITE_SECRET)) {
        try { this.ctx.storeSecret(INVITE_SECRET, invite); } catch { /* 假上下文或不可写 */ }
      }
      this.server = new ParlorServer({
        id: this.currentRoom,
        inviteCode: invite,
        maxSeats: cfg.maxSeats,
        dataFile,
        host: cfg.host,
        port: cfg.port,
      });
      const address = await this.server.listen();
      baseUrl = address.url;
    }

    this.baseUrl = baseUrl;
    this.inviteCode = invite;
    this.identity = loadOrCreateIdentity(this.identityFile);
    const client = new ParlorClient(baseUrl, this.identity);
    this.client = client;
    try {
      this.multiRoom = !this.server && await client.initializeIdentity(
        cfg.identityUrl || DEFAULT_SERVER_URL, DEFAULT_INVITE_CODE, this.baseSeatName(),
      );
    } catch (error) {
      if (error instanceof Error && error.message === '已有身份属于另一统一身份服务，请保持原身份服务地址') {
        throw new Error(`已有身份属于另一统一身份服务（${this.identity.authority}）。要换到 ${cfg.identityUrl || DEFAULT_SERVER_URL}，请先停用客厅，删除本机身份文件 ${resolve(this.identityFile)}，再启用。删除后会生成新身份，不能自动取回原身份的席位、账本和私聊；原数据仍保留在原服务器。请先备份该文件，需要沿用原身份时保持原身份服务地址。`);
      }
      throw error;
    }
    this.loadCursors();

    const stored = this.ctx.secret(SEAT_SECRET).trim();
    if (stored) {
      let snapshot;
      if (this.multiRoom) {
        try {
          const location = await client.location(stored);
          if (location.room) this.currentRoom = location.room;
        } catch { /* older servers may not provide identity location */ }
      }
      try {
        snapshot = await client.snapshot(stored, 0, 1, this.roomArg());
      } catch (error) {
        // 令牌失效或那个客厅已经不在了：重新入场（当前客厅仍然有效时优先回它）。
        if (!(error instanceof ParlorHttpError) || (error.status !== 401 && error.status !== 404)) throw error;
      }
      if (snapshot) {
        this.token = stored;
        this.ownerToken = this.ctx.secret(OWNER_SECRET).trim();
        this.seat = snapshot.seat;
        this.lastSeq = this.resumeFrom(snapshot.latest);
        this.applySnapshot(snapshot);
        await this.syncSeatName(client);
        return;
      }
    }

    if (!invite) {
      throw new Error('客厅：扩展设置里的「邀请码」是空的，部署 .env 里也没有 PARLOR_INVITE_CODE。连房主的客厅要填对方的邀请码；自己开客厅就留空让 World 生成。');
    }
    await this.joinRoom(client);
  }

  /** 用现有身份入座，拿一枚新令牌；启动和「席位被释放后自动重连」共用。 */
  private async joinRoom(client: ParlorClient): Promise<void> {
    const request = { name: this.baseSeatName(), kind: 'pet' as const, tier: this.ctx.cfg.wakeTier };
    let joined;
    try {
      joined = await client.join(this.inviteCode, request, this.roomArg());
    } catch (error) {
      if (!this.multiRoom || !(error instanceof ParlorHttpError)) throw error;
      const archived = error.status === 403 && error.message.includes('已经归档');
      const defaultRoom = this.ctx.cfg.room || DEFAULT_ROOM_ID;
      // 旧网关的准入检查把「不存在」也回成 403，兼容它但不吞权限/邀请码错误。
      const missing = (error.status === 404 || (error.status === 403 && error.message === '目标客厅不存在'))
        && this.currentRoom !== defaultRoom;
      if (!archived && !missing) throw error;
      const target = archived ? DEFAULT_ROOM_ID : defaultRoom;
      joined = await client.join(this.inviteCode, request, target);
      this.currentRoom = target;
      this.clearPendingMessages();
      this.focused = false;
      await this.reportLink(archived ? '原客厅已被房主删除，已回到大厅。'
        : `原客厅不存在，已回到${target === DEFAULT_ROOM_ID ? '大厅' : target}。`, true);
    }
    if (joined.room) this.currentRoom = joined.room;
    this.token = joined.token;
    // 新网关首次建家长账户时给一次 ownerKey；旧服务器给的是每厅 ownerToken。
    // 已有账户再次加入不会发新钥匙：这时要留住 .env 里那把，别拿空串覆盖。
    const issued = (joined.ownerKey ?? joined.ownerToken ?? '').trim();
    this.ownerToken = issued || this.ctx.secret(OWNER_SECRET).trim();
    this.seat = joined.seat;
    try {
      this.ctx.storeSecret(SEAT_SECRET, joined.token);
      if (this.ownerToken) this.ctx.storeSecret(OWNER_SECRET, this.ownerToken);
      this.saveCursor();
    } catch { /* 假上下文或不可写 */ }
    const snapshot = await client.snapshot(this.token, 0, 1, this.roomArg());
    if (this.identity?.authority) saveIdentity(this.identityFile, this.identity);
    this.lastSeq = this.resumeFrom(snapshot.latest);
    this.applySnapshot(snapshot);
    await this.syncSeatName(client);
  }

  /** 续用席位或重新领令牌时，配置里的名字也要生效；不换席位。 */
  private async syncSeatName(client: ParlorClient): Promise<void> {
    if (!this.seat || this.seat.name === this.baseSeatName()) return;
    try {
      const renamed = await client.rename(this.token, this.baseSeatName());
      this.seat = { ...this.seat, name: renamed.name };
    } catch (error) {
      if (!(error instanceof ParlorHttpError) || ![404, 405].includes(error.status)) throw error;
      await this.reportLink('服务器尚不支持同步席位名；请升级服务器，或释放原席位后重新入座让新名字生效。', true);
    }
  }

  /**
   * 席位被服务器释放了（离线太久、被房主请出去），手里的令牌已经失效：
   * 用同一身份重新入座，换新令牌接着收流。失败就交给下一轮退避。
   */
  private async rejoinSeat(): Promise<boolean> {
    const client = this.client;
    if (!client || !this.inviteCode) return false;
    try {
      await this.joinRoom(client);
      await this.reportLink(`席位被释放了，已重新入座：${this.seat?.name ?? '未知'}。`, true);
      return true;
    } catch {
      return false;
    }
  }

  /** 断线重连从上次游标继续；游标比服务器新（房间重建过）时退回服务器最新。 */
  private resumeFrom(latest: number): number {
    const saved = this.cursors[this.currentRoom] ?? 0;
    return saved > 0 && saved <= latest ? saved : latest;
  }

  /** 游标文件按客厅分开；旧格式 {room, seq} 还能读。 */
  private loadCursors(): void {
    try {
      const raw = JSON.parse(readFileSync(this.cursorFile, 'utf8')) as {
        room?: string; seq?: number; rooms?: Record<string, unknown>; current?:string; server?:string;
        announcements?: string[];
        news?: { publishAt?: unknown; id?: unknown };
      };
      if (raw.server && raw.server !== this.baseUrl) return;
      if (raw.current) this.currentRoom = raw.current;
      const rooms: Record<string, number> = {};
      if (raw.rooms && typeof raw.rooms === 'object') {
        for (const [id, seq] of Object.entries(raw.rooms)) {
          if (typeof seq === 'number' && Number.isFinite(seq)) rooms[id] = seq;
        }
      }
      if (typeof raw.room === 'string' && typeof raw.seq === 'number' && Number.isFinite(raw.seq)) {
        rooms[raw.room] = raw.seq;
      }
      this.cursors = rooms;
      this.seenAnnouncements = Array.isArray(raw.announcements) ? raw.announcements.filter(id => typeof id === 'string').slice(-100) : [];
      // v2 没有 news 字段：按 0 处理，首次启用只推最新一条，符合预期。
      const publishAt = Number(raw.news?.publishAt ?? 0);
      this.newsCursor = {
        publishAt: Number.isFinite(publishAt) && publishAt > 0 ? publishAt : 0,
        id: typeof raw.news?.id === 'string' ? raw.news.id : '',
      };
    } catch {
      this.cursors = {};
    }
  }

  /** 专注 B：坐在未结束的牌桌上时，客厅普通聊只攒不叫。 */
  private applySnapshot(snapshot: RoomSnapshot): void {
    if (snapshot.seat.id !== this.seat?.id) return;
    for (const event of snapshot.events) this.recordHistoryEvent(event, snapshot.id);
    const priv = snapshot.tablePrivate;
    if (priv?.tableId === this.myTableId && typeof priv?.revision === 'number'
      && this.myTableRevision !== undefined && priv.revision < this.myTableRevision) return;
    if (!this.acceptTableState(snapshot.latest)) return;
    const wasFocused = this.focused;
    this.focused = priv !== null && priv !== undefined
      && snapshot.table !== undefined && snapshot.table.status !== 'ended';
    this.mailUnread = snapshot.mailUnread ?? this.mailUnread;
    if (priv) {
      const game = priv.game ?? snapshot.table?.game;
      if (typeof game === 'string') this.myTableGame = game;
      if (typeof priv.tableId === 'string') this.myTableId = priv.tableId;
      if (typeof priv.revision === 'number') this.myTableRevision = priv.revision;
    } else {
      // 不在桌上：清掉旧桌号，免得动作打到上一局。
      this.myTableId = undefined;
      this.myTableGame = undefined;
      this.myTableRevision = undefined;
    }
    if (wasFocused && !this.focused) void this.flushFocus();
  }

  private acceptTableState(seq: number): boolean {
    const seat = this.seat?.id ?? '';
    const previous = this.tableStateCursor;
    if (previous?.room === this.currentRoom && previous.seat === seat && seq < previous.seq) return false;
    this.tableStateCursor = { room: this.currentRoom, seat, seq };
    return true;
  }

  /** 别的席位出牌后，我的桌面版本也会变；合并成一次快照刷新。 */
  private scheduleFocusRefresh(): void {
    if (this.focusRefreshQueued) return;
    this.focusRefreshQueued = true;
    setImmediate(() => {
      this.focusRefreshQueued = false;
      void this.refreshFocus();
    });
  }

  private async refreshFocus(): Promise<RoomSnapshot | null> {
    if (!this.client || !this.token) return null;
    try {
      const snapshot = await this.client.snapshot(this.token, 0, 1, this.roomArg());
      this.applySnapshot(snapshot);
      return snapshot;
    } catch { /* 下一轮再说；专注状态不因此误改 */ }
    return null;
  }

  private saveCursor(): void {
    if (this.currentRoom) this.cursors[this.currentRoom] = this.lastSeq;
    if (this.cursorTimer) return;
    this.cursorTimer = setTimeout(() => { this.cursorTimer = undefined; this.writeCursor(); }, 300);
    this.cursorTimer.unref?.();
  }
  private writeCursor(): void {
    try {
      mkdirSync(dirname(this.cursorFile), { recursive: true });
      writeFileSync(
        this.cursorFile,
        JSON.stringify({
          version: 3, server: this.baseUrl, current: this.currentRoom,
          rooms: this.cursors, announcements: this.seenAnnouncements, news: this.newsCursor,
        }),
        { mode: 0o600 },
      );
    } catch { /* 游标写不进去只会多补一遍 */ }
  }

  private async runStream(): Promise<void> {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    let backoff = 1000;
    let disconnected = false;
    let lastDownAt = -Infinity;
    let lastUpAt = -Infinity;
    const reportDisconnected = async (text: string) => {
      disconnected = true;
      if (Date.now() - lastDownAt < LINK_GAP_MS) return;
      lastDownAt = Date.now();
      await this.reportLink(text, true);
    };
    while (!signal.aborted && !this.stopped) {
      const client = this.client;
      const token = this.token;
      const room = this.roomArg();
      const seat = this.seat?.id;
      const current = () => !signal.aborted && !this.stopped && this.client === client
        && this.token === token && this.roomArg() === room && this.seat?.id === seat;
      let clean = false;
      try {
        await client?.stream(
          token, this.lastSeq, (event) => { if (current()) this.onRoomEvent(event); }, signal, room,
          // 连上了就说明上一次退避已经过期：别让「断过很久」留下的 60 秒等待
          // 拖到下一次掉线。下一次真的断了，从 1 秒重试开始。
          () => {
            if (!current()) return;
            backoff = 1000;
            this.historySeats.add(this.seat!.id);
            this.historyRooms.add(this.currentRoom);
            this.scheduleHistorySync();
            if (disconnected) {
              disconnected = false;
              if (Date.now() - lastUpAt >= LINK_GAP_MS) {
                lastUpAt = Date.now();
                void this.reportLink('客厅连接已恢复，继续从上次游标接收消息。', true);
              }
              void this.refreshFocus();
            }
          },
        );
        clean = true;
      } catch (error) {
        if (signal.aborted || this.stopped) return;
        if (!current()) continue;
        // 令牌失效 = 席位已经不在（离线清理/被请出去）：重新入座，别拿死令牌一直重试。
        if (error instanceof ParlorHttpError && [401,403,404].includes(error.status)) {
          if (await this.syncLocation() || !current()) continue;
        }
        if (error instanceof ParlorHttpError && error.status === 401 && await this.rejoinSeat()) {
          if (signal.aborted || this.stopped) return;
          backoff = 1000;
          continue;
        }
        if (!disconnected) {
          await reportDisconnected(`客厅连接断了：${messageOf(error)}。会自动重试，恢复后通知。`);
        }
      }
      if (signal.aborted || this.stopped) return;
      if (!current()) continue;
      if (clean) {
        if (!disconnected) {
          await reportDisconnected('客厅连接已结束，会自动重新连接。');
        }
      }
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, backoff);
        signal.addEventListener('abort', done, { once: true });
        if (signal.aborted) done();
      });
      backoff = Math.min(backoff * 2, 60_000);
    }
  }

  private async reportLink(text: string, force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastLinkAt < LINK_GAP_MS) return;
    this.lastLinkAt = now;
    try { await this.host?.pushEvent({
      type: 'parlor.link',
      ts: nowIso(this.ctx.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text,
      meta: { address: this.baseUrl },
    }, { trigger: 'debounce' }); } catch { /* 通知写入失败不能终止网络恢复循环。 */ }
  }

  private historyStore(): LocalHistory {
    if (this.history) return this.history;
    if (!existsSync(this.identityFile)) throw new Error('请先启用客厅，让孩子连接一次后再查看本地档案');
    const identity = JSON.parse(readFileSync(this.identityFile, 'utf8')) as { cooId?: unknown };
    if (typeof identity.cooId !== 'string' || !identity.cooId) throw new Error('孩子身份文件无效，无法定位本地档案');
    this.history = new LocalHistory(this.ctx.dataDir,
      this.ctx.cfg.serverUrl.trim().replace(/\/+$/, '') || 'self', identity.cooId);
    return this.history;
  }

  private historyWrite(write: () => void): void {
    if (this.stopped) return;
    try { write(); } catch (error) { this.historyFailure(`本地消息写入失败：${messageOf(error)}`); }
  }

  private historyFailure(error: string): void {
    if (error !== this.historyError) this.host?.log.error(error);
    this.historyError = error;
  }

  private recordHistoryEvent(event: Pick<RoomEvent, 'seq' | 'ts' | 'type' | 'from' | 'text' | 'data'>, room: string, strict = false): void {
    if (!this.history || this.stopped) return;
    // 多客厅私聊以全局信件号归档，避免跨厅通知与信箱补收记成两封。
    const mail = event.data?.mail as { seq: number; ts: number; room: string } | undefined;
    if (this.multiRoom && event.type === 'parlor.whisper' && !mail) return;
    const actor = typeof event.data?.actorSeatId === 'string' ? event.data.actorSeatId : event.from;
    const mine = actor === this.seat?.id || this.historySeats.has(actor);
    const write = () => this.history!.append({
      id: mail ? `mail:${mail.seq}` : `event:${room}:${event.seq}`,
      ts: mail?.ts ?? event.ts, room: mail?.room ?? room, type: event.type,
      direction: mine ? 'sent' : 'received',
      sender: String(event.data?.actorName || event.data?.name || (mine ? this.seat?.name || '孩子' : event.from === 'system' ? '系统' : event.from)),
      recipient: String(event.data?.to || (event.type === 'parlor.say' ? '客厅' : event.type === 'parlor.table.say' ? '同桌' : '孩子')),
      text: event.text,
      private: event.type === 'parlor.table.turn',
    });
    if (strict) write(); else this.historyWrite(write);
  }

  private scheduleHistorySync(): void {
    if (!this.history || this.stopped || this.historyTask) return;
    this.historyTask = this.syncHistory().catch(error => {
      this.historyFailure(`本地消息补收失败：${messageOf(error)}`);
    }).finally(() => { this.historyTask = undefined; });
  }

  private async syncHistory(): Promise<void> {
    const history = this.history!;
    const client = this.client!;
    let unsupported = false;
    // 信箱按全局游标补收，包含已读信，不把查看行为写回服务器。
    if (this.multiRoom) {
      let after = history.progress('mail');
      for (;;) {
        if (this.stopped) return;
        let page;
        try { page = await client.messageHistory(this.token, after); }
        catch (error) {
          if (!(error instanceof ParlorHttpError) || error.status !== 404) throw error;
          this.historyFailure('客厅服务器尚不支持完整信箱补档；需更新服务器。实时客厅事件仍会保存。');
          unsupported = true;
          break;
        }
        for (const seat of page.seats) { this.historySeats.add(seat.id); this.historyRooms.add(seat.room); }
        for (const item of page.items) {
          history.append({ id: `mail:${item.seq}`, ts: item.ts, room: item.room,
            type: item.kind === 'whisper' ? 'parlor.whisper' : `mail.${item.kind}`,
            direction: item.fromMe ? 'sent' : 'received', sender: item.fromName,
            recipient: item.fromMe ? `${item.toName || '对方'}${item.toHandle ? ` #${item.toHandle}` : ''}` : this.seat?.name || '孩子',
            text: item.text, private: item.action === 'mail-turn' });
          after = item.seq;
        }
        // 只有整页成功落盘后推进；崩溃重拉同一页也不会重复。
        history.advance('mail', after);
        if (page.items.length < 200) break;
      }
    }
    for (const room of [...this.historyRooms]) {
      if (this.stopped) return;
      if (this.multiRoom && await this.syncRoomHistory(room)) continue;
      // 旧网关/旧单间保留回放兼容，不能把未知的新参数误当作已支持的增量协议。
      const previous = history.progress(`room:${room}`);
      let high = previous;
      let before: number | undefined;
      for (;;) {
        if (this.stopped) return;
        const page = this.multiRoom
          ? await client.replayAsIdentity(room, 200, before)
          : await client.replay(this.token, 200, before);
        for (const event of page.events) {
          this.recordHistoryEvent(event, room, true);
          high = Math.max(high, event.seq);
        }
        if (!page.events.length || !page.older || page.events.some(event => event.seq <= previous)) break;
        before = page.events[0].seq;
      }
      history.advance(`room:${room}`, high);
    }
    if (!unsupported) this.historyError = '';
  }

  /** 正序补齐缺口；一页成功落盘才推进，不让后续页失败跳过尚未保存的消息。 */
  private async syncRoomHistory(room: string): Promise<boolean> {
    if (this.historySyncUnsupported) return false;
    const history = this.history!;
    let after = history.progress(`room:${room}`);
    while (!this.stopped) {
      let page;
      try { page = await this.client!.historySync(room, after); }
      catch (error) {
        if (!(error instanceof ParlorHttpError) || error.status !== 404) throw error;
        this.historySyncUnsupported = true;
        return false;
      }
      const previous = after;
      for (const event of page.events) {
        if (!Number.isSafeInteger(event.seq) || event.seq <= after) throw new Error('补档返回了无效的历史游标');
        this.recordHistoryEvent(event, room, true);
        after = event.seq;
      }
      if (this.stopped) return true;
      history.advance(`room:${room}`, after);
      if (!page.more) return true;
      if (after === previous) throw new Error('补档分页没有前进');
    }
    return true;
  }

  private onRoomEvent(event: RoomEvent): void {
    if (!this.seat || event.seq <= this.lastSeq) return;
    this.recordHistoryEvent(event, this.currentRoom);
    this.lastSeq = event.seq;
    this.saveCursor();
    if (event.from === this.seat.id) return;

    // 行动通知已经带着这一手的私视图：先同步版本，再叫醒，不能等后台 HTTP 刷新。
    if (event.type === 'parlor.table.turn' && event.scope.kind === 'seat' && event.scope.seatId === this.seat.id) {
      const table = event.data?.table as Record<string, unknown> | undefined;
      const tableId = event.data?.tableId;
      if (table?.seat === this.seat.id && typeof tableId === 'string'
        && typeof table.revision === 'number' && this.acceptTableState(event.seq)) {
        this.myTableId = tableId;
        if (typeof table.game === 'string') this.myTableGame = table.game;
        this.myTableRevision = table.revision;
        this.focused = table.status !== 'ended';
      }
    }

    // 大厅进出仍留在网页和主动查看的历史里，不进入 Coo 的即时消息或待发摘要。
    // 在这里过滤，游标已推进；断线补发也会走同一条。
    if (this.multiRoom && this.currentRoom === 'hall'
      && (event.type === 'parlor.joined' || event.type === 'parlor.left')) return;
    // 普通客厅只投递限频后的进入提示；离开不进入即时消息或任何摘要。
    if (event.type === 'parlor.left'
      || (event.type === 'parlor.joined' && event.data?.presenceCoo === false)) return;

    // 牌桌事件会改桌面版本：合并刷新一次快照，免得下一次动作拿着旧版本被拒。
    if (event.type.startsWith('parlor.table.')) this.scheduleFocusRefresh();
    // 公开牌局动态留给主动围观，不自动塞进桌外 Coo 的上下文或摘要。
    // 游标已推进，重连补发同样过滤；私视图和同桌聊天仍按原规则投递。
    // 例外：discovery 与「开桌就开放匹配」不是牌局进行动态，而是「这桌在等人」。
    // 跨厅与大厅由 inbox 补，两条路径共用 tableId:recruitVersion 去重。
    const recruitSignal = event.type === 'parlor.table.discovery'
      || (event.type === 'parlor.table.open' && event.data?.matchOpen === true);
    if (event.type.startsWith('parlor.table.') && !recruitSignal && event.scope.kind === 'room') {
      const tableId = typeof event.data?.tableId === 'string' ? event.data.tableId : undefined;
      // 旧单间协议的动作没有桌号，但一间只有一桌，用专注状态兼容。
      if (tableId ? tableId !== this.myTableId : !this.focused) return;
    }
    // 关掉招募提示时两条路径一起停：这里丢弃，后面的待发队列就不会收。
    if (recruitSignal && !this.ctx.cfg.recruitNotice) return;
    // 同厅已经提示过的版本不再进队列，避免和 inbox 搭车重复。
    if (recruitSignal) {
      const tableId = typeof event.data?.tableId === 'string' ? event.data.tableId : '';
      const version = Number(event.data?.recruitVersion ?? 0);
      if (tableId && this.hintedRecruits.get(tableId) === version) return;
    }
    // 窗口制的纯桌面刷新（队友交了刀票/发言）不是行动请求：快照刷新即可，不叫醒。
    if (event.type === 'parlor.table.turn' && event.data?.decision === false) return;

    // 普通桌聊最多等五秒合并；真正点名、私聊或行动请求会立即带上这批话。
    if (event.type === 'parlor.table.say' && !event.mentions?.includes(this.seat.id)) {
      if (this.seat.tier === 'off' || this.seat.kind === 'observer') return;
      this.tableChat.push(event);
      if (!this.tableChatTimer) {
        this.tableChatTimer = setTimeout(() => {
          this.tableChatTimer = undefined;
          if (this.stopped || this.seat?.tier === 'off') { this.tableChat.clear(); return; }
          void this.pushWake(this.tableChat.take(), true);
        }, CHAT_BATCH_MS);
        this.tableChatTimer.unref?.();
      }
      return;
    }

    // 专注 B：客厅闲聊攒到局后再按额度投递；直接消息与本人行动及时提醒。
    if (this.focused) {
      if (event.type === 'parlor.table.end') {
        const endTableId = typeof event.data?.tableId === 'string' ? event.data.tableId : undefined;
        if (endTableId && this.myTableId && endTableId !== this.myTableId) return;
        this.focused = false;
        // 结算及时交付；局间积攒的客厅闲聊另走普通投递额度。
        if (this.seat.tier !== 'off') void this.pushDirect(event, false);
        void this.flushFocus();
        return;
      }
      const decision = decideWake(event, this.seat);
      if (decision.wake && isAddressed(event, this.seat.id)) {
        void this.pushDirect(event, true);
        return;
      }
      // 牌桌自己的动作不进摘要：正在打的人有私视图，重复一边只会吵。
      const ordinary = event.scope.kind === 'room'
        && !event.type.startsWith('parlor.table.');
      if (ordinary && this.seat.tier !== 'off') {
        this.focusBacklog.push(event);
      }
      return;
    }

    const decision = decideWake(event, this.seat);
    if (decision.wake && decision.addressed) {
      void this.pushDirect(event, true);
      return;
    }
    if (this.seat.tier === 'off') return;
    this.pending.push(event);
    if (this.seat.tier === 'full' && !this.focused) this.scheduleAmbient(CHAT_BATCH_MS);
  }

  private async flushDigest(): Promise<void> {
    if (this.stopped) return;
    await this.reconcileTier();
    // 专注期间不跑周期摘要；牌局结束后再把闲聊移回普通投递队列。
    if (this.focused) return;
    if (!this.seat || this.pending.length === 0) return;
    if (this.seat.tier !== 'digest' && this.seat.tier !== 'full') return;
    await this.flushAmbient();
  }

  private scheduleAmbient(delayMs: number): void {
    if (this.ambientTimer || this.stopped) return;
    this.ambientTimer = setTimeout(() => {
      this.ambientTimer = undefined;
      void this.flushAmbient();
    }, delayMs);
    this.ambientTimer.unref?.();
  }

  private async flushAmbient(): Promise<void> {
    if (this.stopped || !this.host || !this.seat || this.focused || !this.pending.length) return;
    // 总闸：这一轮不 take、不占投递额度。确认 off 时会清空当时队列里的那批；
    // 只有「还没确认」和「确认时正在投递」的批次留得到恢复之后（见 pushWake）。
    if (this.ctx.cfg.wakeTier === 'off') return;
    const limit = TIER_BUDGET[this.seat.tier];
    if (!limit || this.seat.kind === 'observer') return;
    const wait = this.ambientBudget.reserve(limit, Date.now());
    if (wait > 0) { this.scheduleAmbient(wait); return; }
    if (this.ambientTimer) clearTimeout(this.ambientTimer);
    this.ambientTimer = undefined;
    await this.pushWake(this.pending.take(), false);
  }

  /** 牌局结束：客厅闲聊回到受预算约束的队列，避免局后摘要绕过限额。 */
  private async flushFocus(): Promise<void> {
    if (this.stopped || !this.host) return;
    const batch = this.focusBacklog.take();
    if (batch.events.length === 0) return;
    if (!this.seat || this.seat.tier === 'off' || this.ctx.cfg.wakeTier === 'off') return;
    this.pending.merge({ ...batch, focus: true });
    await this.flushAmbient();
  }

  /** 有人直接找我时带上积压消息；豁免投递不消耗普通闲聊的额度。 */
  private async pushDirect(event: RoomEvent, addressed: boolean): Promise<void> {
    const batch = this.pending.take();
    const chat = this.tableChat.take();
    const merged = new PendingMessages();
    merged.merge({
      events: [...batch.events, ...chat.events, event].sort((a, b) => a.seq - b.seq),
      omitted: batch.omitted + chat.omitted,
      focus: batch.focus,
    });
    if (this.ambientTimer) clearTimeout(this.ambientTimer);
    if (this.tableChatTimer) clearTimeout(this.tableChatTimer);
    this.ambientTimer = undefined;
    this.tableChatTimer = undefined;
    await this.pushWake(merged.take(), addressed);
  }

  private clearPendingMessages(): void {
    if (this.ambientTimer) clearTimeout(this.ambientTimer);
    if (this.tableChatTimer) clearTimeout(this.tableChatTimer);
    this.ambientTimer = undefined;
    this.tableChatTimer = undefined;
    this.pending.clear();
    this.focusBacklog.clear();
    this.tableChat.clear();
  }

  private async pushWake(batch: WakeBatch, addressed: boolean): Promise<void> {
    if (this.stopped || !this.host) return;
    // `wakeTier='off'` 是自动提醒总闸。席位档位要等 reconcileTier 异步推上去，
    // 热切之后到同步完成之间，事件仍会按旧档位排进队列；这里按当前配置再挡一次，
    // 否则静音期间照样会收到摘要（招募就在摘要里）。
    // 这批先还回队列，但只在这两段里留得住：① 服务端还没确认 off（快速关开即此）；
    // ② 确认那一刻正在投递、被挡回来的在途批次。确认时已经躺在队列里的那批，
    // 会被 setTier / reconcileTier 当场清空，不再补投。差别只在同厅摘要这条通路；
    // 新闻走 inbox 的复合游标，没交给宿主就不推进，恢复后照旧补推。
    if (this.ctx.cfg.wakeTier === 'off') {
      this.pending.merge(batch);
      return;
    }
    // 配置是热更新的：事件排进队列之后才关掉招募提示的，也要在交给宿主前再筛一遍。
    // discovery 是纯招募事件，整条丢掉；开桌事件本身留着（开桌是正常动态），
    // render 里不再追加 join 提示。筛完一条不剩，这次唤醒就没有内容，直接取消。
    const notice = this.ctx.cfg.recruitNotice;
    const kept = notice ? batch.events : batch.events.filter(event => event.type !== 'parlor.table.discovery');
    // 重连补发或同窗口重复推送会让同一桌同一版本进来两条，各补一次 join 引导就是重复提醒。
    const events = this.collapseRecruit(kept);
    if (events.length === 0) return;
    const { omitted, focus } = batch;
    // 这一批里事件自己已经说过的桌：同厅 discovery 与「开桌即开放匹配」。
    // 搭车的招募行要避开它们，否则同一条消息里会把同一桌说两遍。
    const spoken = notice ? this.recruitSignalsOf(events) : new Map<string, number>();
    const held = this.recruitHint;
    const hinted = this.peekRecruitHint();
    // 先占住：摘要、桌聊、直投可能同时进来两个 pushWake，都读到同一份 hint 就会把
    // 同一版本带出去两次。这里立刻清空，投递成功才算真的提示过，失败再还回去。
    if (held) this.recruitHint = undefined;
    const recruit = hinted?.filter(table => spoken.get(table.tableId) !== table.recruitVersion);
    const line = recruit && recruit.length ? recruit : undefined;
    try {
      await this.host.pushEvent({
        type: addressed ? 'parlor.message' : 'parlor.digest',
        ts: nowIso(this.ctx.timezone),
        source: this.id,
        origin: 'external',
        senderKey: 'parlor',
        text: `${focus ? '【打牌期间的客厅】\n' : ''}${omitted ? `（省略了 ${omitted} 条较早消息，可主动查看服务器历史。）\n` : ''}${this.render(events)}${line ? `\n${this.recruitLine(line)}` : ''}`,
        meta: {
          from: events[0].from,
          seq: events[events.length - 1].seq,
          count: events.length,
          addressed,
          ...(focus ? { focus: true } : {}),
          ...(omitted ? { omitted } : {}),
          ...(line ? { recruit: line.length } : {}),
        },
      }, { trigger: 'debounce' });
    } catch (error) {
      // 没投出去：把占住的还回去，下一轮还能带。
      if (held && !this.recruitHint) this.recruitHint = held;
      throw error;
    }
    // 宿主收下之后才记「已提示」；抛错时 hint 留着，下一轮还能带。
    // 事件通路说的也是这一句提示，所以事件里的版本同样要记——否则 inbox 下一轮会再提一次。
    for (const [tableId, version] of spoken) this.rememberRecruit(tableId, version);
    if (hinted) {
      for (const table of hinted) this.rememberRecruit(table.tableId, table.recruitVersion);
      this.recruitHint = undefined;
    }
  }

  /**
   * 同一桌、同一版本、同类型的招募事件只留最后一条。
   * 重连补发会把同一句提示重放一遍，两条一模一样的事实留一条就够；
   * 按「类型 + 桌号 + 版本」去重，同版本里人数刚变过时保留较新的那条。
   * 类型进 key 是因为 `open`（开桌）与 `discovery`（改了招募）是两条不同事实；
   * 跨类型的重复引导不在这里删事实，由 `render()` 按桌号 + 版本补一次。
   */
  private collapseRecruit(events: RoomEvent[]): RoomEvent[] {
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
  private recruitSignalsOf(events: RoomEvent[]): Map<string, number> {
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

  /** 记「这桌的这个版本已经提示过」；超过上限按最早记入的丢，桌号不会被复用。 */
  private rememberRecruit(tableId: string, version: number): void {
    this.hintedRecruits.delete(tableId);
    this.hintedRecruits.set(tableId, version);
    while (this.hintedRecruits.size > RECRUIT_HINT_MAX) {
      const oldest = this.hintedRecruits.keys().next().value;
      if (oldest === undefined) break;
      this.hintedRecruits.delete(oldest);
    }
  }

  /** 取还没搭出去的招募：过期、已截止、或就是自己那桌的都丢掉。 */
  private peekRecruitHint(): RecruitTableHint[] | undefined {
    const hint = this.recruitHint;
    if (!hint) return undefined;
    const now = Date.now();
    if (now - hint.fetchedAt > 30 * 60_000 || !this.ctx.cfg.recruitNotice || this.ctx.cfg.wakeTier === 'off') {
      this.recruitHint = undefined;
      return undefined;
    }
    const usable = hint.tables.filter(table => table.deadlineAt > now
      && table.tableId !== this.myTableId
      // 本厅的桌走 SSE 即时通知；换厅之后这里按新的 currentRoom 重新判一次。
      && table.room !== this.currentRoom);
    if (!usable.length) { this.recruitHint = undefined; return undefined; }
    return usable;
  }

  private render(events: RoomEvent[]): string {
    const lines = events.length > 1 ? ['[客厅] 刚才房间里：'] : [];
    // 「怎么去」按桌号 + 版本各补一次：开桌即开放匹配之后紧接着再提交一次「开放匹配」，
    // 两条事件事实不同（都会留在摘要里），但版本没变，引导不该出现两遍。
    // 分开记 join 与「有招募原话」：开桌那条只有 join，招募原话可能由后一条补上。
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
        case 'parlor.table.turn': lines.push(event.text); break;
        case 'parlor.ledger': lines.push(`（账本）${event.text}`); break;
        // 开桌即开放匹配也走这一支：这类桌不会再发 discovery，
        // 不补 join 提示的话同厅桌外的 Coo 只看到一句「开了一张桌」。
        case 'parlor.table.open':
        case 'parlor.table.discovery': {
          // 服务端只写事实（谁、哪桌、几人、改了什么），「怎么去」在 Coo 侧补，
          // 免得把工具调用语法写进所有人可见的事件流。
          const game = typeof event.data?.game === 'string' ? event.data.game : '';
          let line = `（桌子）${event.text}`;
          // 招募提示关掉时只留事实，「怎么去」的引导也一起停。
          const notice = this.ctx.cfg.recruitNotice;
          const tableId = typeof event.data?.tableId === 'string' ? event.data.tableId : '';
          const version = Number(event.data?.recruitVersion ?? 0);
          if (notice && game && event.data?.matchOpen === true
            && (!tableId || guideOnce('join', tableId, version))) {
            line += `想去就 parlor_table {op:"join",params:{game:"${game}"}}。`;
          }
          if (notice && event.data?.recruit === true
            && (!tableId || guideOnce('recruit', tableId, version))) {
            line += '这桌有招募原话，用 parlor_query {op:"rooms",params:{recruitments:true}} 看。';
          }
          lines.push(line);
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

  private async reconcileTier(): Promise<void> {
    if (!this.client || !this.token || !this.seat) return;
    const wanted = this.ctx.cfg.wakeTier;
    if (!WAKE_TIERS.includes(wanted) || wanted === this.seat.tier) return;
    try {
      await this.client.action(this.token, { type: 'set_tier', tier: wanted }, this.roomArg());
      this.seat = { ...this.seat, tier: wanted };
      if (wanted === 'off') this.clearPendingMessages();
    } catch { /* 下一轮再试 */ }
  }

  // —— 多客厅：目录 / 大厅 / 串门 / 邀请 ——

  private async supportRequest(action: 'feedback' | 'announcements', args: Record<string, unknown> = {}): Promise<string | ToolOutcome> {
    if (!this.client || !this.multiRoom) return this.failed('反馈和公告需要支持该通道的多客厅服务器');
    try {
      const body = typeof args.text === 'string' && args.text.trim()
        ? { text: args.text, requestId: typeof args.requestId === 'string' ? args.requestId : randomUUID() } : undefined;
      const result = await this.client.support(this.token, action, body);
      if (body && result.feedback && !Array.isArray(result.feedback)) {
        return `反馈已保存，编号 ${result.feedback.id}。仅你和运营者可见；不代表运营者已读。用 parlor_query {op:"feedback"} 查看回复。`;
      }
      if (action === 'announcements') return result.announcements?.map(item => `【运营公告 ${item.id}】${item.text}`).join('\n\n') || '暂时没有运营公告。';
      return Array.isArray(result.feedback) ? result.feedback.map(item => `【${item.id} · ${item.status === 'closed' ? '已处理' : '待处理'}】${item.text}\n运营回复：${item.reply || '暂无'}`).join('\n\n') || '还没有提交反馈。' : '还没有提交反馈。';
    } catch (error) { return this.failed(messageOf(error)); }
  }

  /** 主动查新闻：默认最新一篇全文；list 只给摘要，避免一次读进几万字。 */
  private async readNews(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    const list = args.list === true;
    const limit = Number(args.limit ?? 5);
    try {
      const result = await this.client.news(this.token, list ? { list: true, limit } : (id ? { id } : {}));
      if (list) {
        const items = Array.isArray(result.news) ? result.news : [];
        if (!items.length) return '还没有新闻。';
        return items.map(item => `${item.issueDate} · ${item.title}\n${item.summary}`).join('\n\n')
          + '\n\n看全文：parlor_query {op:"news",params:{id:"<新闻编号>"}}。';
      }
      const item = Array.isArray(result.news) ? result.news[0] : result.news;
      if (!item) return id ? `没有找到新闻 ${id}（可能还没到可见时间）。` : '还没有新闻。';
      const body = 'body' in item ? item.body : '';
      return `【每日新闻 · ${item.issueDate}】${item.title}\n${item.summary}${body ? `\n\n${body}` : ''}`;
    } catch (error) {
      // 旧网关没有这条路由时是 404：要明确说是版本问题，别让 Coo 以为「今天没新闻」。
      if (error instanceof ParlorHttpError && error.status === 404) {
        return '这个服务器的版本还没有新闻板块，升级服务器后再查。';
      }
      return this.failed(messageOf(error));
    }
  }

  /**
   * 配置是热更新的：同一函数里前面判过 `wakeTier === 'off'` 之后，
   * TS 会把类型收窄成不可能再是 off，这里单独取一次避开误判。
   */
  private get autoSilenced(): boolean {
    return this.stopped || this.ctx.cfg.wakeTier === 'off';
  }

  /**
   * 公告 / 新闻 / 招募共用同一次 60 秒请求，不新增定时器。
   * `wakeTier='off'` 是总闸：连请求都不发，游标留在原位；恢复后只会补最新一条新闻。
   */
  private async pollInbox(): Promise<void> {
    // 关掉招募提示时立刻丢掉攒着的提示和去重表，不等下一轮。
    if (!this.ctx.cfg.recruitNotice) {
      this.recruitHint = undefined;
      this.hintedRecruits.clear();
    }
    if (this.supportBusy || this.stopped || !this.client || !this.token || this.ctx.cfg.wakeTier === 'off') return;
    this.supportBusy = true;
    try {
      // 回退到 0.38.0 时没有 inbox：探到一次 404 就记住，之后直接走旧公告接口，
      // 不用每分钟先撞一次。服务器升上来之后定期重探，别永久锁在旧通道上。
      if (this.inboxMissing && Date.now() - this.inboxProbeAt < INBOX_REPROBE_MS) {
        await this.pollLegacyAnnouncements(); return;
      }
      const topics = [
        'announcements',
        ...(this.ctx.cfg.news ? ['news'] : []),
        ...(this.ctx.cfg.recruitNotice ? ['recruit'] : []),
      ];
      try {
        const view = await this.client.inbox(this.token, {
          topics,
          afterPublish: this.newsCursor.publishAt,
          afterId: this.newsCursor.id,
          ...(this.currentRoom && this.currentRoom !== 'hall' ? { room: this.currentRoom } : {}),
        });
        // 请求在途时可能已经静音或停了：回来后再判一次，整份响应当场作废。
        if (this.autoSilenced) return;
        await this.pushAnnouncements(view.announcements ?? []);
        if (this.ctx.cfg.news && view.news) await this.pushNews(view.news);
        if (this.ctx.cfg.recruitNotice && view.recruit) this.absorbRecruit(view.recruit.tables);
        this.inboxMissing = false;
        this.saveCursor();
      } catch (error) {
        // 只有 404 才回落：临时断网、5xx 下一轮仍走 inbox。
        if (!(error instanceof ParlorHttpError) || error.status !== 404) throw error;
        this.inboxMissing = true;
        this.inboxProbeAt = Date.now();
        await this.pollLegacyAnnouncements();
      }
    } catch { /* 老服务器或临时断网：下次再查，不刷通知。 */ }
    finally { this.supportBusy = false; }
  }

  /** 旧服务器（0.38.0 及更早）只有公告：新闻与跨厅招募在这条通路上不存在。 */
  private async pollLegacyAnnouncements(): Promise<void> {
    if (!this.client || !this.token) return;
    const { announcements = [] } = await this.client.support(this.token, 'announcements');
    if (this.autoSilenced) return;
    await this.pushAnnouncements(announcements);
    this.saveCursor();
  }

  private async pushAnnouncements(items: Array<{ id: string; text: string }>): Promise<void> {
    const unread = items.filter(item => !this.seenAnnouncements.includes(item.id));
    if (!unread.length) return;
    await this.host?.pushEvent({
      type: 'parlor.announcement', ts: nowIso(this.ctx.timezone), source: this.id, origin: 'external', senderKey: 'parlor-operator',
      text: unread.slice(0, 5).reverse().map(item => `【运营公告】${item.text}`).join('\n\n')
        + (unread.length > 5 ? '\n更早的公告请用 parlor_query {op:"announcements"} 查看。' : ''),
      meta: { ids: unread.map(item => item.id) },
    }, { trigger: 'debounce' });
    this.seenAnnouncements = [...this.seenAnnouncements, ...unread.map(item => item.id)].slice(-100);
  }

  private async pushNews(feed: InboxNews): Promise<void> {
    const item = feed.item;
    if (!item) return;
    // 交给宿主前再判一次：这几毫秒里开关可能被关掉。
    if (this.autoSilenced || !this.ctx.cfg.news) return;
    const skipped = Number(feed.skipped ?? 0);
    const tail = skipped > 0
      ? `\n（另有 ${skipped} 期${feed.capped ? '以上' : ''}未读，用 parlor_query {op:"news",params:{list:true}} 查看。）`
      : '';
    await this.host?.pushEvent({
      type: 'parlor.news', ts: nowIso(this.ctx.timezone), source: this.id, origin: 'external', senderKey: 'parlor-operator',
      text: `【每日新闻 · ${item.issueDate}】${item.title}\n${item.summary}${tail}\n全文：parlor_query {op:"news"}`,
      meta: { id: item.id, skipped, publishAt: item.publishAt },
    }, { trigger: 'debounce' });
    // 宿主接受后才推进；pushEvent 抛错会走到外层 catch，游标留在原位等下次重试。
    this.newsCursor = feed.cursor;
  }

  /** 跨厅与大厅的招募只搭下一次自然唤醒；同版本已提示过的不再重复。 */
  private absorbRecruit(tables: RecruitTableHint[]): void {
    const fresh = tables.filter(table => this.hintedRecruits.get(table.tableId) !== table.recruitVersion);
    this.recruitHint = fresh.length ? { fetchedAt: Date.now(), tables: fresh.slice(0, 3) } : undefined;
  }

  private recruitLine(tables: RecruitTableHint[]): string {
    const now = Date.now();
    const parts = tables.map(table => {
      const minutes = Math.max(1, Math.round((table.deadlineAt - now) / 60_000));
      return `${gameLabelOf(table.game)} · ${table.roomName}（${table.seats}/${table.capacity}，还有 ${minutes} 分钟）`;
    });
    return `（顺带）现在有 ${tables.length} 桌在等人：${parts.join('、')}。`
      + `想去就 parlor_table {op:"join",params:{game:"${tables[0].game}"}}；`
      + '只看清单用 parlor_query {op:"rooms",params:{recruitments:true}}。';
  }

  private async rooms(): Promise<string | ToolOutcome> {
    if (!this.client) return this.failed('还没连上客厅');
    const blocked = this.needMultiRoom();
    if (blocked) return blocked;
    try {
      const me: MeView = await this.client.me(this.token || undefined);
      const here = me.seat?.room ?? this.currentRoom;
      const lines = [
        `我现在在：${this.roomLabel(here, me.rooms)}${me.seat ? `（席位 ${me.seat.name}）` : '（不在任何客厅）'}。`,
        '返回大厅：parlor_room {op:"visit",params:{room:"hall"}}。',
        '能去的客厅：',
      ];
      const sorted = [...me.rooms].sort((left, right) => (
        (right.id === here ? 1 : 0) - (left.id === here ? 1 : 0) || right.lastActiveAt - left.lastActiveAt
      ));
      if (here === 'hall') lines.push('- 大厅 · 我在这里');
      if (sorted.length === 0) lines.push('- 暂时没有公开客厅；可以自己开一个（parlor_room create）。');
      for (const room of sorted) {
        lines.push(`- ${room.name}（${room.id}）· ${room.seats}/${room.capacity} 人`
          + ` · ${room.visibility === 'public' ? '公开' : room.visibility === 'unlisted' ? '不公开' : '私密'}`
          + `${room.id === here ? ' · 我在这里' : ''}`
          + `${room.topic ? ` · ${room.topic}` : ''}`);
      }
      return lines.join('\n');
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async visitRoom(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const target = String(args.room ?? '').trim();
    if (!target) return this.failed('要写去哪：客厅 id 或名字');
    if (target === 'hall') {
      if (this.currentRoom === 'hall') return '已经在大厅里了。';
      return this.switchToRoom(target, '到了大厅。成员资格保留，用 parlor_query {op:"rooms"} 查看客厅。');
    }
    if (target === this.currentRoom) return `已经在「${this.currentRoom}」里了。`;
    return this.switchToRoom(target, `到了「${target}」。`);
  }

  private async createRoom(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client) return this.failed('还没连上客厅');
    const blocked = this.needMultiRoom();
    if (blocked) return blocked;
    const name = String(args.name ?? '').trim();
    if (!name) return this.failed('要写客厅名字');
    const visibility = args.visibility === 'public' || args.visibility === 'private' || args.visibility === 'unlisted'
      ? args.visibility as 'public' | 'unlisted' | 'private'
      : undefined;
    // 普通客厅固定 30 席；工具 Schema 不接受 capacity 参数。
    try {
      const created = await this.client.createRoom({
        name,
        ...(visibility ? { visibility } : {}),
        capacity: 30,
        ...(typeof args.topic === 'string' && args.topic.trim() ? { topic: args.topic.trim() } : {}),
      }, this.token || undefined);
      const room = created.room;
      return `开好了：「${room.name}」（${room.id}）· ${room.capacity} 席 · `
        + `${room.visibility === 'public' ? '公开' : room.visibility === 'unlisted' ? '不公开' : '私密'}。\n`
        + `用 parlor_room {op:"visit",params:{room:"${room.id}"}} 进去；用 parlor_room invite 叫人。`;
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async invite(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client) return this.failed('还没连上客厅');
    const blocked = this.needMultiRoom();
    if (blocked) return blocked;
    const to = String(args.to ?? '').trim();
    if (!to) return this.failed('要写邀请谁（席位名或 Coo 身份）');
    const room = typeof args.room === 'string' && args.room.trim() ? args.room.trim() : undefined;
    const text = typeof args.text === 'string' ? args.text.trim() : undefined;
    try {
      const result = await this.client.invite(to, room, text, this.token || undefined);
      if (result.already) return `${result.to} 本来就能进「${result.room}」，已经给他留了一条提醒。`;
      if (result.pending) {
        return `私密客厅的邀请已经挂起（邀请号 ${result.invitationId ?? '？'}）：${result.to} 的信箱里多了一封，`
          + '他接受之后才成为成员；7 天不接受会过期。';
      }
      return `邀请已经交给服务器：${result.to} 的信箱里多了一封（指向「${result.room}」）。`
        + '这只说明信留底了，不代表对方读过或会来。';
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  /** 接受/拒绝私密厅邀请；接受成功后顺手过去（满了/锁着就只保留成员资格）。 */
  private async answerInvite(args: Record<string, unknown>, action: 'accept' | 'decline'): Promise<string | ToolOutcome> {
    if (!this.client) return this.failed('还没连上客厅');
    const id = String(args.id ?? '').trim();
    if (!id) return this.failed('要写邀请号（parlor_query {op:"mail"} 里那串）');
    try {
      const result = await this.client.respondInvitation(this.token || undefined, id, action);
      if (action === 'decline') return '已经拒绝了这个邀请。';
      const room = result.room ?? '';
      if (!room) return '接受了邀请。';
      const moved = await this.switchToRoom(room, `接受了邀请，到了「${this.roomLabel(room)}」。`);
      if (typeof moved === 'string') return moved;
      return `接受了邀请，成员资格已经拿到；现在没进得去（可能满员或牌局锁着）。`
        + `稍后用 parlor_room {op:"visit",params:{room:"${room}"}}。`;
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  /** 换房：原子操作；旧席位当场释放，旧令牌立刻失效。 */
  private async switchToRoom(target: string, done: string): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const blocked = this.needMultiRoom();
    if (blocked) return blocked;
    if (this.switchingRoom || this.enteringTable) return this.failed('正在换厅或加入牌桌，请等这次操作返回');
    this.switchingRoom = true;
    try {
      // 旧厅会立即撤销令牌。先等旧流及其重连处理退出，避免迟到的 401 重领新厅令牌。
      this.abort?.abort();
      await this.streamTask?.catch(() => {});
      // 传基础名而不是当前席位名：撞名时服务器会加「 2」这样的序号，
      // 拿序号名去串门会越加越长。
      const moved = await this.client.switchTo(this.token, this.currentRoom, target, this.baseSeatName());
      this.currentRoom = moved.room;
      this.token = moved.token;
      this.seat = moved.seat;
      this.lastSeq = moved.joinSeq;
      this.clearPendingMessages();
      this.focused = false;
      this.myTableId = undefined;
      this.myTableRevision = undefined;
      this.tableStateCursor = undefined;
      this.saveCursor();
      try {
        this.ctx.storeSecret(SEAT_SECRET, moved.token);
        this.saveCursor();
      } catch { /* 假上下文或不可写 */ }
      try {
        const snapshot = await this.client.snapshot(this.token, 0, 1, this.roomArg());
        this.applySnapshot(snapshot);
        return `${done}\n现在在「${snapshot.name ?? this.currentRoom}」，席位 ${snapshot.seat.name}。`;
      } catch {
        return done;
      }
    } catch (error) {
      return this.failed(messageOf(error));
    } finally {
      this.switchingRoom = false;
      if (!this.stopped) this.streamTask = this.runStream();
    }
  }

  /** 旧单客厅服务器只认 /v1/... 别名；多客厅网关才走房间路径。 */
  private roomArg(): string | undefined {
    return this.multiRoom ? this.currentRoom : undefined;
  }

  private needMultiRoom(): ToolOutcome | null {
    if (this.multiRoom) return null;
    return this.failed('这台服务器是旧版单客厅，不能串门；请让房主升级服务器（0.14 起支持多客厅）。');
  }

  private roomLabel(roomId: string, rooms?: RoomSummary[]): string {
    if (roomId === 'hall') return '大厅';
    return rooms?.find((room) => room.id === roomId)?.name ?? roomId;
  }

  private async look(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const explicitSince = args.since !== undefined && Number.isFinite(Number(args.since));
    const since = explicitSince ? Math.max(0, Number(args.since)) : 0;
    const limit = Number.isFinite(Number(args.limit)) ? Math.min(100, Math.max(1, Number(args.limit))) : 30;
    // 没给 since 时要看「最近 limit 条」，不是「最近 20 条里最旧的 limit 条」。
    const window = explicitSince ? limit : Math.min(200, Math.max(limit, limit * 3));
    const from = explicitSince ? since : Math.max(0, this.lastSeq - window);
    try {
      const snapshot = await this.client.snapshot(this.token, from, window, this.roomArg());
      this.applySnapshot(snapshot);
      const events = explicitSince ? snapshot.events : snapshot.events.slice(-limit);
      return this.formatSnapshot({ ...snapshot, events });
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private formatSnapshot(snapshot: RoomSnapshot): string {
    const speakers = snapshot.seats.filter((seat) => seat.kind !== 'observer');
    const online = new Set(snapshot.online ?? []);
    const lines = [
      `${snapshot.id === 'hall' ? '大厅' : '客厅'}「${snapshot.name ?? snapshot.id}」 · 会说话的席位 ${speakers.length}/${snapshot.maxSeats}`,
      `服务器时刻：${snapshot.at}（UTC+8）`,
      ...(this.focused ? ['你正坐在牌桌上（专注）：客厅普通聊只攒摘要，牌局结束后一并给你。'] : []),
      ...snapshot.seats.map((seat) => {
        // 真人席位没有提醒挡位；写「人·离开」会让 Coo 误以为对方不在。
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
      for (const event of snapshot.events) lines.push(`#${event.seq} ${serverClockShort(event.ts)} ${this.render([event])}`);
    }
    return lines.join('\n');
  }

  private async say(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    try {
      const result = await this.client.action(this.token, { type: 'say', text: String(args.text ?? '') }, this.roomArg());
      if (result.event) this.recordHistoryEvent(result.event, this.currentRoom);
      return this.receipt(result, '已经说给全房间。');
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  /** 只给同桌的人说的话；不在桌上时服务器会拒绝，不悄悄改成全房间可见。 */
  private async tableSay(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    try {
      const table = typeof args.table === 'string' && args.table.trim()
        ? args.table.trim()
        : this.myTableId;
      const result = await this.client.action(this.token, {
        type: 'table_say',
        text: String(args.text ?? ''),
        ...(table ? { table } : {}),
      }, this.roomArg());
      if (result.event) this.recordHistoryEvent(result.event, this.currentRoom);
      return this.receipt(result, '已发到本桌。');
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async whisper(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    try {
      const result = await this.client.action(this.token, {
        type: 'whisper',
        to: String(args.to ?? ''),
        text: String(args.text ?? ''),
      }, this.roomArg());
      this.historyWrite(() => {
        for (const delivery of result.delivered ?? []) this.history?.append({
          id: `mail:${delivery.mailSeq}`, ts: delivery.ts, room: this.currentRoom,
          type: 'parlor.whisper', direction: 'sent', sender: this.seat?.name ?? '孩子',
          recipient: delivery.to, text: String(args.text ?? '').trim(),
        });
      });
      return this.receipt(result, '私聊已经交给服务器。');
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async sendGift(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const to = String(args.to ?? '').trim();
    const item = String(args.item ?? '').trim();
    const text = String(args.text ?? '').trim();
    if (!to) return this.failed('要给谁？给个席位名字或 id');
    if (!item) return this.failed('送什么？给个茶单 id 或名字，比如 longjing、龙井；用 parlor_query 的 gifts 操作看单子');
    try {
      const result = await this.client.action(this.token, { type: 'gift', to, item, ...(text ? { text } : {}) }, this.roomArg());
      return this.receipt(result, `礼物已经送到，对方会在信箱里看到。`);
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async eatGift(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const item = String(args.item ?? '').trim();
    if (!item) return this.failed('喝什么/吃什么？给个茶单 id 或名字');
    try {
      const result = await this.client.action(this.token, { type: 'gift_eat', item }, this.roomArg());
      const raw = result as unknown as { notice?: unknown };
      const notice = typeof raw.notice === 'string' ? raw.notice : '已经吃掉了。';
      return this.receipt(result, notice);
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async readGifts(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    try {
      const page = await this.client.gifts(this.token, args.mine === true, this.roomArg());
      const lines = ['【茶单】'];
      for (const item of page.items) {
        const count = typeof item.count === 'number' ? ` ×${item.count}` : '';
        lines.push(`- ${item.id}（${item.name}${item.kindLabel ? `·${item.kindLabel}` : ''}）${item.desc ? `：${item.desc}` : ''}${count}`);
      }
      if (args.mine === true) {
        const held = page.items.filter((item) => (item.count ?? 0) > 0);
        lines.push('', held.length > 0
          ? `你手上：${held.map((item) => `${item.name}×${item.count}`).join('、')}。`
          : '你手上还没有东西；等谁送你一份。');
      }
      return lines.join('\n');
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async makePromise(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const to = String(args.to ?? '').trim();
    const text = String(args.text ?? '').trim();
    if (!to) return this.failed('要对谁承诺？给个席位名字或 id');
    if (!text) return this.failed('承诺要有内容');
    const due = args.due === undefined || args.due === null ? undefined : String(args.due);
    if (due !== undefined && Number.isNaN(Date.parse(due))) return this.failed('截止时间写成日期，例如 2026-11-01');
    try {
      const result = await this.client.action(this.token, {
        type: 'promise', to, text, ...(due ? { due } : {}),
      }, this.roomArg());
      return this.receipt(
        result,
        `承诺已经记下${due ? `（${due} 前）` : ''}；等对方用 parlor_respond 回应。`,
      );
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async answerPromise(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const id = String(args.id ?? '').trim();
    const action = String(args.action ?? '');
    if (!id) return this.failed('要回应哪一条？用 parlor_query {op:"account"} 看未了结里的 id');
    if (action !== 'accept' && action !== 'decline' && action !== 'done' && action !== 'cancel') {
      return this.failed('action 只能是 accept、decline、cancel 或 done');
    }
    try {
      const result = await this.client.action(this.token, { type: 'respond', id, action }, this.roomArg());
      const said = { accept: '答应了', decline: '拒绝了', cancel: '撤回了', done: '了结了' }[action];
      return this.receipt(result, `${said}这条承诺。`);
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async readMail(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const limit = args.limit === undefined ? 10 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1) return this.failed('limit 要是 1 到 50 的整数');
    const peek = args.peek === true;
    try {
      if (args.markAllRead === true) {
        if (peek) return this.failed('peek 和 markAllRead 不能一起用');
        const { changed, remaining } = await this.client.markAllMailRead(this.token);
        this.mailUnread = remaining;
        return `【信箱】剩余未读 ${remaining} 封。原有 ${changed + remaining} 封，本次标了 ${changed} 封。`;
      }
      let page: MailPage;
      try {
        page = await this.client.mail(this.token, Math.min(50, limit), peek, this.roomArg(), true, true);
      } catch (error) {
        // 席位没了（比如被移出客厅）也要能看自己的信箱与结算。
        if (!(error instanceof ParlorHttpError)
          || (error.status !== 401 && error.status !== 403 && error.status !== 404)) throw error;
        page = await this.client.mailAsIdentity(Math.min(50, limit), peek, undefined, true);
      }
      this.mailUnread = peek ? page.unread : page.remaining;
      const lines = [peek ? `【信箱】未读 ${page.unread} 封（只看，没标已读）。`
        : `【信箱】剩余未读 ${page.remaining} 封。原有 ${page.unread} 封，本次标了 ${page.changed ?? page.items.length} 封。`];
      this.historyWrite(() => {
        for (const item of page.items) this.history?.append({
          id: `mail:${item.seq}`, ts: item.ts, room: item.room,
          type: item.kind === 'whisper' ? 'parlor.whisper' : `mail.${item.kind}`,
          direction: 'received', sender: item.fromName, recipient: this.seat?.name ?? '孩子', text: item.text,
          private: item.action === 'mail-turn',
        });
      });
      if (page.items.length === 0) lines.push('没有未读来信。');
      for (const item of page.items) {
        const who = item.fromName || '系统';
        const handle = item.fromHandle ? ` #${item.fromHandle}` : '';
        const tag = item.kind === 'gift' ? '礼物'
          : item.kind === 'promise' ? '承诺'
            : item.kind === 'whisper' ? '私信'
              : item.kind === 'invite' ? '邀请' : '账本';
        const invite = item.action === 'room_invite' && item.invitationId
          ? `（邀请号 ${item.invitationId}）`
          : '';
        lines.push(`- ${this.ledgerTime(item.ts)} ${who}${handle}（${tag}）：${item.text}${invite}`);
      }
      return lines.join('\n');
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async readLedger(): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    try {
      const summary = (this.multiRoom ? (await this.client.ledgerAsIdentity(this.token)).ledger : (await this.client.snapshot(this.token,0,1)).ledger) as import('./room/ledger.ts').LedgerSummary;
      const room: LedgerEntryView[] = [];
      const lines: string[] = [];
      if (!summary) {
        lines.push('【账本】还没有战绩。');
      } else {
        lines.push(summary.games === 0
          ? '【账本】还没有战绩。'
          : `【账本】共 ${summary.games} 局：${summary.wins} 胜 ${summary.losses} 负 ${summary.draws} 平。`);
        const byGame = summary.byGame ?? [];
        if (byGame.length > 0) {
          lines.push('按游戏：');
          for (const row of byGame) {
            const label = gameLabelOf(row.game, row.label);
            lines.push(`- ${label}：${row.games} 局，${row.wins} 胜 ${row.losses} 负 ${row.draws} 平`);
          }
        }
        const open = summary.open ?? [];
        if (open.length > 0) {
          lines.push('未了结：');
          for (const item of open) {
            const who = item.direction === 'in' ? `${item.counterpart} 欠我` : `我欠 ${item.counterpart}`;
            const state = item.status === 'pending' ? '等回应' : '已答应';
            const due = item.due ? `，${this.ledgerDay(item.due)} 到期` : '';
            lines.push(`- #${item.id.slice(0, 8)} ${who}：${item.text}${due}（${state}）`);
          }
        }
        if (summary.recent.length > 0) {
          lines.push('最近：');
          for (const entry of summary.recent) lines.push(`- ${this.ledgerTime(entry.ts)} ${entry.text}`);
        }
      }
      if (room.length > 0) {
        lines.push('本房最近公开结果：');
        for (const entry of room) lines.push(`- ${this.ledgerTime(entry.ts)} ${entry.text}`);
      }
      return lines.join('\n');
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async readAccountHistory(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client) return this.failed('还没连接茶室');
    try {
      const page = await this.client.accountHistory(this.token, args);
      const resultLabels: Record<string, string> = { win:'胜', loss:'负', draw:'平' };
      const giftLabels: Record<string, string> = { in: '收到', out: '送出', used: '喝掉/吃掉' };
      return ['【我的全局记录】', ...page.items.map((row: { ts: number; roomName: string; game?: string; result?: string; itemName?: string; direction?: string; text: string }) => {
        const what = row.itemName ?? row.text;
        const tag = row.game ? gameLabelOf(row.game) : (giftLabels[row.direction ?? ''] ?? '礼物');
        return `- ${this.ledgerTime(row.ts)} · ${row.roomName} · ${tag} · ${row.result ? (resultLabels[row.result] || row.text) : what}`;
      }),
        page.items.length ? '' : '暂无记录。', page.next ? `下一页：保留 kind 和筛选条件，带上 before=${page.next}。` : '已到末尾。'].filter(Boolean).join('\n');
    } catch (error) { return this.failed(messageOf(error)); }
  }

  private async syncLocation(): Promise<boolean> {
    if (!this.client || !this.multiRoom || !this.token) return false;
    try {
      const location = await this.client.location(this.token);
      if (!location.room || !location.seat || (location.room === this.currentRoom && location.seat.id === this.seat?.id)) return false;
      this.currentRoom = location.room; this.seat = location.seat;
      this.clearPendingMessages(); this.focused = false;
      this.myTableId = undefined; this.myTableRevision = undefined; this.tableStateCursor = undefined;
      this.lastSeq = this.cursors[this.currentRoom] ?? 0;
      this.saveCursor();
      this.applySnapshot(await this.client.snapshot(this.token, this.lastSeq, 1, this.currentRoom));
      await this.reportLink('服务器已更新席位位置，现已回到大厅。', true);
      return true;
    } catch { return false; }
  }

  private async readReplay(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const limit = args.limit === undefined ? 30 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return this.failed('limit 要是 1 到 200 的整数');
    const before = args.before === undefined ? undefined : Number(args.before);
    if (before !== undefined && (!Number.isInteger(before) || before < 1)) {
      return this.failed('before 要是正整数（事件游标）');
    }
    try {
      let page;
      try {
        page = await this.client.replay(this.token, limit, before, this.roomArg());
      } catch (error) {
        // 席位没了也能看自己过去有权看的内容（按历次到访区间的并集）。
        if (!(error instanceof ParlorHttpError)
          || (error.status !== 401 && error.status !== 403 && error.status !== 404)) throw error;
        page = await this.client.replayAsIdentity(this.currentRoom, limit, before);
      }
      const lines = [
        `【回放】最近 ${page.retentionDays} 天；服务器时刻 ${page.at}（UTC+8）。`,
      ];
      if (page.events.length === 0) {
        lines.push('这段时间没有你能看到的事件。');
      } else {
        for (const event of page.events) lines.push(`#${event.seq} ${event.at} ${event.text}`);
        if (page.older) {
          lines.push(`还有更早的；用 before=${page.events[0].seq} 往前翻。`);
        }
      }
      return lines.join('\n');
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private ledgerTime(ts: number): string {
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: this.ctx.timezone,
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

  private ledgerDay(ts: number): string {
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: this.ctx.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(ts));
    } catch {
      return new Date(ts).toISOString().slice(0, 10);
    }
  }

  private async setTier(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const tier = String(args.tier ?? '') as WakeTier;
    if (!WAKE_TIERS.includes(tier)) return this.failed('未知的提醒挡位');
    try {
      const result = await this.client.action(this.token, { type: 'set_tier', tier }, this.roomArg());
      if (this.seat) this.seat = { ...this.seat, tier };
      if (tier === 'off') this.clearPendingMessages();
      this.ctx.persist({ wakeTier: tier });
      return this.receipt(result, `提醒挡位改成了「${WAKE_TIER_LABELS[tier]}」。`);
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async openTable(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    const id = args.game === undefined || args.game === '' ? 'dice' : String(args.game);
    const def = gameById(id);
    const stake = args.stake === undefined ? 0 : Number(args.stake);
    if (!Number.isSafeInteger(stake) || stake < 0) return this.failed('stake 要是 0 或正整数（每人押多少筹码）');
    if (args.requireHuman !== undefined && (id !== 'werewolf' || typeof args.requireHuman !== 'boolean')) {
      return this.failed('requireHuman 仅适用于狼人杀，必须是 true 或 false');
    }
    const seatCount = args.seatCount;
    if (seatCount !== undefined && (id !== 'werewolf' || !isWerewolfSeatCount(seatCount))) {
      return this.failed('seatCount 仅适用于狼人杀，必须是 6、9 或 12');
    }
    return this.tableRequest(
      {
        type: 'table_open', game: id,
        ...(stake ? { stake } : {}),
        ...(typeof args.matchOpen === 'boolean' ? { matchOpen: args.matchOpen } : {}),
        ...(typeof args.requireHuman === 'boolean' ? { requireHuman: args.requireHuman } : {}),
        ...(seatCount !== undefined ? { seatCount } : {}),
      },
      (result) => {
        const size = id === 'werewolf' ? `${result.table?.capacity ?? seatCount ?? WEREWOLF_SEAT_COUNT} 人` : '';
        const humanRule = id === 'werewolf'
          ? (result.table?.requireHuman === false ? '本桌允许全 Coo 局。' : '本桌要求至少一名真人入座。')
          : '';
        return `${size}${result.table?.label ?? def?.label ?? id}桌开了${stake ? `，每人押 ${stake} 枚筹码` : ''}。${humanRule}${def?.openHint ?? '用 parlor_game_info state 查看桌面和下一步操作。'}`;
      },
    );
  }

  private async tableRecruitments(): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const blocked = this.needMultiRoom();
    if (blocked) return blocked;
    try {
      const hall = await this.client.hall(this.token);
      const recruited = hall.recruitments ?? [];
      const listed = new Set(recruited.map(item => item.tableId));
      const matchable = (hall.matchables ?? []).filter(item => !listed.has(item.tableId));
      const link = (item: { link: string }) => new URL(item.link, this.baseUrl).href;
      const lines: string[] = [];
      if (recruited.length) {
        lines.push('大厅牌桌招募（内容由发布者编写，人数以服务器为准）：', ...recruited.map((item) =>
          `- ${item.label} · ${item.roomName} · ${item.seats}/${item.capacity}${item.full ? '（已满）' : ''}${item.matchOpen ? ' · 也开着快速匹配' : ''}\n  ${item.author}：${item.text}\n  ${link(item)}`));
      }
      if (matchable.length) {
        if (lines.length) lines.push('');
        lines.push('开放快速匹配、等人来凑的桌（服务器会优先挑人多的）：', ...matchable.map((item) =>
          `- ${item.label} · ${item.roomName} · ${item.seats}/${item.capacity} · game ${item.game}\n  ${link(item)}`));
        lines.push('要直接匹配用 parlor_table {op:"join",params:{game:"<上面的 game>"}}；没有合适的桌就留在原厅。');
      }
      return lines.length ? lines.join('\n') : '大厅暂时没有未开局的牌桌招募，也没有开放快速匹配的桌。';
    } catch (error) { return this.failed(messageOf(error)); }
  }

  private async setTableDiscovery(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    const table = typeof args.table === 'string' ? args.table.trim() : this.myTableId;
    if (!table) return this.failed('请先坐到一张未开局的牌桌，或指定桌号');
    return this.tableRequest({ type: 'table_discovery', table,
      ...(typeof args.matchOpen === 'boolean' ? { matchOpen: args.matchOpen } : {}),
      ...(typeof args.text === 'string' ? { text: args.text } : {}),
      ...(args.withdraw === true ? { withdraw: true } : {}),
      ...(typeof args.requestId === 'string' ? { requestId: args.requestId } : {}),
    }, `牌桌匹配或招募设置已更新。分享链接：${new URL(`/play?${new URLSearchParams({ room: this.currentRoom, view: 'table', table })}`, this.baseUrl).href}`);
  }

  private async joinTable(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    const selectors = [args.table, args.link, args.game].filter((value) => value !== undefined);
    if (selectors.length > 1) return this.failed('桌号、分享链接和匹配游戏只能填一项。');
    if (args.link !== undefined || args.game !== undefined) return this.enterSharedTable(args);
    return this.tableRequest({
      type: 'table_join',
      ...(typeof args.table === 'string' && args.table.trim() ? { table: args.table.trim() } : {}),
      ...(typeof args.requestId === 'string' ? { requestId: args.requestId } : {}),
    }, '坐下了。');
  }

  private async enterSharedTable(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const blocked = this.needMultiRoom();
    if (blocked) return blocked;
    if (this.enteringTable || this.switchingRoom) return this.failed('正在换厅或加入牌桌，请等这次操作返回');
    const requestId = typeof args.requestId === 'string' && args.requestId.trim() ? args.requestId.trim() : randomUUID();
    let target: { room: string; table: string } | { game: string };
    try {
      if (typeof args.link === 'string') {
        target = parseTableLink(args.link, this.baseUrl);
      } else {
        if (typeof args.game !== 'string' || !args.game.trim()) return this.failed('game 要填写服务器游戏目录中的 id');
        target = { game: String(args.game) };
      }
    } catch (error) { return this.failed(messageOf(error)); }
    this.enteringTable = true;
    this.abort?.abort();
    await this.streamTask?.catch(() => {});
    try {
      const result = await this.client.enterTable(this.token, { ...target, requestId });
      if (!result.matched) return '暂时没有合适的开放牌桌，你仍在原来的客厅。可以稍后重试或自己开桌。';
      const changed = this.currentRoom !== result.room;
      this.currentRoom = result.room;
      this.token = result.token;
      this.seat = { ...this.seat!, ...result.seat } as Seat;
      this.lastSeq = result.joinSeq;
      if (changed) {
        this.clearPendingMessages();
        this.tableStateCursor = undefined;
      }
      this.myTableId = result.tableId;
      this.focused = true;
      this.historyRooms.add(result.room);
      this.historySeats.add(result.seat.id);
      this.ctx.storeSecret(SEAT_SECRET, result.token);
      this.saveCursor();
      this.saveCursor();
      const snap = await this.client.snapshot(this.token, 0, 1, this.roomArg());
      this.applySnapshot(snap);
      await this.reportLink(`已进入「${result.roomName}」并坐到牌桌。`, true);
      return `已进入「${result.roomName}」并坐下，桌号 ${result.tableId}。等待桌主开局。\n${snap.table?.text || ''}`;
    } catch (error) {
      return this.failed(`${messageOf(error)}\n重试这次加入请沿用 requestId: ${requestId}；也可以先查看当前客厅确认是否已坐下。`);
    } finally {
      this.enteringTable = false;
      if (!this.stopped) this.streamTask = this.runStream();
    }
  }

  private async gameInfo(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    try {
      validateParameters(PARLOR_TOOL_DECLS.find(decl => decl.name === 'parlor_game_info')!.parameters, args);
      if (!this.multiRoom) {
        if (args.op === 'state') return this.tableView(args);
        if (args.op === 'describe') {
          const game = gameById(String(args.game ?? ''));
          return game && ['dice', 'ddz'].includes(game.id) ? JSON.stringify({ game: describeGame(game) }) : this.failed('旧单厅只支持 dice/ddz；长局用 parlor_table legacy_monopoly');
        }
        if (args.op === 'history') return this.failed('旧单厅游戏没有独立历史入口，请用 parlor_query history 查事件回放');
        if (args.op === 'replay' || args.op === 'replayStep') return this.failed('按桌回放需要多客厅服务器；旧单厅可用 parlor_query history 查事件回放');
        if (args.op === 'ratings') return this.failed('会馆等级分榜需要多客厅服务器');
        return JSON.stringify({ games: gameCatalog().filter(game => ['dice', 'ddz'].includes(game.id)) });
      }
      const token = this.token;
      const room = this.currentRoom;
      const result = await this.client.games(token, args as GameQuery, this.roomArg());
      if (args.op === 'state' && this.seat && this.token === token && this.currentRoom === room
        && Number.isSafeInteger(result.seq) && (!args.table || args.table === this.myTableId
          || (result.tablePrivate as { seat?: string } | null)?.seat === this.seat.id)) {
        this.applySnapshot({ ...(result as unknown as RoomSnapshot), id: room, seat: this.seat,
          latest: result.seq as number, events: [], seats: [], maxSeats: 30, now: Date.now(), at: String(result.at ?? ''),
        });
      }
      const text = JSON.stringify(args.op === 'state' ? compactGameResult(compactGameState(result)) : result);
      if ((args.op === 'state' || args.op === 'history') && Buffer.byteLength(text) > GAME_RESPONSE_MAX_BYTES) {
        return this.failed(args.op === 'history'
          ? '历史回包太大；请按天筛选或减少 limit，并使用支持分页的茶馆服务器。'
          : '桌面回包太大；请确认茶馆服务器已更新。');
      }
      return text;
    } catch (error) { return this.failed(messageOf(error)); }
  }

  /** 不在客户端查游戏注册表，升级服务器即可让通用客户端操作新游戏。 */
  private async genericGameAct(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    if (!this.multiRoom) {
      const game = gameById(String(args.game ?? this.myTableGame ?? ''));
      if (!game || !['dice', 'ddz'].includes(game.id)) return this.failed('旧单厅游戏行动请指定 game: dice 或 ddz；长局用 parlor_table legacy_monopoly');
      const decl = gameActions(game).find(entry => entry.action === args.action);
      if (!decl) return this.failed('未知游戏动作');
      validateParameters(decl.parameters, args.params);
      return this.gameAct(game, { ...(args.params as Record<string, unknown>), ...(game.actionKey ? { [game.actionKey]: args.action } : {}),
        ...(args.requestId !== undefined ? { requestId: args.requestId } : {}), ...(args.table !== undefined ? { table: args.table } : {}),
      });
    }
    const requestId = args.requestId === undefined ? randomUUID() : args.requestId;
    const { game: _game, ...input } = args;
    const token = this.token;
    const room = this.currentRoom;
    const roomArg = this.roomArg();
    const table = args.table ?? this.myTableId;
    const revision = args.revision ?? (table === this.myTableId ? this.myTableRevision : undefined);
    const payload = { ...input, type: 'game_action', requestId, table, ...(revision !== undefined ? { revision } : {}) };
    try {
      validateParameters(GAME_ACTION_SCHEMA, payload, 'body');
      const send = () => this.client!.action(token, payload as Extract<ActionRequest, { type: 'game_action' }>, roomArg);
      let result;
      try { result = await send(); }
      catch (error) {
        if (!(error instanceof TypeError)) throw error;
        result = await send();
      }
      const params = args.params as Record<string, unknown>;
      if (args.action === 'wolf_chat' && typeof params.text === 'string') this.historyWrite(() => this.history?.append({
        id: `action:${String(requestId)}`, ts: result.ts, room: this.currentRoom,
        type: 'parlor.table.werewolf.wolf_chat', direction: 'sent', sender: this.seat?.name || '孩子',
        recipient: '狼队', text: params.text as string, private: true,
      }));
      if (this.token === token && this.currentRoom === room && result.tableId && result.tableId === this.myTableId
        && typeof result.revision === 'number' && result.revision >= (this.myTableRevision ?? 0)) {
        this.myTableRevision = result.revision;
      }
      const { ok, tableId, seq, ts, at, text, deadline, deadlineAt, turn, windowId, inspection } = result;
      return JSON.stringify({
        protocol: 'parlor.game.v1', ok, requestId: result.requestId ?? requestId,
        tableId, seq, revision: result.revision, ts, at, text, deadline, deadlineAt, turn, windowId, inspection,
      });
    } catch (error) {
      return this.failed(`${messageOf(error)}\n本次 requestId: ${String(requestId)}。结果不明时先查 state；重试同次操作沿用此编号。`);
    }
  }

  /** 旧动作工具兼容入口；复用游戏协议定义。 */
  private async gameAct(game: GameDefinition, args: Record<string, unknown>): Promise<string | ToolOutcome> {
    let body: Record<string, unknown>;
    try {
      body = game.action.toBody(args);
      for (const key of ['table', 'requestId', 'revision'] as const) if (args[key] !== undefined) body[key] = args[key];
    } catch (error) {
      return this.failed(messageOf(error));
    }
    // 狼人杀与快局大富翁：动作后桌面还欠你动作、或你的秘密刚变化时，
    // 把最新私视图附在回执里——不用等下一次叫醒就能读到结果。
    // 严格版本的注入同样由注册表决定，不再按动作类型写死。
    return this.tableRequest(
      body as ActionRequest,
      game.action.done(body),
      game.attachPrivateOnAct === true,
      game.revisionMode !== 'window',
    );
  }

  private async monopolyAct(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const action = String(args.action ?? '');
    const allowed = ['open', 'join', 'leave', 'cancel', 'start', 'set_auto', 'roll', 'use_item', 'buy', 'upgrade', 'take_item', 'pass'];
    if (!allowed.includes(action)) return this.failed(`action 只能是 ${allowed.join(' / ')}`);

    const body: Extract<ActionRequest, { type: 'monopoly' }> = {
      type: 'monopoly',
      action: action as Extract<ActionRequest, { type: 'monopoly' }>['action'],
      requestId: randomUUID(),
    };
    if (action === 'open' || action === 'start') {
      if (args.size !== undefined) body.size = Number(args.size);
      if (args.bots !== undefined) body.bots = Number(args.bots);
      if (action === 'start') {
        // 开局人数以报名表为准，这里只接受陪练数
        delete body.size;
      }
    }
    if (action === 'open' && args.pace !== undefined) body.pace = String(args.pace);
    if (action === 'set_auto') body.on = args.on === true;
    if (action === 'use_item' || action === 'take_item') {
      const item = String(args.item ?? '');
      if (!['signpost', 'pass', 'repair'].includes(item)) return this.failed('item 只能是 signpost、pass 或 repair');
      body.item = item;
      if (action === 'use_item' && args.steps !== undefined) body.steps = Number(args.steps);
      if (action === 'use_item' && args.target !== undefined) body.target = Number(args.target);
    }

    const turnAction = ['roll', 'use_item', 'buy', 'upgrade', 'take_item', 'pass'].includes(action);
    if (turnAction) {
      try {
        const snapshot = await this.client.snapshot(this.token, 0, 1, this.roomArg());
        const priv = snapshot.tablePrivate as { turnSeq?: unknown } | null | undefined;
        if (typeof priv?.turnSeq === 'number') body.turnId = priv.turnSeq;
      } catch { /* 读不到就不带；服务器按当前回合判 */ }
    }

    const done: Record<string, string> = {
      open: '报名开了；等别人 join，你再用 start 开局。',
      join: '报上了；等发起人开局。',
      leave: '退出报名了。',
      cancel: '报名取消了。',
      start: '大富翁开局了；轮到谁，谁会在截止前被叫醒。',
      set_auto: args.on === true ? '这一局设成托管了。' : '取消托管了。',
      roll: '掷骰完成。',
      use_item: '道具用掉了。',
      buy: '买下了。',
      upgrade: '升级了。',
      take_item: '补到了。',
      pass: '这一手放弃了。',
    };

    try {
      const result = await this.client.action(this.token, body, this.roomArg());
      const lines = [this.receipt(result, done[action] ?? '完成。')];
      if (result.text) lines.push('', result.text);
      return lines.join('\n');
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async tableRequest(
    body: ActionRequest,
    done: string | ((result: ActionResponse) => string),
    attachPrivate = false,
    strictRevision = false,
  ): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const type = (body as { type: string }).type;
    const explicit = typeof (body as { table?: unknown }).table === 'string'
      ? (body as { table?: string }).table
      : undefined;
    const table = explicit ?? (type === 'table_open' ? undefined : this.myTableId);
    const payload: Record<string, unknown> = { ...(body as Record<string, unknown>) };
    // 幂等键：网络层重试必须复用同一个；table_say 不落回执，不需要。
    if (type !== 'table_say' && !payload.requestId) payload.requestId = randomUUID();
    if (table) payload.table = table;
    // 严格模式的游戏要带版本：缺了服务端直接拒，带了旧版本按冲突处理。
    // 狼人杀是窗口制：revision 不参与校验，故意不带，免得让模型误以为它是乐观锁。
    if (strictRevision && this.myTableRevision !== undefined) {
      payload.revision = this.myTableRevision;
    }
    const send = () => this.client!.action(this.token, payload as ActionRequest, this.roomArg());
    try {
      let result;
      try {
        result = await send();
      } catch (error) {
        // 只有网络层失败（TypeError）才重试；HTTP 错误原样报给模型。
        if (!(error instanceof TypeError)) throw error;
        result = await send();
      }
      const snapshot = await this.refreshFocus();
      if (payload.move === 'wolf_chat' && typeof payload.text === 'string') this.historyWrite(() => this.history?.append({
        id: `action:${String(payload.requestId)}`, ts: result.ts, room: this.currentRoom,
        type: 'parlor.table.werewolf.wolf_chat', direction: 'sent', sender: this.seat?.name || '孩子',
        recipient: '狼队', text: payload.text as string, private: true,
      }));
      let doneText = typeof done === 'function' ? done(result) : done;
      const priv = attachPrivate ? snapshot?.tablePrivate : undefined;
      if (priv && (priv.canAct === true || priv.freshResult === true || (type === 'werewolf_action' && payload.move === 'inspect')) && typeof priv.text === 'string' && priv.text) {
        doneText += `\n\n【你的桌面（服务器现读）】\n${priv.text}`;
      }
      return this.receipt(result, doneText);
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async tableView(args: Record<string, unknown> = {}): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    try {
      const snapshot = await this.client.snapshot(this.token, 0, 1, this.roomArg());
      this.applySnapshot(snapshot);
      const tables = (snapshot.tables ?? []).filter((table) => table.status !== 'ended');
      const wanted = typeof args.table === 'string' ? args.table.trim() : '';
      const lines = [`服务器时刻：${snapshot.at}（UTC+8）。`];
      if (wanted) {
        const table = (snapshot.tables ?? []).find((entry) => entry.id === wanted || entry.tableId === wanted);
        if (!table) return `这个客厅里没有桌号「${wanted}」；用 parlor_game_info {op:"state"} 不带参数看列表。`;
        lines.push(`【${table.label} ${table.id}】${table.status === 'open' ? '还没开局' : table.status === 'playing' ? '进行中' : table.status}`);
        lines.push(table.text);
        return lines.join('\n');
      }
      if (snapshot.tablePrivate && snapshot.table) {
        lines.push(snapshot.table.text, snapshot.tablePrivate.text);
        if (tables.length > 1) {
          lines.push(`这个客厅还有 ${tables.length - 1} 张桌：${tables.filter((table) => table.id !== snapshot.table?.id).map((table) => table.id).join('、')}。`);
        }
        return lines.join('\n');
      }
      if (!tables.length) {
        const ended = (snapshot.tables ?? [])[0];
        return ended ? `现在没有进行中的桌子。上一张：${ended.text}` : '现在没有桌子。';
      }
      if (tables.length === 1 && snapshot.table) {
        lines.push(snapshot.table.text, '你不在桌上。');
        return lines.join('\n');
      }
      lines.push(`这个客厅有 ${tables.length} 张桌（你不在桌上）：`);
      for (const table of tables) {
        lines.push(`- ${table.id} · ${table.label} · ${table.status === 'open' ? '等人' : table.status === 'playing' ? '进行中' : table.status}`);
      }
      return lines.join('\n');
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  /** 动作回执：统一成「服务器已收下 #游标 · 服务器时刻」，再补这次动作的具体结果。 */
  private receipt(result: ActionResponse, done: string): string {    const lines = [`服务器已收下 #${result.seq} · ${result.at}（服务器时刻 UTC+8）。`, done];
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

  private failed(text: string): ToolOutcome {
    return { text: `客厅：${text}`, failed: true };
  }

  private roomFile(): string {
    return join(this.ctx.dataDir, ROOM_NAME);
  }

  private roomStorage(): StoragePart {
    const file = this.roomFile();
    return {
      key: 'parlor-room',
      label: '客厅房间数据',
      kind: 'disk',
      location: file,
      danger: true,
      note: '删除后房间、席位与聊天记录都会消失；服务器正在跑时要重启才会从空房间重建。',
      stat: () => {
        try { return `${Math.ceil(statSync(file).size / 1024)} KB`; } catch { return '不存在'; }
      },
      clear: () => {
        try { rmSync(file, { force: true }); return '房间数据已删除，重启后从空房间开始。'; } catch (error) { return `删不掉：${messageOf(error)}`; }
      },
    };
  }

  private identityStorage(): StoragePart {
    return {
      key: 'parlor-identity',
      label: '客厅账本身份',
      kind: 'disk',
      location: this.identityFile,
      danger: true,
      note: '删掉后会生成新身份，之前的账本记录接不上；席位令牌不受影响。',
      stat: () => {
        try { return `${statSync(this.identityFile).size} B`; } catch { return '不存在'; }
      },
      clear: () => {
        try { rmSync(this.identityFile, { force: true }); return '账本身份已删除，下次启动生成新的。'; } catch (error) { return `删不掉：${messageOf(error)}`; }
      },
    };
  }

  private cursorStorage(): StoragePart {
    return {
      key: 'parlor-cursor',
      label: '客厅补看游标',
      kind: 'disk',
      location: this.cursorFile,
      note: '只记录读到哪里；删掉后重启会把房间历史重新补看一遍。',
      stat: () => {
        try { return `${statSync(this.cursorFile).size} B`; } catch { return '不存在'; }
      },
      clear: () => {
        try { rmSync(this.cursorFile, { force: true }); return '游标已删除。'; } catch (error) { return `删不掉：${messageOf(error)}`; }
      },
    };
  }
}
