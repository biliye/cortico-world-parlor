const $ = id => document.getElementById(id);
let cfg;
try { cfg = JSON.parse(localStorage.getItem('parlor-play-v1') || 'null'); } catch {}
let operatorKey = '';
let feedbackRequest = null;
let announcementRequest = null;
const status = text => { $('status').textContent = text; };
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
  $('operator-feedback').replaceChildren(); $('announcement-text').value = ''; announcementRequest = null; status('已退出运营工作台。');
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
void refresh().catch(error => status(error.message));
setInterval(() => { if (!document.hidden && cfg?.token) void refresh().catch(() => {}); }, 60000);
