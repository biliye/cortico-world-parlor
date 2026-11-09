const $ = id => document.getElementById(id);
let cfg;
try { cfg = JSON.parse(localStorage.getItem('parlor-play-v1') || 'null'); } catch {}
let operatorKey = '';
let feedbackRequest = null;
let announcementRequest = null;
let newsRequest = null;
const status = text => { $('status').textContent = text; };
const beijingToday = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
async function api(path, body, operator = false) {
  const token = operator ? operatorKey : cfg?.token;
  if (!token) throw new Error('请先回会馆加入席位，再打开反馈与公告。');
  const res = await fetch(`/v1/support/${path}`, { method: body ? 'POST' : 'GET',
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
  await loadNewsList();
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
      // 列表含未到可见时刻的预录条目；这里标出来，免得运营以为已经推了。
      target.append(node('p', `${item.issueDate} · ${item.title} · ${item.publishAt <= Date.now() ? '已可见' : '未到可见时刻'}`));
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
  $('announcement-text').value = ''; announcementRequest = null; resetNewsForm(); status('已退出运营工作台。');
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
  $('news-date').value = beijingToday();
  $('news-title').value = ''; $('news-summary').value = ''; $('news-body').value = '';
  $('news-time').value = '10:00'; $('news-autopush').checked = true; newsRequest = null;
}
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
  if (!issueDate || !title || !summary || !body) { status('日期、标题、摘要、正文都要填。'); return; }
  const publishAt = time ? Date.parse(`${issueDate}T${time}:00+08:00`) : undefined;
  if (time && !Number.isFinite(publishAt)) { status('日期或可见时刻格式不对。'); return; }
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
