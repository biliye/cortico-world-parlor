/**
 * 大富翁的脚本陪练策略。
 *
 * 之前脚本到点走的是「托管」那套默认动作（不买、不升级、不补卡），结果是两个空位陪跑：
 * 12 轮下来地产 0、全靠现金结算。这里只做最低限度的经济决策，不玩道具时机：
 * 钱够就买、余钱够就升、工坊优先补修缮卡（这是唯一会主动用掉的卡）。
 * 托管（auto / 超时）不走这里，仍然保持「不买、不升级、不补卡」。
 */
import { cellAt, type ItemKind, type Phase } from './monopoly-rules.ts';

/** 买地后至少留这么多现金交租。 */
export const BOT_KEEP_AFTER_BUY = 100;
/** 升级后至少留这么多。 */
export const BOT_KEEP_AFTER_UPGRADE = 250;
/** 用修缮卡（半价升级）后至少留这么多。 */
export const BOT_KEEP_AFTER_REPAIR = 200;

export interface MonopolyBotInput {
  phase: Phase;
  cash: number;
  pending: number | null;
  canRoll: boolean;
  canBuy: boolean;
  canUpgrade: boolean;
  workshop: readonly ItemKind[];
  repairTargets: readonly { index: number; cost: number }[];
}

export type MonopolyBotMove =
  | { type: 'roll' }
  | { type: 'buy' }
  | { type: 'upgrade' }
  | { type: 'take_item'; item: ItemKind }
  | { type: 'use_item'; item: 'repair'; target: number }
  | { type: 'pass' };

export function chooseMonopolyBotMove(input: MonopolyBotInput): MonopolyBotMove {
  if (input.phase === 'prepare') {
    const repair = input.repairTargets.find((target) => input.cash - target.cost >= BOT_KEEP_AFTER_REPAIR);
    if (repair) return { type: 'use_item', item: 'repair', target: repair.index };
    return { type: 'roll' };
  }

  if (input.phase === 'buy' && input.pending !== null && input.canBuy) {
    const price = cellAt(input.pending).price ?? 0;
    if (input.cash - price >= BOT_KEEP_AFTER_BUY) return { type: 'buy' };
  }

  if (input.phase === 'upgrade' && input.pending !== null && input.canUpgrade) {
    const cost = cellAt(input.pending).upgrade ?? 0;
    if (input.cash - cost >= BOT_KEEP_AFTER_UPGRADE) return { type: 'upgrade' };
  }

  if (input.phase === 'workshop') {
    const pick: ItemKind | undefined = input.workshop.includes('repair')
      ? 'repair'
      : input.workshop.includes('signpost')
        ? 'signpost'
        : undefined;
    if (pick) return { type: 'take_item', item: pick };
  }

  return { type: 'pass' };
}
