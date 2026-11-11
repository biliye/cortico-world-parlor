/** 家长页和两处本地档案共用的按场次回看列表。 */
export function mountStoryArchive(root, { list, detail, time, active = () => true }) {
  const el = (tag, text = '') => {
    const node = root.ownerDocument.createElement(tag);
    node.textContent = text;
    return node;
  };
  const panel = el('details');
  const status = el('p');
  status.setAttribute('aria-live', 'polite');
  const entries = el('div');
  const older = el('button', '更早的场次');
  const refresh = el('button', '刷新');
  older.type = refresh.type = 'button';
  older.hidden = true;
  panel.append(el('summary', '说书记录'), refresh, status, entries, older);
  root.append(panel);
  let cursor = null;
  let busy = false;
  let loaded = false;

  const load = async (more = false) => {
    if (busy || !active()) return;
    busy = true;
    older.disabled = refresh.disabled = true;
    status.textContent = '正在读取说书记录…';
    try {
      const page = await list(more ? cursor : null);
      if (!active()) return;
      if (!more) entries.replaceChildren();
      for (const round of page.rounds) {
        const story = el('details');
        const body = el('article');
        const retry = el('button', '重新读取正文');
        retry.type = 'button';
        story.append(el('summary', `${round.title} · ${round.speaker} · ${time(round.startedAt)}`), body);
        entries.append(story);
        let reading = false;
        let read = false;
        const show = async () => {
          if (!story.open || read || reading || !active()) return;
          reading = true;
          body.textContent = '正在读取正文…';
          try {
            const full = await detail(round.id);
            if (!active() || !story.isConnected) return;
            body.replaceChildren(...full.parts.map(part => el('p', part.text)));
            read = true;
          } catch (error) {
            if (active()) body.replaceChildren(el('p', error.message), retry);
          } finally { reading = false; }
        };
        story.addEventListener('toggle', show);
        retry.addEventListener('click', show);
      }
      cursor = page.next;
      older.hidden = !cursor;
      status.textContent = entries.childElementCount ? '' : '还没有说书记录。';
      loaded = true;
    } catch (error) {
      if (active()) status.textContent = error.message;
    } finally {
      busy = false;
      older.disabled = refresh.disabled = false;
    }
  };
  panel.addEventListener('toggle', () => { if (panel.open && !loaded) void load(); });
  refresh.addEventListener('click', () => void load());
  older.addEventListener('click', () => void load(true));
}
