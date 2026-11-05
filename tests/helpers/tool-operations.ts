/** 既有业务用例的迁移适配：所有调用实际进入九个新工具，不注册或绕过旧工具。 */
import type { ToolDef, World } from 'cortico/core/types.ts';

const operations: Record<string, [string, string]> = {
  parlor_look: ['parlor_query', 'room'], parlor_rooms: ['parlor_query', 'rooms'],
  parlor_mail: ['parlor_query', 'mail'], parlor_ledger: ['parlor_query', 'account'],
  parlor_replay: ['parlor_query', 'history'], parlor_announcements: ['parlor_query', 'announcements'],
  parlor_table_view: ['parlor_query', 'table'],
  parlor_room_create: ['parlor_room', 'create'], parlor_room_visit: ['parlor_room', 'visit'],
  parlor_invite: ['parlor_room', 'invite'], parlor_invite_accept: ['parlor_room', 'accept'], parlor_invite_decline: ['parlor_room', 'decline'],
  parlor_table_open: ['parlor_table', 'open'], parlor_table_join: ['parlor_table', 'join'],
  parlor_table_start: ['parlor_table', 'start'], parlor_table_leave: ['parlor_table', 'leave'],
  parlor_table_discovery: ['parlor_table', 'discovery'], parlor_monopoly: ['parlor_table', 'legacy_monopoly'],
};
const games: Record<string, [string, string | null]> = {
  parlor_table_action: ['dice', 'action'], parlor_ddz_action: ['ddz', 'move'],
  parlor_werewolf_action: ['werewolf', 'move'], parlor_monopoly2d_action: ['monopoly2d', 'move'],
  parlor_gomoku_action: ['gomoku', null],
};
export function toolForOperation(world: World, name: string): ToolDef {
  const tools = world.tools();
  const selected = (target: string, convert: (args: Record<string, unknown>) => Record<string, unknown>): ToolDef => {
    const tool = tools.find(entry => entry.name === target);
    if (!tool) throw new Error(`缺少新工具 ${target}`);
    return { ...tool, handler: (args, ctx) => tool.handler(convert(args), ctx) };
  };
  if (operations[name]) {
    const [target, op] = operations[name];
    return selected(target, args => ({ op, params: args }));
  }
  if (['parlor_say', 'parlor_whisper', 'parlor_table_say'].includes(name)) {
    const scope = name === 'parlor_say' ? 'room' : name === 'parlor_whisper' ? 'private' : 'table';
    return selected('parlor_message', args => ({ ...args, scope }));
  }
  if (games[name]) {
    const [game, key] = games[name];
    return selected('parlor_game_action', args => {
      const { table, revision, requestId, ...params } = args;
      const action = key ? params[key] : 'place';
      if (key) delete params[key];
      return { game, action, params, ...(table !== undefined ? { table } : {}),
        ...(revision !== undefined ? { revision } : {}), ...(requestId !== undefined ? { requestId } : {}) };
    });
  }
  if (name === 'parlor_werewolf_log') return selected('parlor_game_info', args => ({ ...args, op: 'history' }));
  const tool = tools.find(entry => entry.name === name);
  if (!tool) throw new Error(`未知工具 ${name}`);
  return tool;
}
