import { createHash } from 'node:crypto';
import { ParentKeyUnavailable, ParlorSession, type ParlorOptions, type StateStore } from './session.ts';
import { ParlorHttpError } from '../../../src/room/client.ts';
import type { ActionRequest } from '../../../src/room/protocol.ts';

export const name = 'cortico-parlor-dsh';
export const inject = ['tools', 'credentials', 'profileContext'];
const PARENT_PATH = '/api/cortico-parlor-dsh.parent';

type State = Awaited<ReturnType<StateStore['update']>>;
type Grant = { kind: 'grant'; payload: State };
type JsonObject = Record<string, unknown>;
type Schema = { type: string; [key: string]: unknown };

interface DshContext {
  profileContext: { name: string };
  credentials: {
    modifyRecord(key: string, update: (current?: Grant) => Promise<Grant | undefined>): Promise<Grant | undefined>;
  };
  tools: {
    register(tool: {
      name: string;
      description: string;
      parameters: Schema;
      output: { schema: Schema; render(args: unknown, result: unknown): { type: 'text'; text: string }[] };
      execute(args: unknown, execution: { signal: AbortSignal }): Promise<object>;
    }): void;
  };
  inject(keys: string[], callback: (ctx: {
    connection: {
      fetch: {
        register(route: {
          path: string;
          methods: ['POST'];
          requestBody: 'buffered';
          fetch(request: Request): Promise<Response>;
        }): void;
      };
    };
  }) => void): void;
}

const text = (description: string): Schema => ({ type: 'string', description });
const choices = (...values: string[]): Schema => ({ type: 'string', enum: values });
const object = (properties: Record<string, Schema>, required: string[]): Schema =>
  ({ type: 'object', properties, required, additionalProperties: false });
const outputSchema = { type: 'object', additionalProperties: true };

function record(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('茶室工具参数必须是对象。');
  return value as JsonObject;
}

function field(args: JsonObject, key: string, required: true): string;
function field(args: JsonObject, key: string, required?: false): string | undefined;
function field(args: JsonObject, key: string, required = false): string | undefined {
  const value = args[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`请提供有效的 ${key}。`);
  return value.trim();
}

function operation<T extends string>(args: JsonObject, allowed: readonly T[]): T {
  const value = allowed.find(op => op === args.op);
  if (value === undefined) throw new Error(`op 必须为 ${allowed.join('、')} 之一。`);
  return value;
}

function registerTools(ctx: DshContext, session: ParlorSession) {
  const register = (name: string, description: string, parameters: Schema,
    execute: (args: JsonObject, signal: AbortSignal) => Promise<object>) => {
    ctx.tools.register({
      name, description, parameters,
      output: { schema: outputSchema, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
      async execute(args, { signal }) {
        try {
          return await execute(record(args), signal);
        } catch (error) {
          if (error instanceof ParlorHttpError) throw new Error(`茶室 HTTP ${error.status}：${error.message}`);
          throw error;
        }
      },
    });
  };

  const roomOps = ['list', 'visit'] as const;
  register('parlor_room', '列出可见的普通客厅，或按客厅 ID 进入。大厅用于进场和选房，不能开桌。换厅前先离开未开局的桌，已开局则等结算。',
    object({ op: choices(...roomOps), room: text('visit 时必填，使用客厅 ID。') }, ['op']),
    (args, signal) => operation(args, roomOps) === 'list'
      ? session.rooms(signal)
      : session.visit(field(args, 'room', true), signal));

  const tableOps = ['open', 'join', 'start', 'leave'] as const;
  register('parlor_table', '在当前客厅开桌、坐下、开局或离开未开局的桌，返回操作回执。结算自动释放牌桌席位，可以在本厅开桌或入桌，换厅用 parlor_room visit。玩法 ID 和完整桌面用 parlor_game_info 读取。',
    object({
      op: choices(...tableOps),
      game: text('open 时必填的游戏 ID。'),
      table: text('join/start/leave 时必填的桌号。'),
      requestId: text('本次桌操作的唯一编号。回包丢失先查状态，确认需要重试时沿用原编号。'),
    }, ['op', 'requestId']),
    async (args, signal) => {
      const op = operation(args, tableOps);
      const requestId = field(args, 'requestId', true);
      const action = (op === 'open'
        ? { type: 'table_open', game: field(args, 'game', true) as Extract<ActionRequest, { type: 'table_open' }>['game'], requestId }
        : { type: `table_${op}`, table: field(args, 'table', true), requestId }) satisfies ActionRequest;
      const result = await session.action(action, signal);
      const { ok, seq, at, revision, closed, seats, deadline, deadlineAt, turn } = result;
      const receipt = {
        ok, seq, at, requestId: result.requestId ?? requestId,
        tableId: result.tableId ?? result.table?.id ?? result.table?.tableId ?? action.table,
        revision, closed, seats, deadline, deadlineAt, turn,
      };
      return Object.fromEntries(Object.entries(receipt).filter(([, value]) => value !== undefined));
    });

  const gameOps = ['list', 'describe', 'state', 'history'] as const;
  register('parlor_game_info', '读取当前客厅的游戏目录、动作参数、桌面及本人可用动作，或查看获准读取的历史。',
    object({
      op: choices(...gameOps),
      game: text('describe 时必填的游戏 ID。'),
      table: text('state/history 的桌号。state 省略时查看本人默认桌。'),
    }, ['op']), (args, signal) => {
      const op = operation(args, gameOps);
      const game = op === 'describe' ? field(args, 'game', true) : undefined;
      const table = op === 'history' ? field(args, 'table', true) : field(args, 'table');
      return session.games({ op, ...(game ? { game } : {}), ...(table ? { table } : {}) }, signal);
    });

  register('parlor_game_action', '提交本席当前的合法动作。按服务端说明传 revision 或 params.windowId；桌面版本或行动窗口过期时先重读桌面。',
    object({
      table: text('state 返回的桌号。'),
      action: text('state 返回的可用动作名。'),
      params: { type: 'object', additionalProperties: true, description: '按服务端返回的动作参数填写。' },
      revision: { type: 'integer', description: '严格回合使用 state 返回的非负桌面版本。' },
      requestId: text('本次动作的唯一编号。结果不明先查状态，确认要重试时沿用原编号。'),
    }, ['table', 'action', 'params', 'requestId']), (args, signal) => {
      const revision = args.revision as number | undefined;
      if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) {
        throw new Error('revision 必须为非负整数。');
      }
      return session.action({
        type: 'game_action',
        table: field(args, 'table', true),
        action: field(args, 'action', true),
        params: record(args.params),
        requestId: field(args, 'requestId', true),
        ...(revision === undefined ? {} : { revision }),
      }, signal);
    });
}

export function apply(ctx: DshContext, config: ParlorOptions = {}) {
  const session = new ParlorSession(config, {
    async update(change) {
      const record = await ctx.credentials.modifyRecord(recordKey, async current => {
        if (current && (current.kind !== 'grant' || !current.payload?.identity?.cooId || !current.payload.identity.cooSecret)) {
          throw new Error('茶室身份凭据格式不正确。');
        }
        const payload = change(current?.payload);
        return payload ? { kind: 'grant', payload } : undefined;
      });
      if (!record) throw new Error('无法读取茶室身份凭据。');
      return record.payload;
    },
  });
  const profile = ctx.profileContext.name;
  const scope = createHash('sha256').update(JSON.stringify([profile, session.serverUrl, session.identityUrl])).digest('hex');
  const recordKey = `${name}/profile-${scope}`;

  registerTools(ctx, session);
  ctx.inject(['connection'], ({ connection }) => {
    connection.fetch.register({
      path: PARENT_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const headers = { 'cache-control': 'no-store' };
        // Exact Connection routes already require a trusted owner Peer.
        // Require a non-simple request as well so a cross-site form cannot make one.
        if (request.headers.get('content-type') !== 'application/json') {
          return Response.json({ code: 'unsupported-request' }, { status: 415, headers });
        }
        try {
          const url = await session.parentLink(request.signal);
          return Response.json({ url }, { headers });
        } catch (error) {
          const missing = error instanceof ParentKeyUnavailable;
          return Response.json({ code: missing ? 'missing-parent-key' : 'unavailable' }, {
            status: missing ? 409 : 503, headers,
          });
        }
      },
    });
  });
}
