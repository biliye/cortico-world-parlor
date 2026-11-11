import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

class TestNode {
  children: TestNode[] = [];
  className = '';
  textContent = '';
  get firstChild() { return this.children[0]; }
  append(...nodes: TestNode[]) { this.children.push(...nodes); }
  removeChild(node: TestNode) { this.children.splice(this.children.indexOf(node), 1); }
  addEventListener() {}
}

const mount = () => {
  const nodes = new Map<string, TestNode>();
  const source = readFileSync(new URL('../src/web/parent.js', import.meta.url), 'utf8')
    .replace("import { mountStoryArchive } from './story-archive.js';", '')
    .replace('void boot();', '');
  const renderer = runInNewContext(source + '\n({ renderMail, renderLog })', {
    document: {
      getElementById(id: string) {
        if (!nodes.has(id)) nodes.set(id, new TestNode());
        return nodes.get(id);
      },
      createElement: () => new TestNode(),
    },
  }) as { renderMail(view: unknown): void; renderLog(view: unknown): void };
  return { ...renderer, nodes };
};

describe('家长页消息渲染', () => {
  it('来信和孩子回复各标方向；正文当纯文本，刷新不堆重复记录', () => {
    const { renderMail, nodes } = mount();
    const view = { mailUnread: 1, mail: [
      { ts: 1, fromMe: true, toName: '阿岚', toHandle: 'alan', text: '<script>回复</script>', kind: 'whisper' },
      { ts: 0, fromName: '阿岚', fromHandle: 'alan', text: '在吗', kind: 'whisper', read: false },
    ] };
    renderMail(view);
    const rows = nodes.get('mail')!.children;
    expect(rows[0].children[1].textContent).toBe('孩子 → 阿岚 #alan');
    expect(rows[0].children[2].textContent).toBe('<script>回复</script>');
    expect(rows[0].children[2].children).toHaveLength(0);
    expect(rows[1].children[1].textContent).toBe('阿岚 #alan → 孩子 · 未读');
    expect(nodes.get('mail-unread')!.textContent).toBe('孩子未读 1 封');
    renderMail(view);
    expect(nodes.get('mail')!.children).toHaveLength(2);
    renderMail({ mail: [] });
    expect(nodes.get('mail')!.children[0].textContent).toBe('信箱是空的。');
  });

  it('孩子自己的公开发言与桌聊仍显示，私牌行动不画进聊天', () => {
    const { renderLog, nodes } = mount();
    renderLog({ room: { id: 'hall' }, events: [
      { seq: 1, ts: 1, type: 'parlor.say', from: 'child', data: { name: '小满' }, text: '公开回复' },
      { seq: 2, ts: 2, type: 'parlor.table.say', from: 'child', data: { name: '小满' }, text: '桌聊回复' },
      { seq: 3, ts: 3, type: 'parlor.table.turn', from: 'system', text: '暗牌' },
    ] });
    expect(nodes.get('log')!.children.map(row => row.children[2].textContent)).toEqual(['公开回复', '桌聊回复']);
  });
});
