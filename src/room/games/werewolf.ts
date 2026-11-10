/**
 * 狼人杀纯规则：角色、发牌、胜负判定、票型与发言校验。
 *
 * 这里只有「给定状态算结果」的函数，不持有状态、不看时钟——引擎
 * （`werewolf-table.ts`）负责阶段机与时钟。拆出来是为了让规则可以
 * 用可控随机源穷举测试，不用先架起一张完整的桌子。
 *
 * 房规出处：openM/parlor-werewolf-design-2026-10-31.md 第 3 节。
 * 支持六人、九人和十二人局，守卫仅在十二人局出现。
 */

export type WerewolfRole = 'wolf' | 'villager' | 'seer' | 'witch' | 'hunter' | 'guard';

export type WerewolfFaction = 'wolf' | 'good';

export const WEREWOLF_SEAT_COUNT = 9;
export type WerewolfSeatCount = 6 | 9 | 12;

export function isWerewolfSeatCount(value: unknown): value is WerewolfSeatCount {
  return value === 6 || value === 9 || value === 12;
}

export const WEREWOLF_MAX_DAYS = 12;

/** 九人局的发牌配置。 */
export const ROLE_COUNTS: ReadonlyArray<{ role: WerewolfRole; count: number }> = [
  { role: 'wolf', count: 3 },
  { role: 'villager', count: 3 },
  { role: 'seer', count: 1 },
  { role: 'witch', count: 1 },
  { role: 'hunter', count: 1 },
];

const ROLE_COUNTS_BY_SIZE: Record<WerewolfSeatCount, typeof ROLE_COUNTS> = {
  6: [
    { role: 'wolf', count: 2 }, { role: 'villager', count: 2 },
    { role: 'seer', count: 1 }, { role: 'witch', count: 1 },
  ],
  9: ROLE_COUNTS,
  12: [
    { role: 'wolf', count: 4 }, { role: 'villager', count: 4 },
    { role: 'seer', count: 1 }, { role: 'witch', count: 1 },
    { role: 'hunter', count: 1 }, { role: 'guard', count: 1 },
  ],
};

export const ROLE_LABELS: Record<WerewolfRole, string> = {
  wolf: '狼人',
  villager: '村民',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  guard: '守卫',
};

/** 玩家口中的「村民」在身份牌上写的是「平民」；同一角色，界面文案跟随牌面。 */
export const ROLE_CARD_LABELS: Record<WerewolfRole, string> = {
  wolf: '狼人',
  villager: '平民',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  guard: '守卫',
};

export const FACTION_LABELS: Record<WerewolfFaction, string> = {
  wolf: '狼人阵营',
  good: '好人阵营',
};

export const factionOf = (role: WerewolfRole): WerewolfFaction => (role === 'wolf' ? 'wolf' : 'good');

/** 一句话技能说明（按本项目房规写，不照抄别的版本）。 */
export const ROLE_SKILLS: Record<WerewolfRole, string> = {
  wolf: '每晚可发两条狼队私聊，交一张刀票。可刀任意存活玩家，包括自己和队友。唯一最高票成为刀口，平票或没有有效票则空刀。',
  villager: '没有夜间技能，靠白天发言与投票找出狼人。',
  seer: '每晚最多查验一名其他存活玩家，只得到「狼人 / 好人」，不告知具体神职。',
  witch: '全局各一瓶解药、一瓶毒药，每夜最多用其中一瓶。解药尚在时才得知当夜刀口；首夜可自救，之后不能自救，不能自毒。解药只抵消狼刀。',
  hunter: '被狼刀或白天投票出局时可以开枪带走一名其他存活玩家；中毒（含刀毒同中）不能开枪。',
  guard: '每晚可守护一名存活玩家（可自守或空守），不可连续两夜守同一人。守护挡狼刀，不挡毒药；同守同救时狼刀生效。',
};

/** 按本桌人数洗身份牌。rng 返回 [0,1)。 */
export function dealRoles(rng: () => number, seatCount: WerewolfSeatCount = WEREWOLF_SEAT_COUNT): WerewolfRole[] {
  const pool: WerewolfRole[] = [];
  for (const { role, count } of ROLE_COUNTS_BY_SIZE[seatCount]) {
    for (let i = 0; i < count; i++) pool.push(role);
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

/** 一张「谁还活着」的表：座号 → 角色。 */
export type AliveMap = ReadonlyMap<number, WerewolfRole>;

/**
 * 判胜负。返回 null 表示还要继续打。
 * 顺序按房规：全员出局平局 → 狼人全灭好人胜 → 屠边狼人胜 → 未决。
 * 「屠边」：村民全出局，或神职全出局，狼人即胜。
 */
export function judgeOutcome(alive: AliveMap): 'good' | 'wolf' | 'draw' | null {
  if (alive.size === 0) return 'draw';
  const roles = [...alive.values()];
  const wolves = roles.filter((role) => role === 'wolf').length;
  if (wolves === 0) return 'good';
  const villagers = roles.filter((role) => role === 'villager').length;
  const gods = roles.filter((role) => role !== 'wolf' && role !== 'villager').length;
  if (villagers === 0 || gods === 0) return 'wolf';
  return null;
}

/** 一轮票：投票人座号 → 目标座号；null = 弃票。 */
export type Ballots = ReadonlyMap<number, number | null>;

export interface TallyResult {
  /** 唯一最高有效票的座号；没有则 undefined。 */
  readonly exiled?: number;
  /** 最高票并列的座号（按座号升序）；有并列时 exiled 为空。 */
  readonly tie: readonly number[];
  /** 最高有效票的票数；全弃票时为 0。 */
  readonly top: number;
  /** 是否一个有效票都没有（全弃票 / 没人投）。 */
  readonly noValid: boolean;
}

/**
 * 数票：相对多数、最高票唯一者胜。只数有效票（目标非 null）；
 * 目标的合法性由调用方按当前投票规则在收票时校验。
 */
export function tallyVotes(ballots: Ballots, allowedTargets?: ReadonlySet<number>): TallyResult {
  const counts = new Map<number, number>();
  let valid = 0;
  for (const target of ballots.values()) {
    if (target === null || target === undefined) continue;
    if (allowedTargets && !allowedTargets.has(target)) continue;
    counts.set(target, (counts.get(target) ?? 0) + 1);
    valid += 1;
  }
  if (valid === 0) return { tie: [], top: 0, noValid: true };
  let top = 0;
  for (const count of counts.values()) top = Math.max(top, count);
  const leaders = [...counts.entries()]
    .filter(([, count]) => count === top)
    .map(([seatNo]) => seatNo)
    .sort((left, right) => left - right);
  if (leaders.length === 1) return { exiled: leaders[0], tie: [], top, noValid: false };
  return { tie: leaders, top, noValid: false };
}

/**
 * 发言正文校验：去首尾空白后 1～max 个 Unicode 码点（`Array.from` 计）。
 * 拒绝纯不可见内容与有害控制字符；保留换行、常见表情。
 * 返回清理后的正文；不合法抛错——超长不截断、不静默吃掉。
 */
export function cleanSpeech(text: unknown, max: number): string {
  if (typeof text !== 'string') throw new Error('发言要是一段文字');
  const body = text.replace(/^\s+|\s+$/g, '');
  if (!body) throw new Error('发言不能是空的；不想说就走过麦');
  const chars = Array.from(body);
  if (chars.length > max) throw new Error(`这次发言最多 ${max} 个字（现在 ${chars.length} 个），超长不截断，请精简后再提交`);
  for (const ch of chars) {
    const code = ch.codePointAt(0) ?? 0;
    // 除了制表/换行/回车以外的 C0 控制符，以及 DEL，都当有害字符拒掉。
    const visibleException = ch === '\t' || ch === '\n' || ch === '\r';
    if (!visibleException && (code < 0x20 || code === 0x7f)) {
      throw new Error('发言里有看不见的控制字符，请清理后再提交');
    }
  }
  // 全部是零宽/不可见格式字符也等于没说。
  const meaningful = chars.filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    const invisibleFormat = code === 0x200b || code === 0x200c || code === 0x200d
      || code === 0xfeff || (code >= 0x2060 && code <= 0x2064);
    return !invisibleFormat && ch.trim() !== '';
  });
  if (meaningful.length === 0) throw new Error('发言全是不可见字符；不想说就走过麦');
  return body;
}

/** 语义化版本比较：a >= b。只认 数字.数字.数字，其余一律当「不够新」。 */
export function versionAtLeast(version: string | undefined | null, minimum: string): boolean {
  if (!version) return false;
  const parse = (value: string): Array<number> | null => {
    const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const left = parse(version);
  const right = parse(minimum);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i]! > right[i]!;
  }
  return true;
}
