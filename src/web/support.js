const $ = id => document.getElementById(id);
let cfg;
try { cfg = JSON.parse(localStorage.getItem('parlor-play-v1') || 'null'); } catch {}
let operatorKey = '';
let feedbackRequest = null;
let announcementRequest = null;
let newsRequest = null;
let editingNewsId = '';
// 编辑时要带回「编辑者看到的那一期」：publishId 识别删掉重发，revision 识别并发编辑。
let editingNewsPublishId = '';
let editingNewsRevision = 1;
// 表单只显示 HH:MM；记下回填值，没动过时间就不提交 publishAt，免得把秒数悄悄抹成 :00。
let editingNewsTime = '';
const status = text => { $('status').textContent = text; };
const beijingToday = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
async function api(path, body, operator = false, method) {
  const token = operator ? operatorKey : cfg?.token;
  if (!token) throw new Error('请先回会馆加入席位，再打开反馈与公告。');
  const verb = method || (body ? 'POST' : 'GET');
  const res = await fetch(`/v1/support/${path}`, { method: verb,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
function node(tag, text) { const n = document.createElement(tag); n.textContent = text; return n; }
function card(item) {
  const box = document.createElement('article');
  box.append(node('small', `${new Date(item.created_at).toLocaleString()} · ${item.id}`), node('p', item.text));
  return box;
}
function feedbackList(target, items, operator = false) {
  target.replaceChildren();
  if (!items.length) target.append(node('p', '暂时没有反馈。'));
  for (const item of items) {
    const box = card(item);
    const summary = node('p', `${operator ? `${item.name} · ${item.coo_id} · ` : ''}${item.status === 'closed' ? '已处理' : '待处理'}`);
    const replyText = node('p', `运营回复：${item.reply || '暂无'}`);
    box.append(summary, replyText);
    if (operator) {
      const form = document.createElement('form');
      const label = node('label', '回复提交者');
      const reply = document.createElement('textarea'); reply.maxLength = 2000; reply.required = true; reply.value = item.reply;
      label.append(reply);
      const stateLabel = node('label', '处理状态');
      const select = document.createElement('select');
      for (const [value, text] of [['open', '待处理'], ['closed', '已处理']]) {
        const option = node('option', text); option.value = value; select.append(option);
      }
      select.value = item.status; stateLabel.append(select);
      const save = node('button', '保存回复'); save.type = 'submit';
      form.append(label, stateLabel, save);
      form.addEventListener('submit', event => {
        event.preventDefault();
        void perform(save, async () => {
          await api('operator/reply', { id: item.id, text: reply.value, status: select.value }, true);
          summary.textContent = `${item.name} · ${item.coo_id} · ${select.value === 'closed' ? '已处理' : '待处理'}`;
          replyText.textContent = `运营回复：${reply.value}`;
          status('回复已保存。');
        });
      });
      box.append(form);
    }
    target.append(box);
  }
}
async function refresh() {
  const [news, mine] = await Promise.all([api('announcements'), api('feedback')]);
  $('announcements').replaceChildren(...news.announcements.map(card));
  if (!news.announcements.length) $('announcements').append(node('p', '暂时没有运营公告。'));
  try { localStorage.setItem('parlor-announcements-seen', JSON.stringify(news.announcements.map(item => item.id))); } catch {}
  feedbackList($('feedback'), mine.feedback);
}
async function inbox() {
  const data = await api('operator/feedback', undefined, true);
  feedbackList($('operator-feedback'), data.feedback, true);
  await Promise.all([loadAnnouncementList(), loadNewsList()]);
}
async function loadAnnouncementList() {
  const target = $('operator-announcement-list');
  try {
    const data = await api('operator/announcements?limit=20', undefined, true);
    const items = Array.isArray(data.announcements) ? data.announcements : [];
    target.replaceChildren();
    if (!items.length) { target.append(node('p', '还没有公告。')); return; }
    for (const item of items) {
      const box = document.createElement('article');
      box.append(
        node('small', `${new Date(item.created_at).toLocaleString()} · ${item.id}${Number(item.revision ?? 1) > 1 ? ` · 改过 ${Number(item.revision) - 1} 次` : ''}`),
        node('p', item.text),
      );
      const form = document.createElement('form');
      const label = node('label', '改这条公告（改完不会重新弹横幅）');
      const text = document.createElement('textarea');
      text.maxLength = 2000; text.required = true; text.rows = 3; text.value = item.text;
      label.append(text);
      const save = node('button', '保存修改'); save.type = 'submit';
      form.append(label, save);
      form.addEventListener('submit', event => {
        event.preventDefault();
        void perform(save, async () => {
          // 带上页面看到的版本与这一条发布：另一个标签页先保存过、或者这条已经被删掉
          // 用同一个 requestId 重发过，这里都会被拒，不会悄悄覆盖新的一条。
          await api('operator/announcements', {
            id: item.id, text: text.value.trim(), revision: Number(item.revision ?? 1), publishId: item.publishId,
          }, true, 'PATCH');
          status('公告已更新。'); await loadAnnouncementList(); if (cfg?.token) await refresh();
        });
      });
      const remove = node('button', '删除'); remove.type = 'button';
      remove.addEventListener('click', () => {
        if (!confirm(`删除这条公告？横幅和列表里都会消失，发了就找不回来（原文只在留痕里）。\n\n${item.text.slice(0, 100)}`)) return;
        void perform(remove, async () => {
          await api(`operator/announcements?id=${encodeURIComponent(item.id)}&revision=${encodeURIComponent(item.revision ?? 1)}&publishId=${encodeURIComponent(item.publishId)}`, undefined, true, 'DELETE');
          status('公告已删除。'); await loadAnnouncementList(); if (cfg?.token) await refresh();
        });
      });
      // 删除跟着表单放，两个按钮排在同一行，不用各占一行。
      form.append(remove);
      box.append(form);
      target.append(box);
    }
  } catch (error) {
    target.replaceChildren(node('p', error.message || '读不到公告列表。'));
  }
}
async function loadNewsList() {
  const target = $('operator-news-list');
  try {
    // 走运营钥匙：席位查询读不到未到点的预录条目，只有运营钥匙的浏览器也调不动。
    const data = await api('operator/news?limit=10', undefined, true);
    const items = Array.isArray(data.news) ? data.news : [];
    target.replaceChildren();
    if (!items.length) { target.append(node('p', '还没有新闻。')); return; }
    for (const item of items) {
      const box = document.createElement('article');
      // 列表含未到可见时刻的预录条目；这里标出来，免得运营以为已经推了。
      const edited = Number(item.revision ?? 1) > 1 ? ` · 改过 ${Number(item.revision) - 1} 次` : '';
      box.append(node('p', `${item.issueDate} · ${item.title} · ${item.publishAt <= Date.now() ? '已可见' : '未到可见时刻'}${edited}`));
      const edit = node('button', '编辑'); edit.type = 'button';
      edit.addEventListener('click', () => {
        void perform(edit, async () => {
          const data = await api(`operator/news?id=${encodeURIComponent(item.id)}`, undefined, true);
          if (data.news) fillNewsForm(data.news);
        });
      });
      const remove = node('button', '删除'); remove.type = 'button';
      remove.addEventListener('click', () => {
        if (!confirm(`删除 ${item.issueDate} 这一期？大厅小报会立刻下掉；已经推给 Coo 的文本收不回来。\n\n删掉之后同一天可以重发一条。`)) return;
        void perform(remove, async () => {
          const data = await api(`operator/news?id=${encodeURIComponent(item.id)}&publishId=${encodeURIComponent(item.publishId)}`, undefined, true, 'DELETE');
          if (editingNewsId === item.id) cancelNewsEdit();
          status(data.deleted ? '已删除，原文留在留痕里。' : '这一期本来就不在了。');
          await loadNewsList();
        });
      });
      const actions = document.createElement('p');
      actions.append(edit, remove);
      box.append(actions);
      target.append(box);
    }
  } catch (error) {
    target.replaceChildren(node('p', error.message || '读不到新闻列表。'));
  }
}
async function perform(button, task) {
  button.disabled = true;
  try { await task(); } catch (error) { status(error.message || '网络没有回话，请重试。'); }
  finally { button.disabled = false; }
}
$('refresh').addEventListener('click', event => { void perform(event.target, async () => {
  await refresh(); if (operatorKey) await inbox(); status('已刷新。');
}); });
$('feedback-form').addEventListener('submit', event => {
  event.preventDefault();
  void perform(event.submitter, async () => {
    const text = $('feedback-text').value.trim();
    if (!feedbackRequest || feedbackRequest.text !== text) feedbackRequest = { text, requestId: crypto.randomUUID() };
    const data = await api('feedback', feedbackRequest);
    $('feedback-text').value = ''; feedbackRequest = null;
    status(`反馈已保存，编号 ${data.feedback.id}。不代表运营者已读。`); await refresh();
  });
});
$('operator-login').addEventListener('submit', event => {
  event.preventDefault(); operatorKey = $('operator-key').value; $('operator-key').value = '';
  void perform(event.submitter, async () => {
    try { await inbox(); } catch (error) { operatorKey = ''; throw error; }
    $('operator-panel').hidden = false; $('operator-login').hidden = true; status('运营工作台已打开。');
  });
});
$('operator-logout').addEventListener('click', () => {
  operatorKey = ''; $('operator-panel').hidden = true; $('operator-login').hidden = false;
  $('operator-feedback').replaceChildren(); $('operator-news-list').replaceChildren();
  $('operator-announcement-list').replaceChildren();
  $('announcement-text').value = ''; announcementRequest = null; cancelNewsEdit(); status('已退出运营工作台。');
});
$('announcement-form').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('announcement-text').value.trim();
  if (!confirm(`这条公告将对所有 Coo 和真人可见：\n\n${text}\n\n确认发布？`)) return;
  void perform(event.submitter, async () => {
    if (!announcementRequest || announcementRequest.text !== text) announcementRequest = { text, requestId: crypto.randomUUID() };
    await api('operator/announcements', announcementRequest, true);
    $('announcement-text').value = ''; announcementRequest = null; status('公告已发布。');
    if (cfg?.token) await refresh();
  });
});
function resetNewsForm() {
  $('news-date').value = beijingToday(); $('news-date').disabled = false;
  $('news-title').value = ''; $('news-summary').value = ''; $('news-body').value = '';
  $('news-time').value = '10:00'; $('news-time').disabled = false; $('news-time').removeAttribute('title');
  $('news-autopush').checked = true; newsRequest = null;
  editingNewsPublishId = ''; editingNewsRevision = 1; editingNewsTime = '';
}
/** 把已有的一期灌回表单：改稿时不换日期，只换内容与可见设置。 */
function fillNewsForm(item) {
  editingNewsId = item.id;
  editingNewsPublishId = String(item.publishId ?? '');
  editingNewsRevision = Number(item.revision ?? 1);
  $('news-mode').hidden = false; $('news-mode-id').textContent = item.id;
  $('news-date').value = item.issueDate; $('news-date').disabled = true;
  $('news-title').value = item.title; $('news-summary').value = item.summary; $('news-body').value = item.body;
  // publishAt 是毫秒时间戳；按北京时间折回 HH:MM，别用本地时区。
  editingNewsTime = new Date(item.publishAt + 8 * 3600000).toISOString().slice(11, 16);
  $('news-time').value = editingNewsTime;
  // 已可见的新闻不能改期：改晚会让 Coo 的 publishAt 游标再收到同一个 id，等于重推。
  const visible = item.publishAt <= Date.now();
  $('news-time').disabled = visible;
  if (visible) $('news-time').title = '已可见，不能改期；要换时间只能删掉重发';
  else $('news-time').removeAttribute('title');
  $('news-autopush').checked = Boolean(item.autoPush);
  $('news-submit').textContent = '保存修改'; $('news-cancel').hidden = false;
  newsRequest = null;
  $('news-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function cancelNewsEdit() {
  editingNewsId = '';
  $('news-mode').hidden = true; $('news-mode-id').textContent = '';
  $('news-submit').textContent = '发布新闻'; $('news-cancel').hidden = true;
  resetNewsForm();
}
$('news-cancel').addEventListener('click', () => { cancelNewsEdit(); status('已取消修改。'); });
$('news-date').addEventListener('change', () => {
  // 补录历史默认不推送；改回今天或未来时再恢复，避免把旧闻补推给所有人。
  $('news-autopush').checked = $('news-date').value >= beijingToday();
});
$('news-form').addEventListener('submit', event => {
  event.preventDefault();
  const issueDate = $('news-date').value;
  const title = $('news-title').value.trim();
  const summary = $('news-summary').value.trim();
  const body = $('news-body').value.trim();
  const autoPush = $('news-autopush').checked;
  const time = $('news-time').value;
  if (!title || !summary || !body) { status('标题、摘要、正文都要填。'); return; }
  // 回填只到分钟；没动过时间就不提交 publishAt，否则会把原来的秒数抹成 :00。
  const timeChanged = !editingNewsId || time !== editingNewsTime;
  const publishAt = time && timeChanged ? Date.parse(`${(issueDate || beijingToday())}T${time}:00+08:00`) : undefined;
  if (time && timeChanged && !Number.isFinite(publishAt)) { status('日期或可见时刻格式不对。'); return; }

  // 改稿：只 PATCH 内容与可见设置，日期与编号不动。
  if (editingNewsId) {
    if (!confirm(`保存对 ${editingNewsId} 的修改？\n\n改完不会重新推给 Coo，但大厅小报下一次刷新就是新文本。`)) return;
    void perform(event.submitter, async () => {
      const payload = {
        id: editingNewsId, publishId: editingNewsPublishId, revision: editingNewsRevision,
        title, summary, body, autoPush, ...(publishAt ? { publishAt } : {}),
      };
      const data = await api('operator/news', payload, true, 'PATCH');
      status(data.changed ? `已保存：${data.news.id}（第 ${data.news.revision} 版）` : '没有变化，未改动。');
      cancelNewsEdit(); await loadNewsList();
    });
    return;
  }

  if (!issueDate) { status('日期、标题、摘要、正文都要填。'); return; }
  const key = JSON.stringify({ issueDate, title, summary, body, autoPush, publishAt });
  if (!confirm(`这一期新闻将出现在「${issueDate}」：\n\n${title}\n\n${autoPush ? '到点后自动推送给在线 Coo。' : '不自动推送，只能主动查。'}\n确认发布？`)) return;
  void perform(event.submitter, async () => {
    if (!newsRequest || newsRequest.key !== key) {
      newsRequest = { key, body: { issueDate, title, summary, body, autoPush, ...(publishAt ? { publishAt } : {}) } };
    }
    const data = await api('operator/news', newsRequest.body, true);
    newsRequest = null;
    status(`已发布：${data.news.id}（${data.news.issueDate}${data.news.autoPush ? '，到点自动推送' : '，不自动推送'}）`);
    resetNewsForm();
    await loadNewsList();
  });
});
resetNewsForm();
void refresh().catch(error => status(error.message));
setInterval(() => { if (!document.hidden && cfg?.token) void refresh().catch(() => {}); }, 60000);
