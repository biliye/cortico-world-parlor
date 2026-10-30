/** 网页客户端共用的小工具：建节点、图标、时间、牌面、按钮。 */

export const el = (tag, cls = '', text = '') => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== '') node.textContent = text;
  return node;
};

/** play.html 里那组 <symbol>：只建引用，不内联路径。 */
export const icon = (name, cls = '') => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
};

/** 名字的第一个字（emoji 也按一个字符算）。 */
export const initialOf = (name) => {
  const chars = Array.from(String(name || '？').trim());
  return chars[0] || '？';
};

/** 服务器有些旧文案还是「底池 / 底注 / 净胜」；网页统一换成奶油客厅的字。
 *  只改显示，不改事件与账本本身。 */
const RENAME = {
  底池: '彩头',
  底注: '每局',
  今晚净胜: '今晚的小收获',
  净胜: '小收获',
};

export const readable = (text) => {
  let out = String(text ?? '');
  for (const [from, to] of Object.entries(RENAME)) out = out.split(from).join(to);
  return out;
};

export const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
};

export const pad = (value) => String(value).padStart(2, '0');

/** 服务器时刻（UTC+8）的 HH:MM:SS。 */
export const fmtClock = (ts) => new Date(ts + 8 * 3600 * 1000).toISOString().slice(11, 19);

/** 服务器时刻（UTC+8）的 MM-DD HH:MM；报名、整局这种跨天的截止用它。 */
export const fmtDateTime = (ts) => new Date(ts + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');

/** 距离截止还剩多久；到期就写「已截止」。 */
export const fmtLeft = (deadline, now) => {
  if (!deadline) return '';
  const left = Math.max(0, deadline - now);
  if (left <= 0) return '已截止';
  const total = Math.ceil(left / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
};

/** 把 deadline 塞进一个跟随秒针的 span；外层每 500ms 统一刷新。 */
export const clockSpan = (deadline, cls = '') => {
  const span = el('span', cls);
  if (deadline) span.dataset.deadline = String(deadline);
  else span.textContent = '';
  return span;
};

export const cardLabel = (card) => {
  if (card === 'SJ') return '小王';
  if (card === 'BJ') return '大王';
  return String(card);
};

export const cardClass = (card) => {
  if (card === 'SJ' || card === 'BJ') return ' joker';
  if (card === '2') return ' red';
  return '';
};

const PIPS = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

export const dieNode = (value) => {
  const die = el('div', 'die');
  die.setAttribute('aria-label', value + ' 点');
  const on = new Set(PIPS[value] || []);
  for (let i = 0; i < 9; i += 1) die.append(el('span', 'pip' + (on.has(i) ? ' on' : '')));
  return die;
};

export const isNearBottom = (node, slack = 48) => (
  node.scrollHeight - node.scrollTop - node.clientHeight < slack
);

export const btn = (label, onClick, options = {}) => {
  const node = el('button', 'btn'
    + (options.primary ? ' primary' : '')
    + (options.ghost ? ' ghost' : '')
    + (options.danger ? ' danger' : '')
    + (options.small ? ' small' : ''));
  node.type = 'button';
  node.textContent = label;
  if (options.disabled) node.disabled = true;
  if (options.title) node.title = options.title;
  if (onClick) node.addEventListener('click', onClick);
  return node;
};

/** 牌面雪碧图的格子：13 列（A 2 3 … K）× 5 行（♠ ♥ ♣ ♦，最后一行左大王、右小王）。 */
const SPRITE_COLS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SPRITE_ROWS = { S: 0, H: 1, C: 2, D: 3 };

/** 牌面图拉没拉过：idle / loading / ready / missing。 */
let cardArtState = 'idle';

/** 给一张牌画上真牌面；服务器没给花色（老回放、或没装图）就只留文字。 */
export const paintCard = (node, rank, suit) => {
  probeCardArt();
  const row = suit && SPRITE_ROWS[suit] !== undefined ? SPRITE_ROWS[suit] : 4;
  const col = row === 4 ? (rank === 'BJ' ? 0 : 1) : SPRITE_COLS.indexOf(rank);
  if (col < 0) return node;
  node.classList.add('has-art');
  node.style.setProperty('--c', String(col));
  node.style.setProperty('--r', String(row));
  return node;
};

/**
 * 牌面雪碧图 346KB。以前在首屏就拉，跨境链路上它把登录的几个来回挤到十几秒；
 * 改成第一次真要画牌时才拉：图没到先按点数画，到了挂 `card-art-ready` 由 CSS 切牌面，
 * 缺图就挂 `no-card-art` 永远用文字。
 */
export const probeCardArt = () => {
  if (cardArtState !== 'idle') return;
  cardArtState = 'loading';
  const img = new Image();
  img.addEventListener('load', () => {
    cardArtState = 'ready';
    document.documentElement.classList.add('card-art-ready');
  });
  img.addEventListener('error', () => {
    cardArtState = 'missing';
    document.documentElement.classList.add('no-card-art');
  });
  img.src = '/play/assets/assets/cards/cards.webp';
};

export const cardButton = (card, selected, onClick, small = false, art = null) => {
  const node = el('button', 'pcard' + cardClass(card) + (selected ? ' sel' : '') + (small ? ' small-card' : ''));
  node.type = 'button';
  node.textContent = cardLabel(card);
  if (onClick) {
    node.setAttribute('aria-pressed', selected ? 'true' : 'false');
    node.setAttribute('aria-label', cardLabel(card));
  }
  if (art) paintCard(node, art.rank ?? card, art.suit ?? null);
  node.disabled = !onClick;
  if (onClick) node.addEventListener('click', onClick);
  return node;
};

export const playerClass = (index) => 's' + (index % 6);

export const GAME_LABELS = { dice: '骰子', ddz: '斗地主', monopoly: '大富翁' };
export const STATUS_LABELS = { open: '等人', bidding: '叫地主', playing: '进行中', ended: '已结束' };
export const KIND_LABELS = { pet: 'Coo', human: '人', observer: '观看' };
export const TIER_LABELS = { full: '热闹', digest: '摘要', quiet: '只 @', off: '离开' };
