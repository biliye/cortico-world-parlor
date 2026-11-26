import { GAME_PRESENTATION } from '../game-labels.ts';
import type { GameDefinition } from './registry.ts';
import { FOUR_COLOURS, FOUR_COLOUR_RULES, isFourColour } from './four-colour-rules.ts';
import { FourColourTable } from './four-colour-table.ts';

const actionType = 'four-colour_action';

export const FOUR_COLOUR_DEFINITION: GameDefinition = {
  id: 'four-colour',
  ...GAME_PRESENTATION['four-colour'],
  rated: false,
  openHint: '2–4 人，由桌主开局。按颜色或点数接牌，先出完手牌者赢。',
  rules: FOUR_COLOUR_RULES,
  create: ({ host, turnMs }) => new FourColourTable(host, turnMs),
  actionType,
  actionKey: 'action',
  revisionMode: 'strict',
  attachPrivateOnAct: true,
  toAction: ({ action, card, colour }) => ({ action, card, colour }),
  availableActions: view => Array.isArray(view.actions) ? view.actions : [],
  action: {
    description: '四彩牌轮到你时摸牌（draw）、出牌（play）或摸牌后结束回合（pass）。出牌给出本人桌面里的 card 编号，变色牌还要选择 colour。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['draw', 'play', 'pass'] },
        card: { type: 'integer', minimum: 0, description: 'play 时给出本人桌面里的牌 id。' },
        colour: { type: 'string', enum: FOUR_COLOURS, description: '只在出变色牌时指定颜色。' },
      },
      required: ['action'],
    },
    toBody: ({ action, card, colour }) => {
      if ((action === 'draw' || action === 'pass') && card === undefined && colour === undefined) return { type: actionType, action };
      if (action === 'play' && typeof card === 'number' && Number.isSafeInteger(card) && card >= 0
        && (colour === undefined || isFourColour(colour))) {
        return { type: actionType, action, card, ...(colour === undefined ? {} : { colour }) };
      }
      throw new Error('draw 和 pass 不带参数；play 要填手牌 id（card），变色牌还要填 colour。');
    },
    done: body => ({ play: '出了一张牌。', draw: '摸了一张牌。', pass: '结束了回合。' })[String(body.action)] ?? '四彩牌动作已完成。',
  },
};
