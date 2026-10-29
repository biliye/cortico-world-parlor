/**
 * 牌桌注册表：新增一张桌子只登记一条。这里盯住「三处确实都从同一份清单来」，
 * 免得以后加游戏时又回到 World/server/web 各写一份。
 */
import { describe, expect, it } from 'vitest';
import {
  GAME_LIST, gameByActionType, gameById, gameIds, gameLabelOf,
} from '../src/room/games/registry.ts';
import { PARLOR_TOOL_DECLS } from '../src/world.ts';

describe('牌桌注册表', () => {
  it('每个游戏一条登记，id / 动作类型 / 工具名不撞', () => {
    const ids = GAME_LIST.map((game) => game.id);
    const actions = GAME_LIST.map((game) => game.actionType);
    const tools = GAME_LIST.map((game) => game.tool.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(actions).size).toBe(actions.length);
    expect(new Set(tools).size).toBe(tools.length);
    for (const game of GAME_LIST) {
      expect(game.label.length).toBeGreaterThan(0);
      expect(game.icon.length).toBeGreaterThan(0);
      expect(game.openHint.length).toBeGreaterThan(0);
      expect(game.tool.parameters.type).toBe('object');
    }
  });

  it('create() 造出来的引擎与登记一致，标签也一致', () => {
    for (const game of GAME_LIST) {
      const engine = game.create({ host: { id: 'seat-1', name: '测试' }, now: 1_000 });
      expect(engine.game).toBe(game.id);
      expect(engine.label).toBe(game.label);
      expect(engine.seatIds()).toEqual(['seat-1']);
    }
  });

  it('动作类型能来回查，工具参数能翻成 /v1/action body', () => {
    for (const game of GAME_LIST) {
      expect(gameById(game.id)).toBe(game);
      expect(gameByActionType(game.actionType)).toBe(game);
      expect(gameLabelOf(game.id)).toBe(game.label);
    }
    expect(gameById('nope')).toBeNull();
    expect(gameByActionType('ddz_action')?.id).toBe('ddz');
    expect(gameByActionType('table_action')?.id).toBe('dice');

    const ddz = gameById('ddz')!;
    expect(ddz.tool.toBody({ move: 'bid', call: true }))
      .toEqual({ type: 'ddz_action', move: 'bid', call: true });
    expect(ddz.tool.toBody({ move: 'play', cards: ['3', '3'] }))
      .toEqual({ type: 'ddz_action', move: 'play', cards: ['3', '3'] });
    expect(ddz.tool.done({ move: 'bid', call: true })).toContain('地主');
    expect(() => ddz.tool.toBody({ move: 'play', cards: [] })).toThrow(/cards/);

    const dice = gameById('dice')!;
    expect(dice.tool.toBody({ action: 'roll', die: 1 }))
      .toEqual({ type: 'table_action', action: 'roll', die: 1 });
    expect(dice.tool.done({ action: 'stand' })).toContain('停牌');
    expect(() => dice.tool.toBody({ action: 'nope' })).toThrow(/roll/);
  });

  it('World 的工具声明与开桌枚举都来自注册表', () => {
    const names = new Set(PARLOR_TOOL_DECLS.map((decl) => decl.name));
    for (const game of GAME_LIST) expect(names.has(game.tool.name)).toBe(true);
    // 工具声明里的描述/参数就是注册表里的那一份（不再抄一遍）。
    for (const game of GAME_LIST) {
      const decl = PARLOR_TOOL_DECLS.find((entry) => entry.name === game.tool.name)!;
      expect(decl.description).toBe(game.tool.description);
      expect(decl.parameters).toEqual(game.tool.parameters);
    }
    const open = PARLOR_TOOL_DECLS.find((decl) => decl.name === 'parlor_table_open')!;
    const game = (open.parameters as { properties?: { game?: { enum?: string[] } } }).properties?.game;
    expect(game?.enum).toEqual(gameIds());
  });
});
