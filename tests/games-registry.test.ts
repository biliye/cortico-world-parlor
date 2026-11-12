import { describe, expect, it, vi } from 'vitest';
import { GAME_PRESENTATION, gameLabelOf as historyGameLabelOf } from '../src/room/game-labels.ts';
import {
  GAME_LIST, gameByActionType, gameById, gameIds, gameLabelOf,
} from '../src/room/games/registry.ts';
import { PARLOR_TOOL_DECLS } from '../src/world.ts';
import { operationHelp } from '../src/tool-contract.ts';
import { GAMES } from '../web-src/lib/games.ts';

// 检查真实组件注册表的接线，SFC 的编译由 build:web 验证。
vi.mock('../web-src/components/games/DdzGame.vue', () => ({ default: {} }));
vi.mock('../web-src/components/games/WerewolfGame.vue', () => ({ default: {} }));

describe('牌桌注册表', () => {
  it('每个游戏一条登记，id / 动作类型 / 工具名不撞', () => {
    const ids = GAME_LIST.map((game) => game.id);
    const actions = GAME_LIST.map((game) => game.actionType);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(actions).size).toBe(actions.length);

    for (const game of GAME_LIST) {
      expect(game.label.length).toBeGreaterThan(0);
      expect(game.icon.length).toBeGreaterThan(0);
      expect(game.openHint.length).toBeGreaterThan(0);
      expect(game.action.parameters.type).toBe('object');
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

  it('服务端登记、网页目录和桌面渲染一一对应，旧长局可查看', async () => {
    // 网页模块在 Vitest 中加载，服务端 tsc 仍使用无 DOM 的配置。
    const { componentFor } = await vi.importActual<{ componentFor(game: string): unknown }>(
      '../web-src/lib/game-components.ts',
    );
    const { mountFor } = await vi.importActual<{ mountFor(game: string): unknown }>(
      '../web-src/lib/legacy-games.ts',
    );
    expect(Object.keys(GAME_PRESENTATION).sort()).toEqual(gameIds().sort());
    expect(Object.keys(GAMES).sort()).toEqual([...gameIds(), 'monopoly'].sort());
    for (const { id, label, icon } of GAME_LIST) {
      expect(GAMES[id], id).toMatchObject({ label, icon });
      expect(historyGameLabelOf(id), id).toBe(label);
      expect(Boolean(componentFor(id)) !== Boolean(mountFor(id)), id).toBe(true);
    }
    expect(GAMES.monopoly.enabled).toBe(false);
    expect(componentFor('monopoly')).toBeNull();
    expect(mountFor('monopoly')).toBeTypeOf('function');
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
    expect(ddz.action.toBody({ move: 'bid', call: true }))
      .toEqual({ type: 'ddz_action', move: 'bid', call: true });
    expect(ddz.action.toBody({ move: 'play', cards: ['3', '3'] }))
      .toEqual({ type: 'ddz_action', move: 'play', cards: ['3', '3'] });
    expect(ddz.action.done({ move: 'bid', call: true })).toContain('地主');
    expect(() => ddz.action.toBody({ move: 'play', cards: [] })).toThrow(/cards/);

    const dice = gameById('dice')!;
    expect(dice.action.toBody({ action: 'roll', die: 1 }))
      .toEqual({ type: 'table_action', action: 'roll', die: 1 });
    expect(dice.action.done({ action: 'stand' })).toContain('停牌');
    expect(() => dice.action.toBody({ action: 'nope' })).toThrow(/roll/);
  });

  it('World 不注册专属工具，开桌参数按需发现且不写死游戏枚举', () => {
    const names = new Set(PARLOR_TOOL_DECLS.map((decl) => decl.name));
    expect([...names].some(name => /_(ddz|werewolf|gomoku|xiangqi|monopoly2d)_action$/.test(name))).toBe(false);
    const open = operationHelp('table').table.find(entry => entry.op === 'open')!;
    const game = (open.parameters as { properties?: { game?: { enum?: string[] } } }).properties?.game;
    expect(game?.enum).toBeUndefined();
    expect(names.has('parlor_game_info')).toBe(true);
    expect(names.has('parlor_game_action')).toBe(true);
  });

  it('快局大富翁：严格版本、动作参数只认 roll/buy/pass 与回合号', () => {
    const game = gameById('monopoly2d')!;
    expect(game).toBeTruthy();
    expect(game.actionType).toBe('monopoly2d_action');

    expect(game.revisionMode).toBe('strict');

    expect(game.action.toBody({ move: 'roll', turnNo: 3 }))
      .toEqual({ type: 'monopoly2d_action', move: 'roll', turnNo: 3 });
    expect(() => game.action.toBody({ move: 'upgrade', turnNo: 3 })).toThrow(/roll/);
    expect(() => game.action.toBody({ move: 'roll' })).toThrow(/turnNo/);
    expect(() => game.action.toBody({ move: 'roll', turnNo: 0 })).toThrow(/turnNo/);
    expect(game.action.done({ move: 'buy' })).toContain('买下');
  });
});
