import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/** 只提供渲染所用的 DOM，执行真实 common.js 和 mountWerewolf/update。 */
class TestNode {
  children: TestNode[] = [];
  className = '';
  dataset = {};
  classList = { toggle() {}, add() {}, remove() {} };
  private text = '';
  get firstChild() { return this.children[0]; }
  get textContent(): string { return this.text + this.children.map((node) => node.textContent).join(''); }
  set textContent(text: string) { this.text = text; this.children = []; }
  append(...nodes: TestNode[]) { this.children.push(...nodes); }
  removeChild(node: TestNode) { this.children.splice(this.children.indexOf(node), 1); }
  setAttribute() {}
  addEventListener() {}
  remove() {}
}

const mount = () => {
  const root = new TestNode();
  const common = readFileSync(new URL('../src/web/common.js', import.meta.url), 'utf8').replaceAll('export ', '');
  const renderer = readFileSync(new URL('../src/web/games/werewolf.js', import.meta.url), 'utf8')
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*'[^']+';/, '').replace('export function', 'function');
  const game = runInNewContext(common + '\n' + renderer + '\nmountWerewolf(root, ctx)', {
    root,
    ctx: { act: async () => true, toast() {} },
    document: {
      createElement: () => new TestNode(),
      createTextNode: (text: string) => { const node = new TestNode(); node.textContent = text; return node; },
      addEventListener() {}, removeEventListener() {},
    },
    Image: class {},
    location: { host: 'local-test' },
    // 查验秘密不能存浏览器；刷新只能从服务器本人私视图恢复。
    localStorage: { getItem: () => null, setItem() { throw new Error('unexpected storage write'); } },
  }) as { update(view: unknown): void };
  return { root, game };
};

const seats = Array.from({ length: 9 }, (_, i) => ({
  id: `s${i + 1}`, seatNo: i + 1, name: `玩家${i + 1}`, alive: true, kind: 'pet',
}));
const history = [{ day: 1, target: 3, result: 'wolf' }];
const state = (phase: string, priv: unknown, day = 1, status = 'playing', tableId = 'table-a') => ({
  table: { tableId, phase, day, status, seats, turn: 's2', speeches: [], votes: [] },
  priv, me: { id: 's1' }, online: seats.map((seat) => seat.id), seats, classes: new Map(),
});
const seer = (extra = {}) => ({ role: 'seer', alive: true, inspections: history, canAct: false, ...extra });
const panelText = (root: TestNode): string => {
  if (root.className.split(' ').includes('wf-inspections')) return root.textContent;
  return root.children.map(panelText).join('');
};

describe('预言家网页查验记录', () => {
  it('验完立即显示，等待、白天发言/阅读、投票与第二夜验人前后均保留', () => {
    const { root, game } = mount();
    game.update(state('night', seer({ canAct: true, myMove: 'inspect', inspections: [] })));
    expect(panelText(root)).toBe('');
    // 提交后 canAct 立刻变 false，原先在此时整块验人面板消失。
    for (const [phase, extra, day] of [
      ['night', { submitted: ['inspect'] }, 1],
      ['speech', { canAct: true, myMove: 'speak' }, 1],
      ['speech', { stage: 'read' }, 1],
      ['vote', { canAct: true, myMove: 'vote' }, 1],
      ['night', { canAct: true, myMove: 'inspect' }, 2],
    ] as const) {
      game.update(state(phase, seer(extra), day));
      expect(panelText(root)).toContain('第1夜 · 3号 玩家3：狼人');
    }
    game.update(state('night', seer({ inspections: [...history, { day: 2, target: 4, result: 'good' }] }), 2));
    expect(panelText(root)).toContain('第1夜 · 3号 玩家3：狼人');
    expect(panelText(root)).toContain('第2夜 · 4号 玩家4：好人');
  });

  it('出局和终局可回看；新挂载从私视图恢复，换桌不残留', () => {
    const { root, game } = mount();
    game.update(state('speech', seer({ alive: false })));
    expect(panelText(root)).toContain('第1夜');
    game.update(state('ended', seer({ alive: false }), 2, 'ended'));
    expect(panelText(root)).toContain('第1夜');
    const refreshed = mount();
    refreshed.game.update(state('vote', seer()));
    expect(panelText(refreshed.root)).toContain('第1夜');
    game.update(state('night', seer({ inspections: [] }), 1, 'playing', 'table-b'));
    expect(panelText(root)).toBe('');
  });

  it('其他角色和旁观者无查验面板，私视图移除时也清除旧记录', () => {
    const { root, game } = mount();
    for (const priv of [null, { role: 'villager' }, { role: 'wolf' }]) {
      game.update(state('night', seer()));
      expect(panelText(root)).toContain('仅自己可见');
      game.update(state('night', priv));
      expect(panelText(root)).toBe('');
      expect(root.textContent).not.toContain('第1夜 · 3号 玩家3：狼人');
    }
  });
});
