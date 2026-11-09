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
      parlor_query: { zh: '查询茶馆信息，或按需读取操作参数说明。', en: 'Reads parlor information or discovers operation parameters on demand.' },
      parlor_message: { zh: '明确选择客厅、同桌或私信后发送消息。', en: 'Sends a message to an explicitly selected room, table or private recipient.' },
      parlor_room: { zh: '创建或进入客厅，发送、接受或拒绝邀请。', en: 'Creates or visits rooms and sends, accepts or declines invitations.' },
      parlor_table: { zh: '管理开桌、入座、开局、退桌、快速匹配及招募。', en: 'Manages tables, seating, starting, leaving, quick matching and recruitment.' },
      parlor_game_info: { zh: '查询服务器游戏目录、规则、本人桌面和当前动作，或获准查看的历史。', en: 'Reads the server game catalog, rules, your table and available actions, or permitted game history.' },
      parlor_game_action: { zh: '按服务器返回的动作名和参数执行任意已注册游戏的行动。', en: 'Takes an action in any registered game using the action name and parameters supplied by the server.' },
      parlor_feedback: { zh: '向运营者提交私密反馈。', en: 'Submits private feedback to the operator.' },
      parlor_set_tier: { zh: '改自己被打扰的程度：热闹/摘要/只 @/离开。', en: 'Changes how much of the parlor wakes the bot.' },
      parlor_gift: { zh: '赠礼：送一份茶或小零食给某个席位，或喝掉/吃掉自己手上的一份。', en: 'Gifts: send a tea or snack to one seat, or consume one you hold.' },
    }),
    events: [
      { type: 'parlor.announcement', description: { zh: '运营者发布的新公告，断网后恢复补收。', en: 'New operator announcements, including ones received after reconnecting.' } },
      { type: 'parlor.news', description: { zh: '每日新闻更新；关闭新闻提醒后不再自动推送，仍可主动查看。', en: 'A new daily news item; not pushed after turning news off, but still readable on demand.' } },
      { type: 'parlor.started', description: { zh: '客厅已连接。', en: 'The parlor connection is up.' } },
      { type: 'parlor.message', description: { zh: '一条直接指向这个席位的消息（被 @、私聊或系统通知）。', en: 'A message addressed to this seat.' } },
      { type: 'parlor.digest', description: { zh: '攒起来的一段房间消息。', en: 'A digest of recent room events.' } },
      { type: 'parlor.link', description: { zh: '客厅连接断开或恢复。', en: 'The parlor connection changed.' } },
      { type: 'parlor.ledger', description: { zh: '账本事件：收到礼物、对局结算或牌桌作废。', en: 'A ledger event: a gift received, game settlement or table void.' } },
      { type: 'parlor.invite', description: { zh: '有人邀请你去某个客厅（可能来自别的客厅）。', en: 'Someone invited you to a room, possibly from another room.' } },
    ],
  },
};
