import { describe, expect, it } from 'vitest';
import { gameActionBody, gameActions, gameState } from '../src/room/game-api.ts';
import { gameById, type GameDefinition } from '../src/room/games/registry.ts';
import type { TableSummary } from '../src/room/table-engine.ts';

describe('通用游戏协议', () => {
  it('新游戏不需要工具名，只用动作协议即可发现和转换参数', () => {
    const future: GameDefinition = { ...gameById('ddz')!, id: 'future' };
    expect(gameActions(future).map(entry => entry.action)).toEqual(['bid', 'play', 'pass']);
    expect(gameActionBody(future, 'bid', { call: false })).toEqual({ type: 'ddz_action', move: 'bid', call: false });
  });

  it('五子棋的认输走同一套动作协议，不用另开工具', () => {
    const gomoku = gameById('gomoku')!;
    expect(gameActions(gomoku).map(entry => entry.action)).toEqual(['place', 'resign']);
    expect(gameActionBody(gomoku, 'resign', {})).toEqual({ type: 'gomoku_action', resign: true });
    expect(gameActionBody(gomoku, 'place', { row: 7, col: 8 })).toEqual({ type: 'gomoku_action', row: 7, col: 8 });
  });

  it.each([
    ['place', { row: '7', col: 8 }], ['place', { row: 15, col: 0 }],
    ['place', { row: 1.5, col: 0 }], ['place', { row: 0 }],
    ['place', { row: 0, col: 0, type: 'say' }], ['place', []], ['place', null], ['jump', {}],
  ])('拒绝非法动作或参数 %s %j', (action, params) => {
    expect(() => gameActionBody(gameById('gomoku')!, action, params)).toThrow();
  });

  it('狼人杀要求窗口号；不将参数默默转型', () => {
    const wolf = gameById('werewolf')!;
    expect(() => gameActionBody(wolf, 'vote', { target: 2 })).toThrow(/windowId/);
    expect(() => gameActionBody(wolf, 'vote', { windowId: 'w1', target: '2' })).toThrow(/target/);
    expect(gameActionBody(wolf, 'vote', { windowId: 'w1', target: 2 }))
      .toEqual({ type: 'werewolf_action', move: 'vote', windowId: 'w1', target: 2 });
  });

  const table: TableSummary = {
    id: 't1', game: 'werewolf', label: '狼人杀', status: 'playing', host: 'mine', text: '公开桌面',
  };
  it('可用动作只来自匹配桌号的本人私视图，查询另一桌不夹带秘密', () => {
    const wolf = gameById('werewolf')!;
    const view = { game: 'werewolf', seat: 'mine', tableId: 't1', text: '秘密身份', canAct: true, myMove: 'speak', windowId: 'w9' };
    const state = gameState(wolf, table, view);
    expect(state.availableActions.map(entry => entry.action)).toEqual(['speak', 'pass_speech']);
    expect(state.availableActions[0].defaults).toEqual({ windowId: 'w9' });
    expect(gameState(wolf, { ...table, id: 'other' }, view))
      .toMatchObject({ tablePrivate: null, availableActions: [] });
    expect(gameState(wolf, { ...table, frozen: true }, view).availableActions).toEqual([]);
    expect(gameState(wolf, { ...table, status: 'ended' }, view).availableActions).toEqual([]);
  });

  it('骰子重掷用完后只提示停牌；斗地主领出时不提示过牌', () => {
    expect(gameById('dice')!.availableActions({ yourTurn: true, rerollsLeft: 0 })).toEqual(['stand']);
    expect(gameById('ddz')!.availableActions({ yourTurn: true, status: 'playing', canPass: false })).toEqual(['play']);
    expect(gameById('ddz')!.availableActions({ yourTurn: false, status: 'playing' })).toEqual([]);
  });
});
