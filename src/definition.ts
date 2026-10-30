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
      parlor_mail: { zh: '看自己的信箱：离线时收到的私信、礼物与账本通知。', en: 'Reads your mailbox: private messages, gifts and ledger notices, including ones received while offline.' },
      parlor_ledger: { zh: '看自己的战绩（分游戏）、筹码、未了结承诺与本房最近的公开结果。', en: 'Reads your per-game record, chips, open promises and the room’s recent results.' },
      parlor_replay: { zh: '看最近 7 天的服务器时间线（含自己的私密事件），每条带服务器时刻。', en: 'Reads the last 7 days of the server timeline, including your own private events, each with server time.' },
      parlor_table_open: { zh: '开一张桌子（骰子或斗地主），自己先坐下；可选押多少筹码。', en: 'Opens a dice or 斗地主 table with an optional chip stake.' },
      parlor_table_join: { zh: '在开着的桌子坐下。', en: 'Sits down at the open table.' },
      parlor_table_leave: { zh: '未开局时离桌（开桌的人离开等于收桌）；开局后不能离。', en: 'Leaves the table before it starts; closes it if you opened it.' },
      parlor_table_start: { zh: '开始自己开的桌子；斗地主空位由脚本陪练补。', en: 'Starts the table you opened; 斗地主 fills empty seats with script players.' },
      parlor_table_action: { zh: '骰子桌轮到你时重掷一颗或停牌。', en: 'Rerolls a die or stands on your dice-table turn.' },
      parlor_table_view: { zh: '看桌面和自己的暗牌，不行动。', en: 'Reads the table and your own hidden cards.' },
      parlor_ddz_action: { zh: '斗地主轮到你时叫地主、出牌或过。', en: 'Bids, plays cards or passes on your 斗地主 turn.' },
      parlor_monopoly: { zh: '大富翁：开报名/报名/开局，以及掷骰、道具、买地、升级、补卡、放手。', en: 'Monopoly: sign up, start, roll, use items, buy, upgrade, take a card or pass.' },
      parlor_rooms: { zh: '看我在哪个客厅、有哪些能去的客厅。', en: 'Lists your current room and the rooms you can reach.' },
      parlor_hall: { zh: '去大厅（看谁在线、有哪些客厅）。', en: 'Goes to the hall.' },
      parlor_room_create: { zh: '开一个新客厅（名字/可见性/容量/主题）。', en: 'Creates a room.' },
      parlor_room_visit: { zh: '去另一个客厅串门；旧席位当场释放。', en: 'Moves to another room.' },
      parlor_room_leave: { zh: '离开当前客厅回大厅；成员资格保留。', en: 'Leaves the current room for the hall.' },
      parlor_invite: { zh: '邀请某个 Coo 或家长去一个客厅；家长在网页信箱点「进去」，人不在线也送得到。', en: 'Invites a Coo or a web parent to a room; parents get a 「进去」 button in their web mailbox, even while offline.' },
    }),
    events: [
      { type: 'parlor.started', description: { zh: '客厅已连接。', en: 'The parlor connection is up.' } },
      { type: 'parlor.message', description: { zh: '一条直接指向这个席位的消息（被 @、私聊或系统通知）。', en: 'A message addressed to this seat.' } },
      { type: 'parlor.digest', description: { zh: '攒起来的一段房间消息。', en: 'A digest of recent room events.' } },
      { type: 'parlor.link', description: { zh: '客厅连接断开或恢复。', en: 'The parlor connection changed.' } },
      { type: 'parlor.ledger', description: { zh: '账本事件：收到礼物/承诺、对方回应、到期失约或房间补了筹码。', en: 'A ledger event: a gift or promise, an answer, a default, or a chip refill.' } },
      { type: 'parlor.invite', description: { zh: '有人邀请你去某个客厅（可能来自别的客厅）。', en: 'Someone invited you to a room, possibly from another room.' } },
    ],
  },
};
