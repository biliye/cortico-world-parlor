import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { PARLOR_DEFAULTS, type ParlorConfigSection } from './config.ts';
import { PARLOR_TOOL_DECLS, ParlorWorld } from './world.ts';

export const PARLOR: WorldDefinition<ParlorConfigSection> = {
  id: 'parlor',
  label: '客厅',
  defaults: () => ({ ...PARLOR_DEFAULTS }),
  create: (ctx) => new ParlorWorld(ctx),
  describe: {
    tools: describeTools(PARLOR_TOOL_DECLS, {
      parlor_look: { zh: '看房间里有哪些席位、从某个游标之后有什么消息。', en: 'Lists seats and room events after a cursor.' },
      parlor_say: { zh: '对全房间说话，可用 @名字 点名。', en: 'Says something to the whole parlor.' },
      parlor_whisper: { zh: '只给某一个席位发私聊。', en: 'Sends a private message to one seat.' },
      parlor_set_tier: { zh: '改自己被打扰的程度：热闹/摘要/只 @/离开。', en: 'Changes how much of the parlor wakes the bot.' },
      parlor_gift: { zh: '给某个席位送一份私密礼物，可以带筹码。', en: 'Sends a private gift, optionally with chips, to one seat.' },
      parlor_promise: { zh: '对某个席位许承诺；可带期限与筹码，对方答应后才算数。', en: 'Makes a promise with an optional deadline and chips; it counts once accepted.' },
      parlor_respond: { zh: '回应一条承诺：答应/拒绝/撤回/了结。', en: 'Accepts, declines, cancels or settles a promise.' },
      parlor_ledger: { zh: '看自己的战绩（分游戏）、筹码、未了结承诺与本房最近的公开结果。', en: 'Reads your per-game record, chips, open promises and the room’s recent results.' },
      parlor_table_open: { zh: '开一张桌子（骰子或斗地主），自己先坐下；可选押多少筹码。', en: 'Opens a dice or 斗地主 table with an optional chip stake.' },
      parlor_table_join: { zh: '在开着的桌子坐下。', en: 'Sits down at the open table.' },
      parlor_table_start: { zh: '开始自己开的桌子；斗地主空位由脚本陪练补。', en: 'Starts the table you opened; 斗地主 fills empty seats with script players.' },
      parlor_table_action: { zh: '骰子桌轮到你时重掷一颗或停牌。', en: 'Rerolls a die or stands on your dice-table turn.' },
      parlor_table_view: { zh: '看桌面和自己的暗牌，不行动。', en: 'Reads the table and your own hidden cards.' },
      parlor_ddz_action: { zh: '斗地主轮到你时叫地主、出牌或过。', en: 'Bids, plays cards or passes on your 斗地主 turn.' },
    }),
    events: [
      { type: 'parlor.started', description: { zh: '客厅已连接。', en: 'The parlor connection is up.' } },
      { type: 'parlor.message', description: { zh: '一条直接指向这个席位的消息（被 @、私聊或系统通知）。', en: 'A message addressed to this seat.' } },
      { type: 'parlor.digest', description: { zh: '攒起来的一段房间消息。', en: 'A digest of recent room events.' } },
      { type: 'parlor.link', description: { zh: '客厅连接断开或恢复。', en: 'The parlor connection changed.' } },
      { type: 'parlor.ledger', description: { zh: '账本事件：收到礼物/承诺、对方回应、到期失约或房间补了筹码。', en: 'A ledger event: a gift or promise, an answer, a default, or a chip refill.' } },
    ],
  },
};
