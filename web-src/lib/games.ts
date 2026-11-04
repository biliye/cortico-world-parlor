/** 网页侧的游戏清单。与旧 games/registry.js 一致；桌面渲染器仍挂在 src/web/games/ 下。 */

export interface GameDef {
  label: string;
  icon: string;
  enabled: boolean;
  endScreen: boolean;
  minPlayers: number;
  botFill: boolean;
  blurb: string;
  foot: string;
  guide?: string[];
}

export const GAMES: Record<string, GameDef> = {
  dice: {
    label: '骰子', icon: 'dice', enabled: false, endScreen: false, minPlayers: 2, botFill: false,
    blurb: '两到四人，暗骰、可重掷两次，合计最高者赢。', foot: '暗骰 · 重掷 · 比点数',
  },
  werewolf: {
    label: '狼人杀', icon: 'moon', enabled: true, endScreen: true, minPlayers: 9, botFill: false,
    blurb: '支持全 Coo 局，也欢迎真人入座。固定九席，3 狼 / 3 平民 / 预言家 / 女巫 / 猎人。',
    foot: '九席 · 夜谈 · 单次发言',
    guide: [
      '固定九席：3 狼人、3 平民（牌面写「平民」）、预言家、女巫、猎人；无警长、无自爆。',
      '坐满九席且至少有一只 Coo 后，由开桌者开始。开桌时可要求至少一名真人入座。每只 Coo 的扩展都要支持狼人杀。',
      '轮到你发言只有一条（≤300 字），提交或过麦后全桌阅读 20 秒；投票、夜晚、开枪是同时窗口，到点统一结算。',
      '真人发言 3 分钟、Coo 60 秒。夜晚对所有人只显示一个完整的夜。',
      '好人灭掉全部狼人获胜；狼人把平民全灭或把三神全灭（屠边）获胜；最多十二个白天。',
      '身份牌、查验、狼聊与药只有本人看得见；终局公开全部身份，出局者保留座位观战。',
    ],
  },
  ddz: {
    label: '斗地主', icon: 'cards', enabled: true, endScreen: true, minPlayers: 1, botFill: true,
    blurb: '三人一桌，空位由脚本陪练补；一个人也能开。', foot: '叫地主 · 出牌 · 脚本补位',
    guide: [
      '三人一桌；空位由脚本陪练补，一个人也能开。',
      '叫地主 30 秒、出牌 60 秒；超时由服务器代打。',
      '点牌选中，出牌 / 不要 / 提示；提示来自服务器，出的牌一定合法。',
      '地主拿 3 张底牌；炸弹、王炸翻倍；春天 / 反春再翻。',
    ],
  },
  monopoly: {
    label: '大富翁', icon: 'board', enabled: false, endScreen: false, minPlayers: 2, botFill: true,
    blurb: '四到六人的长局，买地、升级、道具；这一版先收起来了。', foot: '买地 · 升级 · 道具',
  },
};

export const ENABLED_GAMES = Object.keys(GAMES).filter((id) => GAMES[id].enabled);

export function gameOf(id: string): GameDef | null {
  return GAMES[id] || null;
}

export function gameLabel(id: string): string {
  return GAMES[id]?.label || id;
}

export function heroGame(): string {
  return ENABLED_GAMES[0] || 'ddz';
}

/** 够不够开局：达到最低人数，或者这张桌允许脚本补位。 */
export function enoughPlayers(table: { game: string; seats?: unknown[] }): boolean {
  const def = gameOf(table.game);
  if (!def) return false;
  return (table.seats || []).length >= def.minPlayers || def.botFill;
}

/** 优先显示服务端实际开局检查；兼容尚未提供检查结果的旧服务器。 */
export function tableStartBlockers(table: { game: string; requireHuman?: boolean; startBlockers?: string[]; seats?: Array<{ kind?: string }> }): string[] {
  if (Array.isArray(table.startBlockers)) return table.startBlockers;
  const issues = enoughPlayers(table) ? [] : ['人数不够，还不能开局。'];
  if (table.game === 'werewolf') {
    if (table.requireHuman !== false && !table.seats?.some((person) => person.kind === 'human')) {
      issues.push('本桌要求至少一名真人入座。');
    }
    if (!table.seats?.some((person) => person.kind === 'pet')) issues.push('至少需要一只 Coo 同桌。');
  }
  return issues;
}

export function canStartTable(table: Parameters<typeof tableStartBlockers>[0]): boolean {
  return enoughPlayers(table) && tableStartBlockers(table).length === 0;
}

export function tableSeatLabel(person: { kind?: string; bot?: boolean }): string {
  return person.bot ? '脚本' : KIND_LABELS[person.kind || ''] || '席位';
}

export const STATUS_LABELS: Record<string, string> = {
  open: '等人',
  bidding: '叫地主',
  playing: '进行中',
  ended: '已结束',
};

export const KIND_LABELS: Record<string, string> = {
  pet: 'Coo',
  human: '人',
  observer: '观看',
};
