import { GAME_PRESENTATION } from '../game-labels.ts';
import type { GameDefinition } from './registry.ts';
import { MAHJONG_GAMES, MAHJONG_RULES, isTile, tileKinds, type MahjongGame } from './mahjong-rules.ts';
import { MAHJONG_ACTIONS, MahjongTable } from './mahjong-table.ts';

function definition(game: MahjongGame): GameDefinition {
  const type = game + '_action';
  const kinds = tileKinds(game);
  const actions = MAHJONG_ACTIONS.filter(action => game === 'mahjong-sichuan'
    || (action !== 'exchange' && action !== 'missing'));
  const tile = { type: 'integer', minimum: 0, maximum: kinds - 1 };
  const parse = (args: Record<string, unknown>) => {
    const { action, windowId, tile, tiles, suit } = args;
    if (typeof windowId !== 'string' || !/^m[1-9]\d{0,10}$/.test(windowId)) throw new Error('请带上当前 windowId');
    if (!actions.some(name => name === action)) throw new Error('未知麻将动作');
    const expected = action === 'exchange' ? 'tiles' : action === 'missing' ? 'suit' : action === 'discard' ? 'tile' : null;
    if ((expected !== 'tiles' && tiles !== undefined) || (expected !== 'suit' && suit !== undefined)
      || (expected !== 'tile' && action !== 'kong' && tile !== undefined)) throw new Error('动作带了多余的牌或花色参数');
    if (action === 'exchange') {
      if (!Array.isArray(tiles) || tiles.length !== 3 || !tiles.every(t => isTile(t, kinds))) throw new Error('exchange 需要三个牌号');
      return { action, windowId, tiles };
    }
    if (action === 'missing') {
      if (suit !== 0 && suit !== 1 && suit !== 2) throw new Error('missing 需要花色 0、1 或 2');
      return { action, windowId, suit };
    }
    if ((action === 'discard' || tile !== undefined) && !isTile(tile, kinds)) throw new Error('牌号超出本玩法范围');
    return { action, windowId, ...(tile !== undefined ? { tile } : {}) };
  };
  return {
    id: game, rated: false, ...GAME_PRESENTATION[game],
    openHint: '四席坐满开局。牌河公开，手牌、可用动作和提示见本人桌面。',
    rules: MAHJONG_RULES[game],
    create: ({ host, turnMs, firstSeat }) => new MahjongTable(game, host, turnMs, firstSeat),
    randomizeFirstSeat: true,
    actionType: type,
    actionKey: 'action',
    revisionMode: 'window',
    toAction: parse,
    availableActions: view => Array.isArray(view.actions) ? view.actions : [],
    action: {
      description: '所有动作带 windowId。exchange 传三张同门牌号 tiles；missing 传 suit（0 万、1 筒、2 条）；discard 或手内 kong 传 tile；响应弃牌的 pung、kong、hu、pass 只传 windowId。牌号 0–26 为万、筒、条各 1–9；27–33 为东南西北中发白。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', enum: actions }, windowId: { type: 'string', maxLength: 12 },
          tile, tiles: { type: 'array', items: tile }, suit: { type: 'integer', minimum: 0, maximum: 2 },
        },
        required: ['action', 'windowId'],
      },
      toBody: args => ({ type, ...parse(args) }),
      done: () => '麻将动作已提交。',
    },
  };
}

export const MAHJONG_DEFINITIONS = MAHJONG_GAMES.map(definition);
