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
  toAction: ({ action, card, colour, call }) => ({ action, card, colour, ...(call === undefined ? {} : { call }) }),
  availableActions: view => Array.isArray(view.actions) ? view.actions : [],
  action: {
    description: '轮到你时可摸牌（draw）、出牌（play）或摸牌后结束回合（pass）。出到只剩一张时必须由本人喊牌（call），超时罚摸两张。也可在 play 加 call:true 随出牌一起喊。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['draw', 'play', 'pass', 'call'] },
        card: { type: 'integer', minimum: 0, description: 'play 时给出本人桌面里的牌 id。' },
        colour: { type: 'string', enum: FOUR_COLOURS, description: '只在出变色牌时指定颜色。' },
        call: { type: 'boolean', description: 'play 后恰好只剩一张时可填 true 一起喊牌。' },
      },
      required: ['action'],
    },
    toBody: ({ action, card, colour, call }) => {
      if ((action === 'draw' || action === 'pass' || action === 'call')
        && card === undefined && colour === undefined && call === undefined) return { type: actionType, action };
      if (action === 'play' && typeof card === 'number' && Number.isSafeInteger(card) && card >= 0
        && (colour === undefined || isFourColour(colour)) && (call === undefined || typeof call === 'boolean')) {
        return { type: actionType, action, card, ...(colour === undefined ? {} : { colour }), ...(call === undefined ? {} : { call }) };
      }
      throw new Error('draw、pass、call 不带参数；play 要填手牌 id（card），变色牌还要填 colour，可用 call:true 一起喊牌。');
    },
    done: body => ({ play: body.call === true ? '出了一张牌并喊牌。' : '出了一张牌。', draw: '摸了一张牌。', pass: '结束了回合。',
      call: '喊牌了。' })[String(body.action)] ?? '四彩牌动作已完成。',
  },
};
