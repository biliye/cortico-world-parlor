import { describe, expect, it } from 'vitest';
import { gameComponent, sourceFunction } from './helpers/game-component.ts';

const ddz = gameComponent('DdzGame.vue');
const ended = () => ({
  table: {
    game: 'ddz', status: 'ended', tableId: 't1', multiplier: 4, landlord: 'a', winners: ['b', 'c'],
    spring: false, antiSpring: true, result: '农民赢',
    seats: [{ id: 'a', name: '甲', role: 'landlord', cardsLeft: 1 }, { id: 'b', name: '乙', cardsLeft: 0 }, { id: 'c', name: '丙', cardsLeft: 2 }],
    revealed: [{ id: 'a', cards: ['K'] }, { id: 'b', cards: [] }, { id: 'c', cards: ['3', '4'] }],
  },
  priv: null, endEvent: null, me: { id: 'a', name: '甲' }, names: new Map([['a', '甲'], ['b', '乙'], ['c', '丙']]),
  classes: new Map(), seats: [], online: [], now: 0,
});

describe('E2：回放窗口外的结算信息', () => {
  it('Vue 冷页面保留倍数、反春、赢家与三家剩牌', async () => {
    const view = ended();
    const ctx = { serverNow: () => 0 };
    const instance = ddz.logic({ view, ctx });
    const result = instance.state.end.value;
    expect(result).toMatchObject({ multiplier: 4, extra: ' · 反春', winnersText: '乙、丙' });
    expect(result.rows.map((row: any) => row.row.cards)).toEqual([['K'], [], ['3', '4']]);
    expect(result.rows.map((row: any) => row.won)).toEqual([false, true, true]);
    instance.stop();
    const html = await ddz.html({ view, ctx });
    expect(html).toContain('倍数 ×4');
    expect(html).toContain('反春');
    expect(html).toContain('乙、丙');
  });

  it('Vue 冷热渲染相同；旧服务器仍可用终局事件', async () => {
    const view: any = ended();
    const ctx = { serverNow: () => 0 };
    const cold = await ddz.html({ view, ctx });
    view.endEvent = { data: { ...view.table } };
    expect(await ddz.html({ view, ctx })).toBe(cold);
    const event = view.endEvent;
    for (const key of ['winners', 'revealed', 'spring', 'antiSpring']) delete view.table[key];
    expect(await ddz.html({ view, ctx })).toBe(cold);
    expect(view.endEvent).toBe(event);
  });

  it('legacy 冷页面同样读公开终局资料', () => {
    type Node = { text: string; append: (...children: Node[]) => void };
    const el = (_tag: string, _cls = '', text = ''): Node => ({
      text, append(...children) { this.text += children.map((node) => node.text).join(''); },
    });
    const box = el('div');
    const render = sourceFunction('src/web/games/ddz.js', 'renderEnd', {
      view: ended(), box, ctx: {}, el, readable: String, seatAvatar: () => el('div'), roleTag: () => null,
      btn: (text: string) => el('button', '', text), cardButton: (card: string) => el('span', '', `牌:${card}`),
      document: { createTextNode: (text: string) => el('text', '', text) },
    });
    render();
    expect(box.text).toContain('倍数 ×4 · 赢家 乙、丙');
    expect(box.text).toContain('反春');
    expect(box.text).toContain('牌:K');
    expect(box.text).toContain('牌:3牌:4');
  });
});
