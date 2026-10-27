/**
 * 客厅 World：连上房间，把可见事件按提醒挡位交给 Core，提供说话/私聊/查看工具。
 * 它不判断谁能看见什么；服务器只发这个席位能看见的事件。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoragePart, ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { WorldContext } from 'cortico/world.ts';
import { PARLOR_CONFIG_GROUP, type ParlorConfigSection } from './config.ts';
import { ParlorClient, ParlorHttpError } from './room/client.ts';
import { ParlorServer } from './room/server.ts';
import {
  WAKE_TIERS, WAKE_TIER_LABELS, decideWake,
  type ActionRequest, type RoomEvent, type RoomSnapshot, type Seat, type WakeTier,
} from './room/protocol.ts';
import { RANKS } from './room/games/doudizhu.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const INVITE_SECRET = 'PARLOR_INVITE_CODE';
const SEAT_SECRET = 'PARLOR_SEAT_TOKEN';
const OWNER_SECRET = 'PARLOR_OWNER_TOKEN';
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
    description: 'Send a private message to one seat. Only that seat (and its owner view) can see it.',
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
    name: 'parlor_table_open',
    description: 'Open a table in the parlor and take the first seat. game "dice" = 2–4 players rolling hidden dice; game "ddz" = 斗地主 for 3 players (empty seats are filled by script players). Only one table per room.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        game: { type: 'string', enum: ['dice', 'ddz'], description: 'Which game: dice (default) or ddz (斗地主).' },
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
    name: 'parlor_table_start',
    description: 'Start the table you opened. Dice needs at least two players; 斗地主 fills empty seats with script players.',
    tags: ['write'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'parlor_table_action',
    description: 'On your turn at the dice table: reroll one hidden die or stand. Highest total wins; the table reveals all dice at the end.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['roll', 'stand'], description: 'roll = reroll one die, stand = keep your total.' },
        die: { type: 'integer', enum: [0, 1], description: 'Which die to reroll when action is roll.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'parlor_table_view',
    description: 'Read the current table and your own hidden cards. Does not act and does not wake anyone.',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'parlor_ddz_action',
    description: 'On your turn at 斗地主: bid for landlord (move "bid" with call true/false), play cards (move "play" with cards), or pass. Card names are 3,4,5,6,7,8,9,10,J,Q,K,A,2,SJ (small joker),BJ (big joker); there are no suits. The server judges every move and says why an illegal one was refused.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        move: { type: 'string', enum: ['bid', 'play', 'pass'], description: 'bid = call or decline landlord; play = put down cards; pass = skip.' },
        call: { type: 'boolean', description: 'When move is bid: true = become landlord, false = decline.' },
        cards: {
          type: 'array',
          items: { type: 'string', enum: [...RANKS] },
          description: 'When move is play: the exact cards from your hand, e.g. ["3","3"] or ["3","4","5","6","7"].',
        },
      },
      required: ['move'],
    },
  },
];

export class ParlorWorld implements World {
  readonly id = 'parlor';

  private readonly ctx: WorldContext<ParlorConfigSection>;
  private readonly cursorFile: string;
  private host?: WorldHost;
  private server?: ParlorServer;
  private client?: ParlorClient;
  private baseUrl = '';
  private inviteCode = '';
  private token = '';
  private ownerToken = '';
  private seat?: Seat;
  private lastSeq = 0;
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
  }

  envPromptVars(): Record<string, string> {
    const cfg = this.ctx.cfg;
    return {
      'parlor.room': cfg.room || 'lobby',
      'parlor.seat': this.seat?.name ?? (cfg.seatName.trim() || this.ctx.botName),
      'parlor.tier': this.seat?.tier ?? cfg.wakeTier,
      'parlor.address': this.baseUrl || '（未连接）',
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
      tool('parlor_table_open', (args) => this.openTable(args)),
      tool('parlor_table_join', () => this.tableRequest({ type: 'table_join' }, '坐下了。')),
      tool('parlor_table_start', () => this.tableRequest({ type: 'table_start' }, '桌子开始了；轮到你时会被叫醒。')),
      tool('parlor_table_action', (args) => this.tableAct(args)),
      tool('parlor_table_view', () => this.tableView()),
      tool('parlor_ddz_action', (args) => this.ddzAct(args)),
    ];
  }

  webUi(): WorldWebUiDecl {
    const links = this.baseUrl && this.ownerToken
      ? [{ label: '客厅 · 家长页', href: `${this.baseUrl}/v1/owner?token=${encodeURIComponent(this.ownerToken)}`, inheritTheme: true }]
      : undefined;
    const storage: StoragePart[] = [];
    if (!this.ctx.cfg.serverUrl.trim()) storage.push(this.roomStorage());
    storage.push(this.cursorStorage());
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
            { name: 'parlor.room', description: '房间名。' },
            { name: 'parlor.seat', description: '你在这个房间里的席位名。' },
            { name: 'parlor.tier', description: '当前提醒挡位。' },
            { name: 'parlor.address', description: '房间地址；未连接时是占位。' },
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
      text: `客厅「${this.ctx.cfg.room || 'lobby'}」已连接。席位：${this.seat?.name ?? '未知'}。`,
      meta: { room: this.ctx.cfg.room, seat: this.seat?.id, address: this.baseUrl },
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
    const room = cfg.room || 'lobby';
    let baseUrl = cfg.serverUrl.trim().replace(/\/+$/, '');
    let invite = this.ctx.secret(INVITE_SECRET).trim();

    if (!baseUrl) {
      const dataFile = this.roomFile();
      invite = invite || randomBytes(9).toString('base64url');
      if (!this.ctx.secret(INVITE_SECRET)) {
        try { this.ctx.storeSecret(INVITE_SECRET, invite); } catch { /* 假上下文或不可写 */ }
      }
      this.server = new ParlorServer({
        id: room,
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
    const client = new ParlorClient(baseUrl);
    this.client = client;

    const stored = this.ctx.secret(SEAT_SECRET).trim();
    if (stored) {
      try {
        const snapshot = await client.snapshot(stored, 0, 1);
        this.token = stored;
        this.ownerToken = this.ctx.secret(OWNER_SECRET).trim();
        this.seat = snapshot.seat;
        this.lastSeq = this.resumeFrom(snapshot.latest);
        return;
      } catch (error) {
        if (!(error instanceof ParlorHttpError) || error.status !== 401) throw error;
      }
    }

    if (!invite) {
      throw new Error('客厅：部署 .env 里需要 PARLOR_INVITE_CODE（邀请码向房主/运营者要）');
    }
    const joined = await client.join(invite, {
      name: cfg.seatName.trim() || this.ctx.botName,
      kind: 'pet',
      tier: cfg.wakeTier,
    });
    this.token = joined.token;
    this.ownerToken = joined.ownerToken;
    this.seat = joined.seat;
    try {
      this.ctx.storeSecret(SEAT_SECRET, joined.token);
      this.ctx.storeSecret(OWNER_SECRET, joined.ownerToken);
    } catch { /* 假上下文或不可写 */ }
    const snapshot = await client.snapshot(this.token, 0, 1);
    this.lastSeq = snapshot.latest;
  }

  /** 断线重连从上次游标继续；游标比服务器新（房间重建过）时退回服务器最新。 */
  private resumeFrom(latest: number): number {
    const saved = this.loadCursor();
    return saved > 0 && saved <= latest ? saved : latest;
  }

  private loadCursor(): number {
    try {
      const raw = JSON.parse(readFileSync(this.cursorFile, 'utf8')) as { room?: string; seq?: number };
      return raw.room === (this.ctx.cfg.room || 'lobby') && typeof raw.seq === 'number' ? raw.seq : 0;
    } catch {
      return 0;
    }
  }

  private saveCursor(): void {
    try {
      mkdirSync(dirname(this.cursorFile), { recursive: true });
      writeFileSync(this.cursorFile, JSON.stringify({ room: this.ctx.cfg.room || 'lobby', seq: this.lastSeq }), { mode: 0o600 });
    } catch { /* 游标写不进去只会多补一遍 */ }
  }

  private async runStream(): Promise<void> {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    let backoff = 1000;
    while (!signal.aborted && !this.stopped) {
      let clean = false;
      try {
        await this.client?.stream(this.token, this.lastSeq, (event) => this.onRoomEvent(event), signal);
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
    if (!this.seat || this.pending.length === 0) return;
    if (this.seat.tier !== 'digest' && this.seat.tier !== 'full') return;
    if (!this.hasAmbientBudget()) return;
    const events = this.pending.splice(0);
    await this.pushWake(events, false);
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
        case 'parlor.whisper': lines.push(`${name} 悄悄对你说：${event.text}`); break;
        case 'parlor.joined':
        case 'parlor.left':
        case 'parlor.tier': lines.push(`（系统）${event.text}`); break;
        case 'parlor.table.turn': lines.push(event.text); break;
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
      await this.client.action(this.token, { type: 'set_tier', tier: wanted });
      this.seat = { ...this.seat, tier: wanted };
    } catch { /* 下一轮再试 */ }
  }

  private async look(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const since = Number.isFinite(Number(args.since)) ? Math.max(0, Number(args.since)) : Math.max(0, this.lastSeq - 20);
    const limit = Number.isFinite(Number(args.limit)) ? Math.min(100, Math.max(1, Number(args.limit))) : 30;
    try {
      const snapshot = await this.client.snapshot(this.token, since, limit);
      return this.formatSnapshot(snapshot);
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private formatSnapshot(snapshot: RoomSnapshot): string {
    const speakers = snapshot.seats.filter((seat) => seat.kind !== 'observer');
    const online = new Set(snapshot.online ?? []);
    const lines = [
      `客厅「${snapshot.id}」 · 会说话的席位 ${speakers.length}/${snapshot.maxSeats}`,
      ...snapshot.seats.map((seat) => `- ${seat.name}（${KIND_LABELS[seat.kind] ?? seat.kind}·${WAKE_TIER_LABELS[seat.tier] ?? seat.tier}${online.has(seat.id) ? '·在线' : ''}）`),
      `最新游标 ${snapshot.latest}`,
    ];
    if (snapshot.table) lines.push(snapshot.table.text);
    if (snapshot.tablePrivate) lines.push(snapshot.tablePrivate.text);
    if (snapshot.events.length === 0) {
      lines.push('从那个位置之后没有你能看到的新消息。');
    } else {
      lines.push('消息：');
      for (const event of snapshot.events) lines.push(`#${event.seq} ${this.render([event])}`);
    }
    return lines.join('\n');
  }

  private async say(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    try {
      const result = await this.client.action(this.token, { type: 'say', text: String(args.text ?? '') });
      return `已说（#${result.seq}）。`;
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
      });
      return `已私聊（#${result.seq}）。`;
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async setTier(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    const tier = String(args.tier ?? '') as WakeTier;
    if (!WAKE_TIERS.includes(tier)) return this.failed('未知的提醒挡位');
    try {
      await this.client.action(this.token, { type: 'set_tier', tier });
      if (this.seat) this.seat = { ...this.seat, tier };
      this.ctx.persist({ wakeTier: tier });
      return `提醒挡位改成了「${WAKE_TIER_LABELS[tier]}」。`;
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async openTable(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (args.game !== undefined && args.game !== 'dice' && args.game !== 'ddz') {
      return this.failed('game 只能是 dice（骰子）或 ddz（斗地主）');
    }
    const game = args.game === 'ddz' ? 'ddz' : 'dice';
    return this.tableRequest(
      { type: 'table_open', game },
      game === 'ddz'
        ? '斗地主桌开了（3 席，空位由脚本陪练补）。用 parlor_table_start 开始；叫地主时会叫你。'
        : '骰子桌开了。等人坐下后用 parlor_table_start 开始。',
    );
  }

  private async ddzAct(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    const move = String(args.move ?? '');
    if (move === 'bid') {
      const call = args.call === true;
      return this.tableRequest(
        { type: 'ddz_action', move: 'bid', call },
        call ? '叫了地主。' : '不叫。',
      );
    }
    if (move === 'play') {
      const cards = Array.isArray(args.cards) ? args.cards.map((card) => String(card)) : [];
      if (cards.length === 0) return this.failed('出牌要给 cards，例如 ["3","3"]');
      return this.tableRequest(
        { type: 'ddz_action', move: 'play', cards },
        `出了 ${cards.join(' ')}。`,
      );
    }
    if (move === 'pass') return this.tableRequest({ type: 'ddz_action', move: 'pass' }, '过了。');
    return this.failed('move 只能是 bid、play 或 pass');
  }

  private async tableRequest(body: ActionRequest, ok: string): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    try {
      await this.client.action(this.token, body);
      return ok;
    } catch (error) {
      return this.failed(messageOf(error));
    }
  }

  private async tableAct(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    const action = String(args.action ?? '');
    if (action !== 'roll' && action !== 'stand') return this.failed('action 只能是 roll 或 stand');
    const die = action === 'roll' ? Number(args.die ?? 0) : undefined;
    if (die !== undefined && die !== 0 && die !== 1) return this.failed('die 只能是 0 或 1');
    return this.tableRequest(
      { type: 'table_action', action, die },
      action === 'roll' ? '重掷了一颗骰子。' : '停牌了。',
    );
  }

  private async tableView(): Promise<string | ToolOutcome> {
    if (!this.client || !this.token) return this.failed('还没连上客厅');
    try {
      const snapshot = await this.client.snapshot(this.token, 0, 1);
      if (!snapshot.table) return '现在没有桌子。';
      const lines = [snapshot.table.text];
      if (snapshot.tablePrivate) lines.push(snapshot.tablePrivate.text);
      else lines.push('你不在桌上。');
      return lines.join('\n');
    } catch (error) {
      return this.failed(messageOf(error));
    }
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
