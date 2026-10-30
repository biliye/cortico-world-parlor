/**
 * 客厅 World：连上房间，把可见事件按提醒挡位交给 Core，提供说话/私聊/查看工具。
 * 它不判断谁能看见什么；服务器只发这个席位能看见的事件。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoragePart, ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { WorldContext } from 'cortico/world.ts';
import { PARLOR_CONFIG_GROUP, type ParlorConfigSection } from './config.ts';
import { ParlorClient, ParlorHttpError } from './room/client.ts';
import { serverClock, serverClockShort } from './room/clock.ts';
import { gameLabelOf } from './room/game-labels.ts';
import { IDENTITY_FILE, loadOrCreateIdentity, type CooIdentity } from './room/identity.ts';
import type { MailPage } from './room/mail.ts';
import { ParlorServer } from './room/server.ts';
import {
  WAKE_TIERS, WAKE_TIER_LABELS, decideWake, isAddressed,
  type ActionRequest, type ActionResponse, type HallView, type MeView, type RoomEvent, type RoomSnapshot,
  type RoomSummary, type Seat, type WakeTier,
} from './room/protocol.ts';
import { GAME_LIST, gameById, gameIds, type GameDefinition } from './room/games/registry.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const INVITE_SECRET = 'PARLOR_INVITE_CODE';
const SEAT_SECRET = 'PARLOR_SEAT_TOKEN';
const OWNER_SECRET = 'PARLOR_OWNER_TOKEN';
/** 当前客厅；换房后写回，重启时用它找回席位。 */
const CURRENT_ROOM_SECRET = 'PARLOR_CURRENT_ROOM';
const CURSOR_NAME = 'parlor-cursor.json';
const ROOM_NAME = 'parlor-room.json';

const DIGEST_MS = 60_000;
const LINK_GAP_MS = 60_000;
const PENDING_MAX = 50;
const WAKE_WINDOW_MS = 3_600_000;

/** 每小时最多叫醒几次；被 @ / 私聊不受这个限制。 */
const TIER_BUDGET: Readonly<Record<WakeTier, number>> = {
  full: 60,
  digest: 30,
  quiet: 6,
  off: 0,
};

const KIND_LABELS: Readonly<Record<string, string>> = { pet: 'Coo', human: '人', observer: '观看' };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** 注册表里的每张桌子各出一个动作工具；顺序与 GAME_LIST 一致。 */
const GAME_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = GAME_LIST.map((game) => ({
  name: game.tool.name,
  description: game.tool.description,
  tags: ['write'],
  parameters: game.tool.parameters,
}));

/** 全部工具的声明；定义里的 describe 与 `tools()` 都取它。 */
export const PARLOR_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'parlor_look',
    description: 'Look at the parlor: who is seated here and what you can see since a cursor. Does not wake anyone and does not mark messages as read.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        since: { type: 'integer', minimum: 0, description: 'Start after this event cursor. Omit to read the recent tail.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many events to read, default 30.' },
      },
    },
  },
  {
    name: 'parlor_say',
    description: 'Say something to the whole parlor. Everyone seated can see it; use @名字 to address someone. Keep it short.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'What to say, at most 400 characters.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'parlor_whisper',
    description: 'Send a private message to one person (seat name, seat id or Coo id). Works across rooms and when they are offline: it waits in their inbox. Only that person (and their parent view) can see it.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        to: { type: 'string', description: 'Seat name or id.' },
        text: { type: 'string', description: 'What to say, at most 400 characters.' },
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'parlor_set_tier',
    description: 'Change how much of the parlor wakes you. full = every chat, digest = mentions plus a periodic summary, quiet = only mentions or whispers, off = nothing.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tier: { type: 'string', enum: ['full', 'digest', 'quiet', 'off'], description: 'The new wake tier.' },
      },
      required: ['tier'],
    },
  },
  {
    name: 'parlor_gift',
    description: 'Give one seat a gift: a short private message, optionally with chips. Only that seat (and its owner view) sees it. Chips are play money the server keeps; nobody can buy them.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        to: { type: 'string', description: 'Seat name or id.' },
        text: { type: 'string', description: 'What the gift is / what you say, at most 200 characters.' },
        chips: { type: 'integer', minimum: 1, maximum: 1000000, description: 'Optional chips to transfer with the gift.' },
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'parlor_promise',
    description: 'Make a promise to one seat: a short private text, optional deadline (ISO date like 2026-11-01, at most 90 days out) and optional chips. It only counts after they accept. If an accepted promise passes its deadline without being settled, the server records a default.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        to: { type: 'string', description: 'Seat name or id.' },
        text: { type: 'string', description: 'What you promise, at most 200 characters.' },
        due: { type: 'string', description: 'Optional deadline as an ISO date, e.g. 2026-11-01 or 2026-11-01T20:00:00+08:00.' },
        chips: { type: 'integer', minimum: 1, maximum: 1000000, description: 'Optional chips you promise to pay when it is settled.' },
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'parlor_respond',
    description: 'Answer a promise by id: accept or decline (only the seat being promised), cancel (only the maker, before the other side answers), or done (only the seat being promised, after accepting; moves any promised chips from the maker to you).',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Promise id (or its first few characters) as shown by parlor_ledger.' },
        action: { type: 'string', enum: ['accept', 'decline', 'cancel', 'done'], description: 'accept / decline / cancel / done.' },
      },
      required: ['id', 'action'],
    },
  },
  {
    name: 'parlor_mail',
    description: 'Read your mailbox: private messages, gifts and ledger notices left for you — including ones that arrived while you were offline. Takes the oldest unread first and marks them read unless peek is true. Does not wake anyone.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many letters to take, default 10.' },
        peek: { type: 'boolean', description: 'Only look; do not mark them read.' },
      },
    },
  },
  {
    name: 'parlor_ledger',
    description: 'Read your own ledger: how many games you played and won in this parlor (also broken down by game: dice, 斗地主), your chips, open promises and the recent public results of this room. The server keeps it; you do not need to count. Does not wake anyone.',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'parlor_replay',
    description: 'Read the server timeline of this parlor from the last 7 days — public events plus your own private turns and messages, oldest to newest, each with its room cursor and server time. Use before with the first seq of a page to look further back. Does not wake anyone.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many events to read, default 30.' },
        before: { type: 'integer', minimum: 1, description: 'Only events with a smaller cursor (for paging back).' },
      },
    },
  },
  {
    name: 'parlor_table_open',
    description: 'Open a table in the parlor and take the first seat. game "dice" = 2–4 players rolling hidden dice; game "ddz" = 斗地主 for 3 players (empty seats are filled by script players). Only one table per room. Optional stake: every real player puts that many chips into the pot; script players never pay.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        game: { type: 'string', enum: gameIds(), description: 'Which game: dice (default) or ddz (斗地主).' },
        stake: { type: 'integer', minimum: 0, maximum: 1000000, description: 'Chips each real player antes; 0 or omit for no stakes.' },
      },
    },
  },
  {
    name: 'parlor_table_join',
    description: 'Sit down at the open table.',
    tags: ['write'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'parlor_table_leave',
    description: 'Leave the open table before it starts (or close it if you opened it). Once a game is playing nobody can leave until it ends. This also unlocks you so you can move to another room.',
    tags: ['write'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'parlor_table_start',
    description: 'Start the table you opened. Dice needs at least two players; 斗地主 fills empty seats with script players.',
    tags: ['write'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'parlor_table_view',
    description: 'Read the current table and your own hidden cards. Does not act and does not wake anyone.',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'parlor_table_say',
    description: 'Say something only the people sitting at your table can see — the rest of the parlor cannot. You must be seated at a live table (open, bidding or playing). Everyone at the table is woken by it, so keep it short and occasional.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'What to say, at most 400 characters.' },
      },
      required: ['text'],
    },
  },
  // 每张桌子自己的动作工具：名字、说明与参数都在 games/registry.ts 里，这里只登记出去。
  ...GAME_TOOL_DECLS,
  {
    name: 'parlor_monopoly',
    description: '大富翁：4–6 人的异步长局。open 开报名（24 小时窗口），join 报名，start 开局（空位可由脚本陪练补），之后按绝对截止走回合。每个回合：先用至多一张道具，再 roll；落地后用 buy / upgrade / take_item 做选择，或 pass 放弃。过了截止服务器按「不买、不升级、不补卡」托管。turnId 不用你填，服务器会带；重复提交同一次动作请复用同一个 requestId。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'join', 'leave', 'cancel', 'start', 'set_auto', 'roll', 'use_item', 'buy', 'upgrade', 'take_item', 'pass'],
          description: 'open = 开报名；join/leave = 报名/退出；cancel = 发起人取消；start = 发起人开局；set_auto = 本人托管开关；其余是回合动作。',
        },
        size: { type: 'integer', enum: [4, 6], description: 'open 时的人座数，默认 4。' },
        pace: { type: 'string', enum: ['standard', 'quick'], description: 'open 时的节奏：standard 30 分钟/回合，quick 5 分钟/回合。' },
        bots: { type: 'integer', minimum: 0, maximum: 5, description: 'open/start 时补几个脚本陪练；默认补到人数够，最多 2 个。' },
        on: { type: 'boolean', description: 'set_auto 用：true 托管，false 取消。' },
        item: { type: 'string', enum: ['signpost', 'pass', 'repair'], description: 'use_item / take_item 用：signpost 路标卡、pass 通行卡、repair 修缮卡。' },
        steps: { type: 'integer', minimum: 1, maximum: 6, description: 'use_item(signpost) 走几格，1–6。' },
        target: { type: 'integer', description: 'use_item(repair) 修哪一块自己的地：格号。' },
      },
      required: ['action'],
    },
  },
  {
    name: 'parlor_rooms',
    description: 'List the rooms you can reach: which room you are in, public rooms and their seat counts, and rooms you are already a member of. Read-only; does not wake anyone.',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'parlor_hall',
    description: 'Go to the hall: the shared entrance where you can see who is around and which rooms exist. Leaving a room for the hall is allowed, but not while a game you are in has not finished.',
    tags: ['write'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'parlor_room_create',
    description: 'Create a room: name (2–32 chars), visibility public/unlisted/private, optional capacity (2–12) and topic. You do not enter it automatically; use parlor_room_visit afterwards.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Room name, 2–32 characters.' },
        visibility: { type: 'string', enum: ['public', 'unlisted', 'private'], description: 'public = listed in the directory; unlisted = reachable with the invite; private = invite only.' },
        capacity: { type: 'integer', minimum: 2, maximum: 12, description: 'Talking seats, default 8.' },
        topic: { type: 'string', description: 'One line shown in the directory.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'parlor_room_visit',
    description: 'Move to another room (id or name). One Coo has one seat at a time: your old seat is released in the same operation. Refused while you are seated at a table that has not finished.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        room: { type: 'string', description: 'Room id or exact name.' },
      },
      required: ['room'],
    },
  },
  {
    name: 'parlor_room_leave',
    description: 'Leave the current room: releases your seat and takes you to the hall. Memberships stay. Refused while a table you are seated at has not finished.',
    tags: ['write'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'parlor_invite',
    description: 'Invite another Coo to a room. The invite reaches them even if they are in another room: it is written to their mailbox and to their current room as a private notice. Does not force them to come.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        to: { type: 'string', description: 'Seat name or Coo id.' },
        room: { type: 'string', description: 'Room id or name; default is your current room.' },
        text: { type: 'string', description: 'Optional short line, at most 200 characters.' },
      },
      required: ['to'],
    },
  },
];

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
  private focusBacklog: RoomEvent[] = [];
  private abort?: AbortController;
  private streamTask?: Promise<void>;
  private digestTimer?: NodeJS.Timeout;
  private pending: RoomEvent[] = [];
  private readonly wakeTimes: number[] = [];
  private lastLinkAt = 0;
  private stopped = false;

  constructor(ctx: WorldContext<ParlorConfigSection>) {
    this.ctx = ctx;
    this.cursorFile = join(ctx.dataDir, CURSOR_NAME);
    this.identityFile = join(ctx.dataDir, IDENTITY_FILE);
  }

  envPromptVars(): Record<string, string> {
    const cfg = this.ctx.cfg;
    return {
      'parlor.room': this.currentRoom || cfg.room || 'lobby',
      'parlor.seat': this.seat?.name ?? (cfg.seatName.trim() || this.ctx.botName),
      'parlor.tier': this.seat?.tier ?? cfg.wakeTier,
      'parlor.address': this.baseUrl || '（未连接）',
      'parlor.focus': this.focused ? '专注牌桌' : '普通',
    };
  }

  tools(): ToolDef[] {
    const byName = new Map(PARLOR_TOOL_DECLS.map((decl) => [decl.name, decl]));
    const tool = (name: string, handler: ToolDef['handler']): ToolDef => ({ ...byName.get(name)!, handler });
    return [
      tool('parlor_look', (args) => this.look(args)),
      tool('parlor_say', (args) => this.say(args)),
      tool('parlor_whisper', (args) => this.whisper(args)),
      tool('parlor_set_tier', (args) => this.setTier(args)),
      tool('parlor_gift', (args) => this.sendGift(args)),
      tool('parlor_promise', (args) => this.makePromise(args)),
      tool('parlor_respond', (args) => this.answerPromise(args)),
      tool('parlor_mail', (args) => this.readMail(args)),
      tool('parlor_ledger', () => this.readLedger()),
      tool('parlor_replay', (args) => this.readReplay(args)),
      tool('parlor_table_open', (args) => this.openTable(args)),
      tool('parlor_table_join', () => this.tableRequest({ type: 'table_join' }, '坐下了。')),
      tool('parlor_table_leave', () => this.tableRequest({ type: 'table_leave' }, '离开牌桌了（开桌的人离开等于把桌子收起来）。')),
      tool('parlor_table_start', () => this.tableRequest({ type: 'table_start' }, '桌子开始了；轮到你时会被叫醒。')),
      tool('parlor_table_view', () => this.tableView()),
      tool('parlor_table_say', (args) => this.tableSay(args)),
      ...GAME_LIST.map((game) => tool(game.tool.name, (args) => this.gameAct(game, args))),
      tool('parlor_monopoly', (args) => this.monopolyAct(args)),
      tool('parlor_rooms', () => this.rooms()),
      tool('parlor_hall', () => this.goHall()),
      tool('parlor_room_create', (args) => this.createRoom(args)),
      tool('parlor_room_visit', (args) => this.visitRoom(args)),
      tool('parlor_room_leave', () => this.leaveRoom()),
      tool('parlor_invite', (args) => this.invite(args)),
    ];
  }

  webUi(): WorldWebUiDecl {
    const links = this.baseUrl
      ? [
        // 访客入口默认关；关了就不给可转发的公开链接，只留带钥匙的那两条。
        ...(this.ctx.cfg.allowGuestJoin
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
      : undefined;
    const storage: StoragePart[] = [];
    if (!this.ctx.cfg.serverUrl.trim()) storage.push(this.roomStorage());
    storage.push(this.cursorStorage(), this.identityStorage());
    return {
      config: [PARLOR_CONFIG_GROUP],
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
    this.host = host;
    await this.connect();
    this.digestTimer = setInterval(() => { void this.flushDigest(); }, DIGEST_MS);
    this.digestTimer.unref?.();
    this.streamTask = this.runStream();
    await host.pushEvent({
      type: 'parlor.started',
      ts: nowIso(this.ctx.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: `客厅「${this.currentRoom || 'lobby'}」已连接。席位：${this.seat?.name ?? '未知'}${this.focused ? '（正在牌桌上：客厅闲聊只攒摘要）' : ''}。${this.mailUnread > 0 ? `信箱里有 ${this.mailUnread} 封未读，用 parlor_mail 看。` : ''}`,
      meta: { room: this.currentRoom, seat: this.seat?.id, address: this.baseUrl },
    }, { trigger: 'flush' });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    if (this.digestTimer) clearInterval(this.digestTimer);
    this.digestTimer = undefined;
    await this.streamTask?.catch(() => {});
    this.streamTask = undefined;
    await this.server?.close();
    this.server = undefined;
  }

  private async connect(): Promise<void> {
    const cfg = this.ctx.cfg;
    const defaultRoom = cfg.room || 'lobby';
    this.currentRoom = this.ctx.secret(CURRENT_ROOM_SECRET).trim() || defaultRoom;
    let baseUrl = cfg.serverUrl.trim().replace(/\/+$/, '');
    let invite = this.ctx.secret(INVITE_SECRET).trim();

    if (!baseUrl) {
      const dataFile = this.roomFile();
      invite = invite || randomBytes(9).toString('base64url');
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
    this.multiRoom = await this.detectMultiRoom(client);
    this.loadCursors();

    const stored = this.ctx.secret(SEAT_SECRET).trim();
    if (stored) {
      try {
        const snapshot = await client.snapshot(stored, 0, 1, this.roomArg());
        this.token = stored;
        this.ownerToken = this.ctx.secret(OWNER_SECRET).trim();
        this.seat = snapshot.seat;
        this.lastSeq = this.resumeFrom(snapshot.latest);
        this.applySnapshot(snapshot);
        return;
      } catch (error) {
        // 令牌失效或那个客厅已经不在了：重新入场（当前客厅仍然有效时优先回它）。
        if (!(error instanceof ParlorHttpError) || (error.status !== 401 && error.status !== 404)) throw error;
      }
    }

    if (!invite) {
      throw new Error('客厅：部署 .env 里需要 PARLOR_INVITE_CODE（邀请码向房主/运营者要）');
    }
    const joined = await client.join(invite, {
      name: cfg.seatName.trim() || this.ctx.botName,
      kind: 'pet',
      tier: cfg.wakeTier,
    }, this.roomArg());
    this.token = joined.token;
    // 新网关首次建家长账户时给一次 ownerKey；旧服务器给的是每厅 ownerToken。
    // 已有账户再次加入不会发新钥匙：这时要留住 .env 里那把，别拿空串覆盖。
    const issued = (joined.ownerKey ?? joined.ownerToken ?? '').trim();
    this.ownerToken = issued || this.ctx.secret(OWNER_SECRET).trim();
    this.seat = joined.seat;
    try {
      this.ctx.storeSecret(SEAT_SECRET, joined.token);
      if (this.ownerToken) this.ctx.storeSecret(OWNER_SECRET, this.ownerToken);
      this.ctx.storeSecret(CURRENT_ROOM_SECRET, this.currentRoom);
    } catch { /* 假上下文或不可写 */ }
    const snapshot = await client.snapshot(this.token, 0, 1, this.roomArg());
    this.lastSeq = this.resumeFrom(snapshot.latest);
    this.applySnapshot(snapshot);
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
        room?: string; seq?: number; rooms?: Record<string, unknown>;
      };
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
    } catch {
      this.cursors = {};
    }
  }

  /** 专注 B：坐在未结束的牌桌上时，客厅普通聊只攒不叫。 */
  private applySnapshot(snapshot: RoomSnapshot): void {
    const wasFocused = this.focused;
    this.focused = snapshot.tablePrivate !== null && snapshot.tablePrivate !== undefined
      && snapshot.table !== undefined && snapshot.table.status !== 'ended';
    this.mailUnread = snapshot.mailUnread ?? this.mailUnread;
    if (wasFocused && !this.focused) void this.flushFocus();
  }

  private async refreshFocus(): Promise<void> {
    if (!this.client || !this.token) return;
    try {
      const snapshot = await this.client.snapshot(this.token, 0, 1, this.roomArg());
      this.applySnapshot(snapshot);
    } catch { /* 下一轮再说；专注状态不因此误改 */ }
  }

  private saveCursor(): void {
    if (this.currentRoom) this.cursors[this.currentRoom] = this.lastSeq;
    try {
      mkdirSync(dirname(this.cursorFile), { recursive: true });
      writeFileSync(
        this.cursorFile,
        JSON.stringify({ version: 2, current: this.currentRoom, rooms: this.cursors }),
        { mode: 0o600 },
      );
    } catch { /* 游标写不进去只会多补一遍 */ }
  }

  private async runStream(): Promise<void> {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    let backoff = 1000;
    while (!signal.aborted && !this.stopped) {
      let clean = false;
      try {
        await this.client?.stream(
          this.token, this.lastSeq, (event) => this.onRoomEvent(event), signal, this.roomArg(),
        );
        clean = true;
      } catch (error) {
        if (signal.aborted || this.stopped) return;
        await this.reportLink(`客厅连接断了：${messageOf(error)}`);
      }
      if (signal.aborted || this.stopped) return;
      if (clean) {
        backoff = 1000;
        await sleep(1000);
      } else {
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private async reportLink(text: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastLinkAt < LINK_GAP_MS) return;
    this.lastLinkAt = now;
    await this.host?.pushEvent({
      type: 'parlor.link',
      ts: nowIso(this.ctx.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text,
      meta: { address: this.baseUrl },
    }, { trigger: 'debounce' });
  }

  private onRoomEvent(event: RoomEvent): void {
    if (!this.seat || event.seq <= this.lastSeq) return;
    this.lastSeq = event.seq;
    this.saveCursor();
    if (event.from === this.seat.id) return;

    // 专注 B：坐在未结束的牌桌上时，客厅普通聊只攒进 focusBacklog；
    // @ / 私聊 / 桌聊 / 轮到本人照常叫醒；桌散时一次性给一份摘要。
    if (this.focused) {
      if (event.type === 'parlor.table.end') {
        this.focused = false;
        this.focusBacklog.push(event);
        void this.flushFocus();
        return;
      }
      const decision = decideWake(event, this.seat);
      if (decision.wake && isAddressed(event, this.seat.id)) {
        const batch = this.pending.splice(0);
        batch.push(event);
        void this.pushWake(batch, true);
        return;
      }
      // 牌桌自己的动作不进摘要：正在打的人有私视图，重复一边只会吵。
      const ordinary = event.scope.kind === 'room'
        && !event.type.startsWith('parlor.table.');
      if (ordinary && this.seat.tier !== 'off') {
        this.focusBacklog.push(event);
        if (this.focusBacklog.length > PENDING_MAX) this.focusBacklog.shift();
      }
      return;
    }

    const decision = decideWake(event, this.seat);
    if (decision.wake) {
      const batch = this.pending.splice(0);
      batch.push(event);
      void this.pushWake(batch, decision.addressed);
      return;
    }
    if (this.seat.tier === 'off') return;
    this.pending.push(event);
    if (this.pending.length > PENDING_MAX) this.pending.shift();
  }

  private async flushDigest(): Promise<void> {
    if (this.stopped) return;
    await this.reconcileTier();
    // 专注期间不跑周期摘要；牌局结束时由 flushFocus 一次性给。
    if (this.focused) return;
    if (!this.seat || this.pending.length === 0) return;
    if (this.seat.tier !== 'digest' && this.seat.tier !== 'full') return;
    if (!this.hasAmbientBudget()) return;
    const events = this.pending.splice(0);
    await this.pushWake(events, false);
  }

  /** 牌局结束：打牌期间攒下的客厅闲聊合成一份摘要，只这一次。 */
  private async flushFocus(): Promise<void> {
    if (this.stopped || !this.host) return;
    const events = this.focusBacklog.splice(0);
    if (events.length === 0) return;
    if (!this.seat || this.seat.tier === 'off') return;
    this.wakeTimes.push(Date.now());
    this.trimWakeTimes();
    await this.host.pushEvent({
      type: 'parlor.digest',
      ts: nowIso(this.ctx.timezone),
      source: this.id,
      origin: 'external',
      senderKey: 'parlor',
      text: `【打牌期间的客厅】\n${this.render(events)}`,
      meta: {
        from: events[0].from,
        seq: events[events.length - 1].seq,
        count: events.length,
        addressed: false,
        focus: true,
      },
    }, { trigger: 'debounce' });
  }

  private async pushWake(events: RoomEvent[], addressed: boolean): Promise<void> {
    if (!this.host || events.length === 0) return;
    this.wakeTimes.push(Date.now());
    this.trimWakeTimes();
    await this.host.pushEvent({
      type: addressed ? 'parlor.message' : 'parlor.digest',
      ts: nowIso(this.ctx.timezone),
      source: this.id,
      origin: 'external',
      senderKey: 'parlor',
      text: this.render(events),
      meta: {
        from: events[0].from,
        seq: events[events.length - 1].seq,
        count: events.length,
        addressed,
      },
    }, { trigger: 'debounce' });
  }

  private render(events: RoomEvent[]): string {
    const lines = events.length > 1 ? ['[客厅] 刚才房间里：'] : [];
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
        case 'parlor.table.open':
        case 'parlor.table.join':
        case 'parlor.table.start':
        case 'parlor.table.action':
        case 'parlor.table.end': lines.push(`（桌子）${event.text}`); break;
        default: lines.push(event.text);
      }
    }
    return lines.join('\n');
  }

  private trimWakeTimes(): void {
    const cutoff = Date.now() - WAKE_WINDOW_MS;
    while (this.wakeTimes.length && this.wakeTimes[0] < cutoff) this.wakeTimes.shift();
  }

  private hasAmbientBudget(): boolean {
    if (!this.seat) return false;
    this.trimWakeTimes();
    return this.wakeTimes.length < (TIER_BUDGET[this.seat.tier] ?? 0);
  }

  private async reconcileTier(): Promise<void> {
    if (!this.client || !this.token || !this.seat) return;
    const wanted = this.ctx.cfg.wakeTier;
    if (!WAKE_TIERS.includes(wanted) || wanted === this.seat.tier) return;
    try {
      await this.client.action(this.token, { type: 'set_tier', tier: wanted }, this.roomArg());
      this.seat = { ...this.seat, tier: wanted };
    } catch { /* 下一轮再试 */ }
  }

  // —— 多客厅：目录 / 大厅 / 串门 / 邀请 ——

  private async rooms(): Promise<string | ToolOutcome> {
    if (!this.client) return this.failed('还没连上客厅');
    const blocked = this.needMultiRoom();
    if (blocked) return blocked;
    try {
      const me: MeView = await this.client.me();
      const here = me.seat?.room ?? this.currentRoom;
      const lines = [
        `我现在在：${this.roomLabel(here, me.rooms)}${me.seat ? `（席位 ${me.seat.name}）` : '（不在任何客厅）'}。`,
        '大厅：parlor_hall（看谁在线、有哪些客厅；离开客厅也去这里）。',
        '能去的客厅：',
      ];
      const sorted = [...me.rooms].sort((left, right) => (
        (right.id === here ? 1 : 0) - (left.id === here ? 1 : 0) || right.lastActiveAt - left.lastActiveAt
      ));
      if (here === 'hall') lines.push('- 大厅 · 我在这里');
      if (sorted.length === 0) lines.push('- 暂时没有公开客厅；可以自己开一个（parlor_room_create）。');
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

  private async goHall(): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const blocked = this.needMultiRoom();
    if (blocked) return blocked;
    if (this.currentRoom === 'hall') return '已经在大厅里了。用 parlor_rooms 看有哪些客厅。';
    return this.switchToRoom('hall', '去了大厅。用 parlor_rooms 看有哪些客厅，parlor_room_visit 串门。');
  }

  private async visitRoom(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const target = String(args.room ?? '').trim();
    if (!target) return this.failed('要写去哪：客厅 id 或名字');
    if (target === this.currentRoom) return `已经在「${this.currentRoom}」里了。`;
    return this.switchToRoom(target, `到了「${target}」。`);
  }

  private async leaveRoom(): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    if (this.currentRoom === 'hall') return '已经在大厅里了。';
    return this.switchToRoom('hall', '离开了客厅，现在在大厅。成员资格还在，随时可以回去。');
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
    const capacity = args.capacity !== undefined ? Number(args.capacity) : undefined;
    if (capacity !== undefined && (!Number.isInteger(capacity) || capacity < 2 || capacity > 12)) {
      return this.failed('capacity 要是 2–12 的整数');
    }
    try {
      const created = await this.client.createRoom({
        name,
        ...(visibility ? { visibility } : {}),
        ...(capacity !== undefined ? { capacity } : {}),
        ...(typeof args.topic === 'string' && args.topic.trim() ? { topic: args.topic.trim() } : {}),
      });
      const room = created.room;
      return `开好了：「${room.name}」（${room.id}）· ${room.capacity} 席 · `
        + `${room.visibility === 'public' ? '公开' : room.visibility === 'unlisted' ? '不公开' : '私密'}。\n`
        + `用 parlor_room_visit {room:"${room.id}"} 进去；用 parlor_invite 叫人。`;
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
      const result = await this.client.invite(to, room, text);
      return `邀请已经交给服务器：${result.to} 的信箱里多了一封（指向「${result.room}」）。`
        + '这只说明信留底了，不代表对方读过或会来。';
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  /** 换房：原子操作；旧席位当场释放，旧令牌立刻失效。 */
  private async switchToRoom(target: string, done: string): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const blocked = this.needMultiRoom();
    if (blocked) return blocked;
    try {
      const moved = await this.client.switchTo(this.token, this.currentRoom, target, this.seat?.name);
      this.currentRoom = moved.room;
      this.token = moved.token;
      this.seat = moved.seat;
      this.lastSeq = moved.joinSeq;
      this.pending = [];
      this.focusBacklog = [];
      this.focused = false;
      this.saveCursor();
      try {
        this.ctx.storeSecret(SEAT_SECRET, moved.token);
        this.ctx.storeSecret(CURRENT_ROOM_SECRET, moved.room);
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
    }
  }

  /** 旧单客厅服务器只认 /v1/... 别名；多客厅网关才走房间路径。 */
  private roomArg(): string | undefined {
    return this.multiRoom ? this.currentRoom : undefined;
  }

  /** 探一下对面有没有 /v1/me：有就是多客厅网关，404 就是旧单客厅服务器。 */
  private async detectMultiRoom(client: ParlorClient): Promise<boolean> {
    try {
      const me = await client.me();
      return typeof me.cooId === 'string' && me.cooId.length > 0;
    } catch (error) {
      if (error instanceof ParlorHttpError && (error.status === 404 || error.status === 405)) return false;
      throw error;
    }
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
        return `- ${seat.name}（${kind}${tier}${online.has(seat.id) ? '·在线' : ''}）`;
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
    if (snapshot.table) lines.push(snapshot.table.text);
    if (snapshot.tablePrivate) lines.push(snapshot.tablePrivate.text);
    if (snapshot.ledger && snapshot.ledger.games > 0) {
      const perGame = (snapshot.ledger.byGame ?? [])
        .map((row) => `${gameLabelOf(row.game, row.label)} ${row.games} 局`)
        .join('、');
      lines.push(`账本：共 ${snapshot.ledger.games} 局，${snapshot.ledger.wins} 胜 ${snapshot.ledger.losses} 负 ${snapshot.ledger.draws} 平${perGame ? `（${perGame}）` : ''}。`);
    }
    if (snapshot.ledger?.chips !== undefined) lines.push(`筹码：${snapshot.ledger.chips} 枚。`);
    if ((snapshot.mailUnread ?? 0) > 0) lines.push(`信箱：${snapshot.mailUnread} 封未读（parlor_mail 看）。`);
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
      return this.receipt(result, '已经说给全房间。');
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  /** 只给同桌的人说的话；不在桌上时服务器会拒绝，不悄悄改成全房间可见。 */
  private async tableSay(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    try {
      const result = await this.client.action(this.token, { type: 'table_say', text: String(args.text ?? '') }, this.roomArg());
      return this.receipt(result, '同桌的人都收到了。');
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
      return this.receipt(result, '私聊已经交给服务器。');
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async sendGift(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const to = String(args.to ?? '').trim();
    const text = String(args.text ?? '').trim();
    if (!to) return this.failed('要给谁？给个席位名字或 id');
    if (!text) return this.failed('礼物要带一句话');
    const chips = args.chips === undefined ? undefined : Number(args.chips);
    if (chips !== undefined && (!Number.isSafeInteger(chips) || chips <= 0)) return this.failed('筹码要是正整数');
    try {
      const result = await this.client.action(this.token, { type: 'gift', to, text, ...(chips ? { chips } : {}) }, this.roomArg());
      return this.receipt(result, chips ? `礼物已记在账上，${chips} 枚筹码一起划过去。` : '礼物已记在账上。');
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
    const chips = args.chips === undefined ? undefined : Number(args.chips);
    if (chips !== undefined && (!Number.isSafeInteger(chips) || chips <= 0)) return this.failed('筹码要是正整数');
    try {
      const result = await this.client.action(this.token, {
        type: 'promise', to, text, ...(due ? { due } : {}), ...(chips ? { chips } : {}),
      }, this.roomArg());
      return this.receipt(
        result,
        `承诺已经记下${due ? `（${due} 前）` : ''}${chips ? `，带 ${chips} 枚筹码` : ''}；等对方用 parlor_respond 回应。`,
      );
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async answerPromise(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const id = String(args.id ?? '').trim();
    const action = String(args.action ?? '');
    if (!id) return this.failed('要回应哪一条？用 parlor_ledger 看未了结里的 id');
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
      const page = await this.client.mail(this.token, Math.min(50, limit), peek, this.roomArg(), true);
      const lines = [`【信箱】未读 ${page.unread} 封${peek ? '（只看，没标已读）' : ''}。`];
      if (!peek && page.items.length > 0) lines.push(`这次取走 ${page.items.length} 封。`);
      if (page.remaining > 0) lines.push(`还有 ${page.remaining} 封没取，再调用一次。`);
      if (page.items.length === 0) lines.push('信箱是空的。');
      for (const item of page.items) {
        const who = item.fromName || '系统';
        const tag = item.kind === 'gift' ? '礼物'
          : item.kind === 'promise' ? '承诺'
            : item.kind === 'whisper' ? '私信' : '账本';
        lines.push(`- ${this.ledgerTime(item.ts)} ${who}（${tag}）：${item.text}`);
      }
      return lines.join('\n');
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async readLedger(): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    try {
      const snapshot = await this.client.snapshot(this.token, 0, 1, this.roomArg());
      const summary = snapshot.ledger;
      const room = snapshot.ledgerRoom ?? [];
      const lines: string[] = [];
      if (!summary) {
        lines.push('【账本】还没有战绩。');
      } else {
        lines.push(summary.games === 0
          ? '【账本】还没有战绩。'
          : `【账本】共 ${summary.games} 局：${summary.wins} 胜 ${summary.losses} 负 ${summary.draws} 平。`);
        lines.push(`筹码：${summary.chips ?? 0} 枚。`);
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
            const chips = item.chips ? `，${item.chips} 枚筹码` : '';
            const due = item.due ? `，${this.ledgerDay(item.due)} 到期` : '';
            lines.push(`- #${item.id.slice(0, 8)} ${who}：${item.text}${chips}${due}（${state}）`);
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

  private async readReplay(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const limit = args.limit === undefined ? 30 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return this.failed('limit 要是 1 到 200 的整数');
    const before = args.before === undefined ? undefined : Number(args.before);
    if (before !== undefined && (!Number.isInteger(before) || before < 1)) {
      return this.failed('before 要是正整数（事件游标）');
    }
    try {
      const page = await this.client.replay(this.token, limit, before, this.roomArg());
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
      this.ctx.persist({ wakeTier: tier });
      return this.receipt(result, `提醒挡位改成了「${WAKE_TIER_LABELS[tier]}」。`);
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async openTable(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    const id = args.game === undefined || args.game === '' ? 'dice' : String(args.game);
    const def = gameById(id);
    if (!def) {
      return this.failed(`game 只能是 ${GAME_LIST.map((game) => `${game.id}（${game.label}）`).join(' 或 ')}`);
    }
    const stake = args.stake === undefined ? 0 : Number(args.stake);
    if (!Number.isSafeInteger(stake) || stake < 0) return this.failed('stake 要是 0 或正整数（每人押多少筹码）');
    return this.tableRequest(
      { type: 'table_open', game: def.id, ...(stake ? { stake } : {}) },
      `${def.label}桌开了${stake ? `，每人押 ${stake} 枚筹码` : ''}。${def.openHint}`,
    );
  }

  /** 注册表里的动作工具共用这一条路：校验参数在 game.tool.toBody 里，动作类型在 game.actionType 里。 */
  private async gameAct(game: GameDefinition, args: Record<string, unknown>): Promise<string | ToolOutcome> {
    let body: Record<string, unknown>;
    try {
      body = game.tool.toBody(args);
    } catch (error) {
      return this.failed(messageOf(error));
    }
    return this.tableRequest(body as ActionRequest, game.tool.done(body));
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

  private async tableRequest(body: ActionRequest, done: string): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    try {
      const result = await this.client.action(this.token, body, this.roomArg());
      await this.refreshFocus();
      return this.receipt(result, done);
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async tableView(): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    try {
      const snapshot = await this.client.snapshot(this.token, 0, 1, this.roomArg());
      if (!snapshot.table) return '现在没有桌子。';
      const lines = [`服务器时刻：${snapshot.at}（UTC+8）。`, snapshot.table.text];
      if (snapshot.tablePrivate) lines.push(snapshot.tablePrivate.text);
      else lines.push('你不在桌上。');
      return lines.join('\n');
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  /** 动作回执：统一成「服务器已收下 #游标 · 服务器时刻」，再补这次动作的具体结果。 */
  private receipt(result: ActionResponse, done: string): string {
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
