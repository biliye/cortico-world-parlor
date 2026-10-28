/** 斗地主：手牌、叫地主、出牌/不要/提示。规则全在服务器，这里只摆牌与按钮。 */
import {
  el, clear, btn, cardButton, fmtClock, clockSpan, cardLabel,
} from '../common.js';

export function mountDdz(root, ctx) {
  const box = el('section', 'panel game-ddz');
  root.append(box);
  let view = null;
  let selection = new Set();
  let signature = '';

  return {
    update(next) {
      view = next;
      const hand = next.priv && Array.isArray(next.priv.hand) ? next.priv.hand.join(',') : '';
      const nextSignature = hand + '|' + (next.priv && next.priv.status ? next.priv.status : '');
      if (nextSignature !== signature) {
        signature = nextSignature;
        selection = new Set();
      }
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
    const seated = (table.seats || []).some((seat) => seat.id === me.id);
    const myTurn = !!(priv && priv.yourTurn);

    const head = el('div', 'game-head');
    head.append(el('h2', '', '斗地主'));
    head.append(el('span', 'meta', '三人一桌 · 空位由脚本陪练补 · 牌型与计分由服务器判'));
    if (table.status === 'playing' || table.status === 'bidding') {
      head.append(el('span', 'meta', '本回合截止 ' + fmtClock(table.deadline || 0)));
    }
    box.append(head);

    if (!seated) box.append(el('p', 'muted', '你在旁观；这一局结束后可以坐下一桌。'));

    const tableBox = el('div', 'ddz-table');

    const opps = el('div', 'ddz-opps');
    for (const seat of (table.seats || [])) {
      if (seat.id === me.id) continue;
      const row = el('div', 'ddz-opp' + (seat.id === table.turn ? ' turn' : ''));
      const left = el('div');
      left.append(el('strong', '', (names.get(seat.id) || seat.name) + (seat.bot ? '（脚本）' : '')));
      left.append(el('div', 'role', seat.role === 'landlord' ? '地主' : seat.role === 'farmer' ? '农民' : '还没定地主'));
      row.append(left);
      row.append(el('span', 'total', (seat.cardsLeft ?? 0) + ' 张'));
      opps.append(row);
    }
    tableBox.append(opps);

    const center = el('div', 'ddz-center');
    if (table.lastPlay) {
      const last = el('div');
      last.append(el('div', 'ddz-note',
        (names.get(table.lastPlay.seat) || table.lastPlay.seat) + ' 出了 ' + (table.lastPlay.label || '')));
      const cards = el('div', 'ddz-last');
      for (const card of (table.lastPlay.cards || [])) cards.append(cardButton(card, false, null, true));
      last.append(cards);
      center.append(last);
    } else {
      center.append(el('div', 'ddz-note', table.status === 'bidding' ? '叫地主中，底牌还没亮。' : '新一轮，还没人出牌。'));
    }
    if (table.bottom && table.bottom.length) {
      const bottom = el('div');
      bottom.append(el('div', 'ddz-note', '底牌'));
      const cards = el('div', 'ddz-last');
      for (const card of table.bottom) cards.append(cardButton(card, false, null, true));
      bottom.append(cards);
      center.append(bottom);
    }
    tableBox.append(center);

    if (priv) {
      const meta = el('div', 'ddz-meta');
      meta.append(el('span', '', '你是' + (priv.role === 'landlord' ? '地主' : priv.role === 'farmer' ? '农民' : '（还没定）')));
      if (priv.landlord) meta.append(el('span', '', '地主：' + (names.get(priv.landlord) || priv.landlord)));
      meta.append(el('span', '', '倍数 x' + (priv.multiplier || 1)));
      tableBox.append(meta);

      if (table.status !== 'ended' && Array.isArray(priv.hand) && priv.hand.length) {
        const hand = el('div', 'ddz-hand');
        priv.hand.forEach((card, index) => {
          hand.append(cardButton(card, selection.has(index), myTurn ? () => {
            if (selection.has(index)) selection.delete(index);
            else selection.add(index);
            render();
          } : null));
        });
        tableBox.append(hand);
      }
    }

    box.append(tableBox);

    if (table.status === 'ended') {
      box.append(el('p', 'result', table.text || table.result || '这局结束了。'));
      return;
    }

    if (table.status === 'bidding') {
      if (myTurn) {
        const actions = el('div', 'ddz-actions');
        actions.append(btn('叫地主', () => {
          selection = new Set();
          ctx.act({ type: 'ddz_action', move: 'bid', call: true }).catch(() => {});
        }, { primary: true }));
        actions.append(btn('不叫', () => {
          selection = new Set();
          ctx.act({ type: 'ddz_action', move: 'bid', call: false }).catch(() => {});
        }));
        box.append(actions);
        if (priv && priv.hint && typeof priv.hint.bid === 'boolean') {
          box.append(el('p', 'muted', '提示：这手牌建议' + (priv.hint.bid ? '叫地主' : '不叫') + '。'));
        }
        box.append(deadlineLine(priv.deadline));
      } else {
        box.append(el('p', 'muted', '等 ' + (names.get(table.turn) || '？') + ' 叫地主。'));
      }
      return;
    }

    if (myTurn) {
      const actions = el('div', 'ddz-actions');
      actions.append(btn('出牌', () => {
        const cards = [...selection].sort((a, b) => a - b).map((index) => priv.hand[index]);
        if (!cards.length) {
          ctx.toast('先点几张牌');
          return;
        }
        selection = new Set();
        ctx.act({ type: 'ddz_action', move: 'play', cards }).catch(() => {});
      }, { primary: true, disabled: selection.size === 0 }));
      actions.append(btn('不要', () => {
        selection = new Set();
        ctx.act({ type: 'ddz_action', move: 'pass' }).catch(() => {});
      }, { disabled: priv ? priv.canPass !== true : true }));
      actions.append(btn('提示', () => {
        const hint = priv && priv.hint;
        if (!hint) return;
        if (hint.pass) {
          ctx.toast('这手没有能压过的牌，可以点「不要」。');
          return;
        }
        if (Array.isArray(hint.cards)) {
          selection = new Set();
          const used = new Set();
          for (const card of hint.cards) {
            const index = priv.hand.findIndex((entry, i) => entry === card && !used.has(i));
            if (index >= 0) {
              selection.add(index);
              used.add(index);
            }
          }
          render();
        }
      }, { small: true }));
      box.append(actions);
      if (priv && priv.hint && Array.isArray(priv.hint.cards)) {
        const labels = priv.hint.cards.map((card) => cardLabel(card)).join(' ');
        box.append(el('p', 'muted', '提示：可以出 ' + labels + (priv.hint.label ? '（' + priv.hint.label + '）' : '')));
      }
      box.append(deadlineLine(priv.deadline));
    } else {
      const line = el('p', 'muted', '等 ' + (names.get(table.turn) || '？') + ' 出牌。 ');
      if (table.deadline) line.append(clockSpan(table.deadline));
      box.append(line);
    }
  }

  function deadlineLine(deadline) {
    const line = el('p', 'muted', deadline ? '本回合截止 ' + fmtClock(deadline) + '，' : '');
    if (deadline) line.append(clockSpan(deadline));
    return line;
  }
}
