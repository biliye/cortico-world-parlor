/** 骰子桌（奶油客厅）：每人两颗暗骰，轮到你可以重掷一颗，或停牌。
 *  规则与数值全在服务器；这里只摆桌面、骰子与按钮。 */
import {
  el, clear, btn, dieNode, clockSpan, icon, initialOf,
} from '../common.js';

const SLOTS_BY_COUNT = {
  1: [0],
  2: [0, 2],
  3: [0, 1, 3],
  4: [0, 1, 2, 3],
};

export function mountDice(root, ctx) {
  const box = el('section', 'game-dice');
  root.append(box);
  let view = null;
  let rolling = false;
  let rollTimer = 0;

  return {
    update(next) {
      view = next;
      render();
    },
    destroy() {
      clearTimeout(rollTimer);
      box.remove();
    },
  };

  function render() {
    clear(box);
    const table = view.table;
    const priv = view.priv;
    const me = view.me;
    const seats = table.seats || [];
    const seated = seats.some((seat) => seat.id === me.id);
    const names = view.names;

    const stage = el('div', 'table-stage');
    stage.append(pendant());
    const tableEl = el('div', 'table');
    const felt = el('div', 'table-felt');
    felt.append(
      el('div', 'felt-noise'),
      el('div', 'table-mark', '聚'),
      el('div', 'table-ring table-ring-1'),
      el('div', 'table-ring table-ring-2'),
    );

    const layout = layoutSeats(seats, me.id);
    const used = new Set();
    for (const entry of layout) {
      used.add(entry.slot);
      felt.append(seatNode(entry.seat, entry.slot, table, priv, me, view));
    }
    for (let slot = 0; slot < 4; slot += 1) {
      if (!used.has(slot)) felt.append(el('div', 'tseat-empty tseat-pos-' + slot, '空位'));
    }

    if (table.stake > 0 && seats.length > 1) {
      const pot = el('div', 'pot');
      const stack = el('div', 'chip-stack chip-stack-pot');
      stack.setAttribute('aria-hidden', 'true');
      for (const cls of ['chip-cream', 'chip-red', 'chip-green', 'chip-blue']) {
        stack.append(el('i', 'chip ' + cls));
      }
      const meta = el('div', 'pot-meta');
      meta.append(el('span', '', '彩头'), el('strong', '', String(table.stake * seats.length)));
      pot.append(stack, meta);
      felt.append(pot);
    }

    felt.append(cup());

    const tray = diceTray(table, priv, me, seated);
    felt.append(tray.node, el('div', 'dice-caption', tray.caption));

    tableEl.append(felt);
    stage.append(tableEl);
    box.append(stage);

    const actionBar = el('div', 'action-bar');
    const main = el('div', 'action-main');
    const note = el('p', 'action-note');

    if (table.status === 'ended') {
      const winners = (table.revealed || []).filter((entry) => (table.winners || []).includes(entry.id));
      const title = (table.winners || []).length > 1 ? '平局：' : '赢家：';
      const namesText = winners.map((entry) => entry.name + '（' + entry.total + ' 点）').join('、');
      const line = el('div', 'action-main');
      line.append(el('span', 'good', title + (namesText || '—')));
      main.append(line);
      main.append(btn('回大厅', () => ctx.showLobby(), { small: true }));
    } else if (priv && priv.yourTurn) {
      const left = priv.rerollsLeft || 0;
      main.append(btn('重掷第 1 颗', () => reroll(0), { disabled: left <= 0 }));
      main.append(btn('重掷第 2 颗', () => reroll(1), { disabled: left <= 0 }));
      main.append(btn('停牌', () => {
        ctx.act({ type: 'table_action', action: 'stand' }).catch(() => {});
      }, { primary: true }));
      const total = (priv.dice || []).reduce((sum, value) => sum + value, 0);
      note.append(document.createTextNode('你的合计 ' + total + ' 点 · 还能重掷 ' + left + ' 次'));
      if (priv.deadline) {
        note.append(document.createTextNode(' · '), clockSpan(priv.deadline, 'clock'));
      }
    } else if (seated) {
      note.append(document.createTextNode('等 ' + (names.get(table.turn) || '？') + ' 行动'));
      if (table.deadline) note.append(document.createTextNode(' · '), clockSpan(table.deadline, 'clock'));
    } else {
      note.append(document.createTextNode('你在旁观；桌上至少两个人，发起人才能开局。'));
    }

    actionBar.append(main, note);
    box.append(actionBar);

    function reroll(die) {
      if (rolling) return;
      rolling = true;
      render();
      clearTimeout(rollTimer);
      rollTimer = setTimeout(() => {
        rolling = false;
        render();
      }, 650);
      ctx.act({ type: 'table_action', action: 'roll', die }).catch(() => {});
    }
  }

  function seatNode(seat, slot, table, priv, me, view) {
    const mine = seat.id === me.id;
    const info = (view.seats || []).find((entry) => entry.id === seat.id);
    const isPet = !!(info && info.kind === 'pet');
    const node = el('div', 'tseat tseat-pos-' + slot
      + (mine ? ' is-you' : '')
      + (seat.id === table.turn && table.status === 'playing' ? ' is-turn' : ''));
    const avatar = el('span', ['avatar', isPet ? 'avatar-coo' : (view.classes.get(seat.id) || 's0')].join(' '),
      initialOf(seat.name));
    if (view.online.includes(seat.id)) avatar.append(el('span', 'status-dot online'));
    if (isPet) {
      const badge = el('span', 'avatar-badge');
      badge.append(icon('spark'));
      avatar.append(badge);
    }
    node.append(avatar);

    const revealed = (table.revealed || []).find((entry) => entry.id === seat.id);
    const own = mine && priv && Array.isArray(priv.dice) && priv.dice.length ? priv.dice : null;
    const values = own || (revealed ? revealed.dice : null);
    const total = values ? values.reduce((sum, value) => sum + value, 0) : null;

    const meta = el('div', 'tseat-meta');
    const name = el('span', 'tseat-name', seat.name + (mine ? '（你）' : ''));
    if (isPet) name.append(el('span', 'tag tag-coo', 'Coo'));
    meta.append(name);
    let stateText;
    if (seat.stood) stateText = total !== null ? '已停牌 · ' + total + ' 点' : '已停牌';
    else if (seat.id === table.turn && table.status === 'playing') {
      stateText = total !== null ? '轮到这一位 · ' + total + ' 点' : '轮到这一位';
    } else if (total !== null) stateText = '合计 ' + total + ' 点';
    else stateText = '暗骰';
    meta.append(el('span', 'tseat-state', stateText));
    node.append(meta);
    return node;
  }

  function diceTray(table, priv, me, seated) {
    let values = null;
    let caption = '暗骰 · 停牌或重掷后亮出';
    if (seated && priv && Array.isArray(priv.dice) && priv.dice.length) {
      values = priv.dice;
      caption = '你的骰子 · 合计 ' + values.reduce((sum, value) => sum + value, 0) + ' 点';
    } else if (table.status === 'ended' && (table.revealed || []).length) {
      const best = [...table.revealed].sort((a, b) => b.total - a.total)[0];
      values = best.dice;
      caption = best.name + ' · ' + best.total + ' 点';
    }
    const tray = el('div', 'dice-tray' + (rolling ? ' is-rolling' : ''));
    if (values) {
      for (const value of values) tray.append(dieNode(value));
    } else {
      tray.append(el('div', 'die-placeholder', '还没有亮出的骰子'));
    }
    return { node: tray, caption };
  }
}

function layoutSeats(seats, meId) {
  const slots = SLOTS_BY_COUNT[Math.min(seats.length, 4)] || SLOTS_BY_COUNT[4];
  const ordered = [...seats];
  const index = ordered.findIndex((seat) => seat.id === meId);
  if (index > 0) ordered.unshift(...ordered.splice(index, 1));
  return ordered.slice(0, 4).map((seat, slotIndex) => ({ seat, slot: slots[slotIndex] ?? slotIndex % 4 }));
}

function pendant() {
  const box = el('div', 'pendant');
  box.setAttribute('aria-hidden', 'true');
  box.append(
    el('span', 'pendant-cord'),
    el('span', 'pendant-shade'),
    el('span', 'pendant-bulb'),
    el('span', 'pendant-glow'),
  );
  return box;
}

function cup() {
  const box = el('div', 'dice-cup');
  box.setAttribute('aria-hidden', 'true');
  box.append(el('span', 'cup-body'), el('span', 'cup-mouth'), el('span', 'cup-band'));
  return box;
}
