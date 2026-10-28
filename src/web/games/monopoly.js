/** 大富翁：7×7 外圈棋盘、地产、道具、托管。规则与金额全在服务器。 */
import {
  el, clear, btn, fmtClock, clockSpan, playerClass,
} from '../common.js';

const randomId = () => (
  globalThis.crypto && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
);

const CELL_NOTE = (cell) => {
  if (cell.kind === 'property') return '¥' + cell.price;
  if (cell.kind === 'subsidy') return '+' + cell.amount;
  if (cell.kind === 'fee') return '-' + cell.amount;
  if (cell.kind === 'maintenance') return '每升 -' + cell.perUpgrade;
  if (cell.kind === 'workshop') return '补卡';
  if (cell.kind === 'park') return '公园';
  if (cell.kind === 'start') return '起点';
  return '';
};

const itemLabel = (rules, item) => (rules && rules.itemLabels && rules.itemLabels[item]) || item;

export function mountMonopoly(root, ctx) {
  const box = el('section', 'panel game-mono');
  root.append(box);
  let view = null;
  const uiState = { steps: 3, repair: null };

  return {
    update(next) {
      view = next;
      render();
    },
    destroy() {
      box.remove();
    },
  };

  function render() {
    clear(box);
    const table = view.table;
    const priv = view.priv;
    const me = view.me;
    const names = view.names;
    const players = Array.isArray(table.players) ? table.players : [];
    const board = Array.isArray(table.board) ? table.board : [];
    const rules = table.rules || {};
    const props = Array.isArray(table.properties) ? table.properties : [];
    const seated = players.some((player) => player.id === me.id);
    const seatIndex = (id) => players.findIndex((player) => player.id === id);

    const head = el('div', 'game-head');
    head.append(el('h2', '', '大富翁'));
    head.append(el('span', 'meta', '第 ' + (table.round || 0) + '/' + (table.rounds || 12) + ' 轮'));
    head.append(el('span', 'meta', '轮到 ' + (names.get(table.turn) || '？')));
    head.append(el('span', 'meta', table.phase === 'prepare' ? '准备' : table.phase === 'buy' ? '买地' : table.phase === 'upgrade' ? '升级' : '工坊'));
    box.append(head);

    if (!board.length) {
      box.append(el('p', 'warn', '服务器没有给棋盘（版本可能旧了）。'));
      return;
    }

    const boardEl = el('div', 'board');
    const turnPlayer = players.find((player) => player.id === table.turn);
    const mePlayer = players.find((player) => player.id === me.id);
    for (const cell of board) {
      const cellEl = el('div', 'cell pos-' + cell.index + ' kind-' + cell.kind
        + (cell.group ? ' g-' + cell.group : '')
        + (turnPlayer && turnPlayer.pos === cell.index ? ' turn' : '')
        + (mePlayer && mePlayer.pos === cell.index ? ' mine' : ''));
      cellEl.append(el('div', 'cname', cell.name));
      cellEl.append(el('div', 'cprice', CELL_NOTE(cell)));
      const owned = props.find((property) => property.index === cell.index);
      if (owned && owned.owner) {
        const owner = players.find((player) => player.id === owned.owner);
        const bar = el('div', 'ownerbar ' + (owner ? playerClass(seatIndex(owner.id)) : ''));
        cellEl.append(bar);
        if (owned.level > 0) cellEl.append(el('span', 'level', 'L' + owned.level));
      }
      const here = players.filter((player) => player.pos === cell.index);
      if (here.length) {
        const tokens = el('div', 'tokens');
        for (const player of here) {
          const token = el('span', 'token ' + playerClass(seatIndex(player.id)) + (player.id === me.id ? ' me' : ''));
          token.textContent = (player.name || '?').slice(0, 1);
          token.title = player.name + (player.id === me.id ? '（你）' : '');
          tokens.append(token);
        }
        cellEl.append(tokens);
      }
      boardEl.append(cellEl);
    }

    const center = el('div', 'board-center');
    const h = el('div', 'h');
    h.append(el('strong', '', '第 ' + (table.round || 0) + '/' + (table.rounds || 12) + ' 轮'));
    h.append(el('span', 'muted', '轮到 ' + (names.get(table.turn) || '？')));
    if (table.deadline) {
      h.append(el('span', 'clock', '截止 ' + fmtClock(table.deadline)));
      h.append(clockSpan(table.deadline, 'clock'));
    }
    center.append(h);

    const playersEl = el('div', 'mono-players');
    players.forEach((player) => {
      const row = el('div', 'mono-player' + (player.id === table.turn ? ' turn' : ''));
      row.append(el('span', 'token ' + playerClass(seatIndex(player.id)), (player.name || '?').slice(0, 1)));
      row.append(el('span', 'nm', player.name + (player.id === me.id ? '（你）' : '')));
      const tags = [];
      if (player.auto) tags.push('托管');
      if (player.bankrupt) tags.push('破产');
      if (player.properties) tags.push(player.properties + ' 块地');
      if (tags.length) row.append(el('span', 'meta', tags.join(' · ')));
      row.append(el('span', 'cash', '¥' + player.cash));
      playersEl.append(row);
    });
    center.append(playersEl);

    if (priv) {
      const mine = el('div', 'mono-my');
      mine.append(el('span', '', '现金 '), el('b', '', '¥' + priv.cash));
      mine.append(el('span', '', '位置 '), el('b', '', priv.position || ('#' + priv.pos)));
      const items = priv.items || {};
      const held = Object.entries(items).filter(([, count]) => count > 0)
        .map(([item, count]) => itemLabel(rules, item) + '×' + count).join('、');
      mine.append(el('span', '', '道具 '), el('b', '', held || '没有'));
      const owned = (priv.properties || []).map((property) => property.name + (property.level ? ' L' + property.level : ''));
      mine.append(el('span', '', '我的地 '), el('b', '', owned.join('、') || '还没有'));
      center.append(mine);
    }

    if (Array.isArray(table.last) && table.last.length) {
      const facts = el('div', 'mono-facts');
      for (const fact of table.last.slice(-3)) facts.append(el('div', '', '· ' + fact));
      center.append(facts);
    }

    const legal = priv ? priv.legal : null;
    const actions = el('div', 'mono-actions');
    if (table.status === 'ended') {
      const ended = table.ended;
      if (ended && Array.isArray(ended.ranking)) {
        const ranking = el('div', 'ranking');
        ended.ranking.forEach((row, index) => {
          const line = el('div', 'rank');
          line.append(el('span', 'place', '#' + (index + 1)));
          line.append(el('span', 'who', names.get(row.seatId) || row.seatId));
          line.append(el('span', 'detail', '现金 ' + row.cash + ' + 地产 ' + row.propertyValue + ' = ' + row.assets));
          ranking.append(line);
        });
        center.append(ranking);
      }
      actions.append(btn('回大厅', () => ctx.showLobby(), { small: true }));
      center.append(actions);
      boardEl.append(center);
      box.append(boardEl);
      return;
    }

    if (seated) {
      const myAuto = (table.seats || []).some((seat) => seat.id === me.id && seat.auto === true);
      actions.append(btn(myAuto ? '取消托管' : '托管这一局', () => {
        actMono('set_auto', { on: !myAuto });
      }, { small: true, ghost: true }));
    }

    if (!seated) {
      actions.append(el('span', 'muted', '你在旁观；这一局结束后可以坐下一桌。'));
    } else if (!priv || !priv.yourTurn || !legal) {
      actions.append(el('span', 'muted', '等 ' + (names.get(table.turn) || '？') + ' 行动。'));
    } else if (legal.phase === 'prepare') {
      actions.append(btn('掷骰', () => actMono('roll'), { primary: true }));
      const items = Array.isArray(legal.items) ? legal.items : [];
      if (items.includes('signpost')) {
        const steps = el('select');
        steps.setAttribute('aria-label', '路标卡走几格');
        for (let value = 1; value <= 6; value += 1) {
          const option = el('option', '', value + ' 格');
          option.value = String(value);
          if (value === uiState.steps) option.selected = true;
          steps.append(option);
        }
        steps.addEventListener('change', () => { uiState.steps = Number(steps.value) || 3; });
        actions.append(steps, btn('用路标卡', () => actMono('use_item', { item: 'signpost', steps: uiState.steps }), { small: true }));
      }
      if (items.includes('pass')) {
        actions.append(btn('用通行卡', () => actMono('use_item', { item: 'pass' }), { small: true }));
      }
      const targets = Array.isArray(legal.repairTargets) ? legal.repairTargets : [];
      if (items.includes('repair') && targets.length) {
        if (!targets.some((target) => target.index === uiState.repair)) uiState.repair = targets[0].index;
        const target = el('select');
        target.setAttribute('aria-label', '修缮卡修哪块地');
        for (const entry of targets) {
          const option = el('option', '', entry.index + ' ' + (board[entry.index] ? board[entry.index].name : '') + '（¥' + entry.cost + '）');
          option.value = String(entry.index);
          if (entry.index === uiState.repair) option.selected = true;
          target.append(option);
        }
        target.addEventListener('change', () => { uiState.repair = Number(target.value); });
        actions.append(target, btn('用修缮卡', () => actMono('use_item', { item: 'repair', target: uiState.repair }), { small: true }));
      }
      if ((priv.items || {}).repair > 0 && !items.includes('repair')) {
        actions.append(el('span', 'dim', '修缮卡：现在没有可半价升级的地。'));
      }
    } else if (legal.phase === 'buy') {
      const cell = board[legal.pending];
      const price = cell && cell.price ? cell.price : 0;
      actions.append(el('span', 'muted', (cell ? cell.name + '：¥' + price : '这块地')));
      actions.append(btn(legal.canBuy ? '买下（¥' + price + '）' : '买不起', () => actMono('buy'), {
        primary: true,
        disabled: !legal.canBuy,
      }));
      actions.append(btn('放弃', () => actMono('pass')));
    } else if (legal.phase === 'upgrade') {
      const cell = board[legal.pending];
      const price = cell && cell.upgrade ? cell.upgrade : 0;
      actions.append(el('span', 'muted', (cell ? cell.name : '这块地') + '：升级 ¥' + price));
      actions.append(btn(legal.canUpgrade ? '升级（¥' + price + '）' : '升级不起', () => actMono('upgrade'), {
        primary: true,
        disabled: !legal.canUpgrade,
      }));
      actions.append(btn('放弃', () => actMono('pass')));
    } else if (legal.phase === 'workshop') {
      actions.append(el('span', 'muted', '工坊：补一张道具'));
      for (const item of (legal.workshop || [])) {
        actions.append(btn('补' + itemLabel(rules, item), () => actMono('take_item', { item }), { small: true }));
      }
      actions.append(btn('放弃', () => actMono('pass')));
    }

    center.append(actions);
    boardEl.append(center);
    box.append(boardEl);
  }

  function actMono(action, extra = {}) {
    const priv = view.priv;
    const body = { type: 'monopoly', action, requestId: randomId(), ...extra };
    if (priv && typeof priv.turnSeq === 'number') body.turnId = priv.turnSeq;
    return ctx.act(body).catch(() => {});
  }
}
