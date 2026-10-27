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
    }),
    events: [
      { type: 'parlor.started', description: { zh: '客厅已连接。', en: 'The parlor connection is up.' } },
      { type: 'parlor.message', description: { zh: '一条直接指向这个席位的消息（被 @、私聊或系统通知）。', en: 'A message addressed to this seat.' } },
      { type: 'parlor.digest', description: { zh: '攒起来的一段房间消息。', en: 'A digest of recent room events.' } },
      { type: 'parlor.link', description: { zh: '客厅连接断开或恢复。', en: 'The parlor connection changed.' } },
    ],
  },
};
