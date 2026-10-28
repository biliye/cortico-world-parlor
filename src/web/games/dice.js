/** 骰子桌：每人两颗暗骰，轮到你可以重掷一颗，或停牌。 */
import { el, clear, btn, dieNode, clockSpan, fmtClock } from '../common.js';

export function mountDice(root, ctx) {
  const box = el('section', 'panel game-dice');
  root.append(box);
  let view = null;

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
    const seated = (table.seats || []).some((seat) => seat.id === me.id);
    const names = view.names;

    const head = el('div', 'game-head');
    head.append(el('h2', '', '骰子桌'));
    head.append(el('span', 'meta', '每人两颗暗骰 · 重掷或停牌 · 合计最高者赢'));
    if (table.deadline && table.status === 'playing') {
      head.append(el('span', 'meta', '本回合截止 ' + fmtClock(table.deadline)));
    }
    box.append(head);

    if (!seated) {
      box.append(el('p', 'muted', '你在旁观；桌上至少要有两个人，发起人才能开局。'));
    }

    const grid = el('div', 'dice-players');
    for (const seat of (table.seats || [])) {
      const mine = seat.id === me.id;
      const revealed = (table.revealed || []).find((entry) => entry.id === seat.id);
      const row = el('div', 'dice-player'
        + (seat.id === table.turn ? ' turn' : '')
        + (mine ? ' mine' : ''));
      const name = (names.get(seat.id) || seat.name) + (mine ? '（你）' : '');
      row.append(el('div', 'pname', name));
      const dice = el('div', 'dice');
      const values = mine && priv && Array.isArray(priv.dice) && priv.dice.length
        ? priv.dice
        : revealed ? revealed.dice : null;
      if (values) {
        for (const value of values) dice.append(dieNode(value));
      } else {
        dice.append(el('span', 'muted', seat.stood ? '已停' : '暗骰'));
      }
      row.append(dice);
      if (values) {
        const total = values.reduce((sum, value) => sum + value, 0);
        row.append(el('div', 'total', total + ' 点'));
      }
      if (seat.stood) row.append(el('div', 'muted', '已停牌'));
      else if (seat.id === table.turn) row.append(el('div', 'muted', '轮到这一位'));
      grid.append(row);
    }
    box.append(grid);

    if (table.status === 'ended') {
      const winners = (table.revealed || []).filter((entry) => (table.winners || []).includes(entry.id));
      const title = (table.winners || []).length > 1 ? '平局：' : '赢家：';
      box.append(el('p', 'result', title + winners.map((entry) => entry.name + '（' + entry.total + ' 点）').join('、')));
      box.append(el('p', 'muted', '这局结束了。发起人可以再开一桌。'));
      return;
    }

    if (priv && priv.yourTurn) {
      const actions = el('div', 'actions');
      const left = priv.rerollsLeft || 0;
      actions.append(btn('重掷第 1 颗', () => {
        ctx.act({ type: 'table_action', action: 'roll', die: 0 }).catch(() => {});
      }, { disabled: left <= 0 }));
      actions.append(btn('重掷第 2 颗', () => {
        ctx.act({ type: 'table_action', action: 'roll', die: 1 }).catch(() => {});
      }, { disabled: left <= 0 }));
      actions.append(btn('停牌', () => {
        ctx.act({ type: 'table_action', action: 'stand' }).catch(() => {});
      }, { primary: true }));
      box.append(actions);
      const total = (priv.dice || []).reduce((sum, value) => sum + value, 0);
      box.append(el('p', 'muted', '你的合计 ' + total + ' 点；还能重掷 ' + left + ' 次。'));
      if (priv.deadline) {
        const line = el('p', 'muted', '本回合截止 ' + fmtClock(priv.deadline) + '，');
        line.append(clockSpan(priv.deadline));
        box.append(line);
      }
    } else if (seated) {
      const turnName = names.get(table.turn) || '？';
      const line = el('p', 'muted', '等 ' + turnName + ' 行动。');
      if (table.deadline) {
        line.append(document.createTextNode(' '));
        line.append(clockSpan(table.deadline));
      }
      box.append(line);
    }
  }
}
