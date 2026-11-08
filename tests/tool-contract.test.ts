import { describe, expect, it } from 'vitest';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { PARLOR } from '../src/definition.ts';

const world = () => PARLOR.create(fakeWorldContext(PARLOR, { scratchDir: '.' }));
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await world().tools().find(tool => tool.name === name)!.handler(args, {} as never);
  return typeof result === 'string' ? result : result.text;
};
describe('固定九工具与按需参数', () => {
  it('公开注册只有九个入口，没有任何旧工具别名', () => {
    const tools = world().tools();
    expect(tools.map(tool => tool.name).sort()).toEqual([
      'parlor_query', 'parlor_message', 'parlor_room', 'parlor_table',
      'parlor_game_info', 'parlor_game_action', 'parlor_gift', 'parlor_set_tier', 'parlor_feedback',
    ].sort());
    expect(tools.filter(tool => tool.tags?.includes('read')).map(tool => tool.name).sort()).toEqual(['parlor_game_info', 'parlor_query']);
  });
  it('未连接时也能按需取得开桌和邀请参数，不把全部参数常驻', async () => {
    const table = JSON.parse(await call('parlor_query', { op: 'help', params: { topic: 'table' } }));
    expect(Object.keys(table)).toEqual(['table']);
    expect(table.table.find((entry: { op: string }) => entry.op === 'open').parameters.properties.game).toMatchObject({ type: 'string' });
    const room = JSON.parse(await call('parlor_query', { op: 'help', params: { topic: 'room' } }));
    expect(room.room.find((entry: { op: string }) => entry.op === 'accept').parameters.required).toEqual(['id']);
    const message = JSON.parse(await call('parlor_query', { op: 'help', params: { topic: 'message' } }));
    expect(message.message.find((entry: { op: string }) => entry.op === 'private')).toMatchObject({ selector: 'scope', parameters: { required: ['to', 'text'] } });
    expect(JSON.stringify(room)).not.toMatch(/parlor_room_visit|parlor_mail/);
    expect(JSON.stringify(world().tools().map(({ handler, ...decl }) => decl))).not.toContain('target_player_count');
  });
  it.each([
    ['parlor_message', { scope: 'private', text: '秘密' }, 'to'],
    ['parlor_message', { scope: 'room', to: '某人', text: '秘密' }, 'to'],
    ['parlor_message', { scope: 'table', to: '某人', text: '秘密' }, 'to'],
    ['parlor_message', { text: '没有选择范围' }, 'scope'],
    ['parlor_query', { op: 'feedback', params: { text: '读取不能提交' } }, 'text'],
    ['parlor_query', { op: 'account', params: { chips: 100 } }, 'chips'],
    ['parlor_feedback', { text: '   ' }, 'text'],
    ['parlor_room', { op: 'visit', params: { to: '另一个厅' } }, 'room'],
    ['parlor_table', { op: 'join', params: { url: 'https://other.example' } }, 'url'],
    ['parlor_table', { op: 'constructor' }, 'op'],
    ['parlor_gift', { op: 'send', params: { to: '某人', item: 'longjing', chips: '100' } }, 'chips'],
  ])('错误参数不调用业务操作：%s %j', async (name, args, field) => {
    expect(await call(name, args)).toContain(field);
  });
});
