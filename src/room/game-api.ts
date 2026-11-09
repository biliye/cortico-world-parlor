/** 通用游戏协议 v1。只处理协议与参数，行动合法性仍由事务里的游戏引擎决定。 */
import { GAME_LIST, type GameDefinition } from './games/registry.ts';
import type { TableLogQuery, TablePrivateSummary, TableSummary } from './table-engine.ts';

type Schema = Record<string, unknown>;
export type GameQueryOp = 'list' | 'describe' | 'state' | 'history' | 'replay' | 'replayStep';
export interface GameQuery extends TableLogQuery {
  op?: GameQueryOp;
  game?: string;
  table?: string;
  before?: number;
  seq?: number;
}

export const GAME_ACTION_SCHEMA: Schema = {
  type: 'object', additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['game_action'] },
    table: { type: 'string', minLength: 1 },
    action: { type: 'string', minLength: 1 },
    params: { type: 'object' },
    revision: { type: 'integer', minimum: 0 },
    requestId: { type: 'string', minLength: 1, maxLength: 100 },
  },
  required: ['type', 'table', 'action', 'params', 'requestId'],
};

/** 支持本协议使用的 JSON Schema 基础子集；不做字符串/数字等隐式转换。 */
export function validateParameters(schema: Schema, value: unknown, path = 'params'): void {
  const fail = (reason: string): never => { throw new Error(`${path}: ${reason}`); };
  if (schema.enum && !(schema.enum as unknown[]).some(entry => entry === value)) fail('不在允许值内');
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('必须是 JSON 对象');
      const record = value as Record<string, unknown>;
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      for (const key of (schema.required ?? []) as string[]) {
        if (!Object.hasOwn(record, key)) fail(`缺少 ${key}`);
      }
      for (const [key, entry] of Object.entries(record)) {
        if (Object.hasOwn(properties, key)) validateParameters(properties[key], entry, `${path}.${key}`);
        else if (schema.additionalProperties === false) fail(`不允许字段 ${key}`);
      }
      break;
    }
    case 'string':
      if (typeof value !== 'string') fail('必须是字符串');
      if (typeof schema.minLength === 'number' && (value as string).trim().length < schema.minLength) fail('字符串太短');
      if (typeof schema.maxLength === 'number' && (value as string).length > schema.maxLength) fail('字符串太长');
      break;
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)
        || (schema.type === 'integer' && !Number.isSafeInteger(value))) fail('必须是有效数字（integer 要求安全整数）');
      if (typeof schema.minimum === 'number' && (value as number) < schema.minimum) fail(`不能小于 ${schema.minimum}`);
      if (typeof schema.maximum === 'number' && (value as number) > schema.maximum) fail(`不能大于 ${schema.maximum}`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') fail('必须是布尔值');
      break;
    case 'array':
      if (!Array.isArray(value)) fail('必须是数组');
      if (schema.items) (value as unknown[]).forEach((entry, index) => validateParameters(schema.items as Schema, entry, `${path}[${index}]`));
      break;
  }
}

/** 动作名从注册表里的判别字段取；单动作游戏显式命名，不需要工具名。 */
export function gameActions(game: GameDefinition) {
  const schema = game.action.parameters;
  const properties = { ...(schema.properties as Record<string, Schema>) };
  const names = game.actionKey
    ? properties[game.actionKey]?.enum as string[]
    : [game.singleAction!];
  if (!names?.length || names.some(name => typeof name !== 'string' || !name)) {
    throw new Error(`游戏 ${game.id} 没有声明动作名`);
  }
  if (game.actionKey) delete properties[game.actionKey];
  const parameters = {
    ...schema, properties,
    required: ((schema.required ?? []) as string[]).filter(key => key !== game.actionKey),
  };
  return names.map(action => ({ action, description: game.action.description, parameters }));
}

export function describeGame(game: GameDefinition) {
  return {
    id: game.id, label: game.label, icon: game.icon,
    rules: game.rules, openHint: game.openHint,
    revisionMode: game.revisionMode,
    actions: gameActions(game),
  };
}

export const gameCatalog = () => GAME_LIST.map(game => ({
  id: game.id, label: game.label, icon: game.icon,
}));

/** 只接收调用者自己的私视图；查询其他桌时不夹带本人另一桌的秘密。 */
export function gameState(
  game: GameDefinition,
  table: TableSummary,
  ownView: TablePrivateSummary | null,
) {
  const tableId = table.id ?? table.tableId;
  const view = tableId && ownView?.tableId === tableId && ownView.game === game.id ? ownView : null;
  const allowed = view && !table.frozen && table.status !== 'ended' ? game.availableActions(view) : [];
  const availableActions = gameActions(game).filter(entry => allowed.includes(entry.action)).map(entry => ({
    ...entry,
    defaults: Object.fromEntries(Object.keys(entry.parameters.properties)
      .filter(key => view && Object.hasOwn(view, key) && ['windowId', 'turnNo'].includes(key))
      .map(key => [key, view![key]])),
  }));
  return {
    game: { id: game.id, label: game.label, revisionMode: game.revisionMode },
    table, tablePrivate: view, availableActions,
  };
}

/** Also applied in the World when talking to servers that still return full snapshots. */
export function compactGameState(state: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = { ...state };
  const game = state.game as ReturnType<typeof describeGame> | undefined;
  if (game?.id) output.game = { id: game.id, label: game.label, revisionMode: game.revisionMode };
  if (Array.isArray(state.tables)) {
    output.tables = state.tables.map(({ id, tableId, game, label, status, host, revision, capacity, frozen }: TableSummary) => ({
      id, tableId, game, label, status, host, revision, capacity, frozen,
    }));
  }
  const table = state.table as TableSummary | null | undefined;
  if (table?.game !== 'werewolf') return output;

  const { speeches, votes, ...publicView } = table;
  const allSpeeches = Array.isArray(speeches) ? speeches as Array<{ day: number }> : [];
  const current = allSpeeches.filter(entry => entry.day === table.day);
  const preview = current.slice(-4);
  while (Buffer.byteLength(JSON.stringify(preview)) > 3 * 1024) preview.shift();
  const lastVotes = Array.isArray(votes) ? votes.at(-1) : table.lastVotes;
  output.table = {
    ...publicView, speeches: preview,
    ...(lastVotes === undefined ? {} : { lastVotes }),
    hasMoreHistory: table.hasMoreHistory === true || allSpeeches.length > preview.length
      || (Array.isArray(votes) && votes.length > 1),
  };
  const view = state.tablePrivate as TablePrivateSummary | null | undefined;
  if (view?.game === 'werewolf') {
    // The public preview is already present, and the private text repeats it verbatim.
    const { speeches: _speeches, lastVotes: _votes, deaths: _deaths, seats: _seats, text, ...privateView } = view;
    output.tablePrivate = {
      ...privateView,
      ...(view.status === 'open' ? { text } : {}),
    };
  }
  return output;
}

export function gameActionBody(game: GameDefinition, action: string, params: unknown): Record<string, unknown> {
  const decl = gameActions(game).find(entry => entry.action === action);
  if (!decl) throw new Error(`未知动作 ${action}；先查询游戏动作说明`);
  validateParameters(decl.parameters, params);
  const args = { ...(params as Record<string, unknown>), ...(game.actionKey ? { [game.actionKey]: action } : {}) };
  return game.action.toBody(args);
}
