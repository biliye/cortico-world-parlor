import { describe, expect, it } from 'vitest';
import {
  BOT_KEEP_AFTER_BUY, BOT_KEEP_AFTER_REPAIR, BOT_KEEP_AFTER_UPGRADE, chooseMonopolyBotMove,
} from '../src/room/games/monopoly-bot.ts';

/** 板上：2 = 面包房（价 160/升 80），19 = 甜品屋（价 320/升 160）。 */
const base = {
  phase: 'prepare' as const,
  cash: 1200,
  pending: null as number | null,
  canRoll: true,
  canBuy: false,
  canUpgrade: false,
  workshop: [] as never[],
  repairTargets: [] as { index: number; cost: number }[],
};

describe('脚本陪练的策略', () => {
  it('准备阶段没事就掷骰', () => {
    expect(chooseMonopolyBotMove(base)).toEqual({ type: 'roll' });
  });

  it('有修缮卡且留得住钱就用掉', () => {
    const move = chooseMonopolyBotMove({
      ...base,
      cash: BOT_KEEP_AFTER_REPAIR + 40,
      repairTargets: [{ index: 2, cost: 40 }],
    });
    expect(move).toEqual({ type: 'use_item', item: 'repair', target: 2 });
  });

  it('修缮完会太穷就留着不修', () => {
    const move = chooseMonopolyBotMove({
      ...base,
      cash: BOT_KEEP_AFTER_REPAIR - 1,
      repairTargets: [{ index: 2, cost: 40 }],
    });
    expect(move).toEqual({ type: 'roll' });
  });

  it('钱够就买地，并留出交租的底', () => {
    const move = chooseMonopolyBotMove({ ...base, phase: 'buy', pending: 19, canBuy: true, canRoll: false });
    expect(move).toEqual({ type: 'buy' });
  });

  it('买完会太穷就不买', () => {
    const move = chooseMonopolyBotMove({
      ...base,
      phase: 'buy',
      cash: BOT_KEEP_AFTER_BUY,
      pending: 19,
      canBuy: true,
      canRoll: false,
    });
    expect(move).toEqual({ type: 'pass' });
  });

  it('买不起或不合法时不买', () => {
    const move = chooseMonopolyBotMove({ ...base, phase: 'buy', pending: 19, canBuy: false, canRoll: false });
    expect(move).toEqual({ type: 'pass' });
  });

  it('钱够就升级自己的地', () => {
    const move = chooseMonopolyBotMove({
      ...base,
      phase: 'upgrade',
      cash: BOT_KEEP_AFTER_UPGRADE + 160,
      pending: 19,
      canUpgrade: true,
      canRoll: false,
    });
    expect(move).toEqual({ type: 'upgrade' });
  });

  it('升级后余钱太少就不升', () => {
    const move = chooseMonopolyBotMove({
      ...base,
      phase: 'upgrade',
      cash: BOT_KEEP_AFTER_UPGRADE,
      pending: 19,
      canUpgrade: true,
      canRoll: false,
    });
    expect(move).toEqual({ type: 'pass' });
  });

  it('工坊优先补修缮卡（唯一会主动用掉的卡）', () => {
    const move = chooseMonopolyBotMove({
      ...base,
      phase: 'workshop',
      canRoll: false,
      workshop: ['signpost', 'repair'] as never[],
    });
    expect(move).toEqual({ type: 'take_item', item: 'repair' });
  });

  it('没有修缮卡就补路标卡', () => {
    const move = chooseMonopolyBotMove({
      ...base,
      phase: 'workshop',
      canRoll: false,
      workshop: ['signpost'] as never[],
    });
    expect(move).toEqual({ type: 'take_item', item: 'signpost' });
  });

  it('工坊里没得补就放弃', () => {
    const move = chooseMonopolyBotMove({ ...base, phase: 'workshop', canRoll: false });
    expect(move).toEqual({ type: 'pass' });
  });
});
