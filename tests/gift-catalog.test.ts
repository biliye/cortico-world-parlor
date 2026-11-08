import { describe, expect, it } from 'vitest';
import { BINGE_AT, LUCK_WINDOW_MS, rollLuck } from '../src/room/gifts/luck.ts';
import { GIFT_KIND_LABEL, GIFTS, giftById, resolveGift } from '../src/room/gifts/catalog.ts';

describe('茶单：只有这一份目录', () => {
  it('十二件：茶六、小零食六，id 与名字都不重', () => {
    expect(GIFTS).toHaveLength(12);
    expect(GIFTS.filter((item) => item.kind === 'tea')).toHaveLength(6);
    expect(GIFTS.filter((item) => item.kind === 'snack')).toHaveLength(6);
    expect(new Set(GIFTS.map((item) => item.id)).size).toBe(12);
    expect(new Set(GIFTS.map((item) => item.name)).size).toBe(12);
    for (const item of GIFTS) {
      expect(item.id).toMatch(/^[a-z]+$/);
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.desc.length).toBeGreaterThan(0);
      expect(item.icon.length).toBeGreaterThan(0);
      expect(GIFT_KIND_LABEL[item.kind]).toBeTruthy();
      expect(giftById(item.id)).toBe(item);
    }
    expect(giftById('没有这个')).toBeUndefined();
  });

  it('按 id、全名、唯一前缀都能选中；撞名宁可报错也不猜', () => {
    expect(resolveGift('longjing').item?.name).toBe('龙井');
    expect(resolveGift('龙井').item?.id).toBe('longjing');
    expect(resolveGift('  LONGJING  ').item?.id).toBe('longjing');
    expect(resolveGift('pue').item?.id).toBe('puer');
    expect(resolveGift('桂花').item?.id).toBe('guihuagao');

    // gu 同时命中桂花糕与瓜子：送错东西收不回来，所以这里必须报不唯一。
    expect(resolveGift('gu').item).toBeUndefined();
    expect(resolveGift('gu').error).toContain('不唯一');
    expect(resolveGift('l').error).toContain('不唯一');

    expect(resolveGift('螺蛳粉').item).toBeUndefined();
    expect(resolveGift('螺蛳粉').error).toContain('茶单');
    expect(resolveGift('').error).toContain('茶单');
    expect(resolveGift(undefined).error).toContain('茶单');
    expect(resolveGift(42).error).toContain('茶单');
  });
});

describe('运气：纯文案，不产生任何效果', () => {
  const tea = giftById('puer')!;
  const snack = giftById('guihuagao')!;
  const first = () => 0; // 取池子第一条，断言才稳

  it('前两份说运气上升，第三份起说下降', () => {
    expect(rollLuck({ item: tea, recent: 0, rng: first }).tone).toBe('up');
    expect(rollLuck({ item: tea, recent: 1, rng: first }).tone).toBe('up');
    const third = rollLuck({ item: tea, recent: 2, rng: first });
    expect(third.tone).toBe('down');
    expect(third.delta).toBe(-1);
    expect(third.nth).toBe(BINGE_AT);
    expect(third.line).toContain('运气 -1');
  });

  it('两小时的窗：瓶口上的份数只算窗内的', () => {
    expect(LUCK_WINDOW_MS).toBe(2 * 60 * 60 * 1000);
    expect(BINGE_AT).toBe(3);
    // recent 传进来的是「窗内已吃喝几份」，隔多久由调用方按 LUCK_WINDOW_MS 截。
    expect(rollLuck({ item: tea, recent: 0, rng: first }).nth).toBe(1);
    expect(rollLuck({ item: tea, recent: 9, rng: first }).tone).toBe('down');
  });

  it('茶与零食分别走各自的池子，文案里带物品名时可读', () => {
    const teaLine = rollLuck({ item: tea, recent: 0, rng: first });
    const snackLine = rollLuck({ item: snack, recent: 0, rng: first });
    expect(teaLine.text).toContain('普洱');
    expect(snackLine.text).toContain('桂花糕');
    expect(teaLine.line).toContain('只是说说');
    expect(snackLine.line).toContain('只是说说');
    // 结果里没有任何可被当成数值使用的东西：只有 tone / delta 供上色。
    expect(Object.keys(teaLine).sort()).toEqual(['delta', 'line', 'nth', 'text', 'tone']);
  });

  it('同输入同 rng 同文案：没有随机状态被藏起来', () => {
    const a = rollLuck({ item: tea, recent: 1, rng: () => 0.42 });
    const b = rollLuck({ item: tea, recent: 1, rng: () => 0.42 });
    expect(a).toEqual(b);
  });
});
