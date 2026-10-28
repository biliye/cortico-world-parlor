/** 斗地主（奶油客厅主推）：三席小牌桌、底牌/地主/倍数、扇形手牌、结算手牌。
 *  规则、牌型、提示、计分全在服务器；这里只摆牌、按钮和结果。 */
import {
  el, clear, btn, cardButton, fmtClock, clockSpan, cardLabel, icon, initialOf, readable,
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
      const nextSignature = hand + '|' + (next.priv && next.priv.status ? next.priv.status : '')
        + '|' + (next.table && next.table.turn ? next.table.turn : '');
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
    if (table.status === 'ended') {
      renderEnd();
      return;
    }
    const priv = view.priv;
    const me = view.me;
    const names = view.names;
    const seats = table.seats || [];
    const seated = seats.some((seat) => seat.id === me.id);
    const myTurn = !!(priv && priv.yourTurn);

    const surface = el('div', 'ddz-table');
    const felt = el('div', 'ddz-felt');

    const phase = el('div', 'ddz-phase');
    const pill = el('span', 'status-pill ' + (myTurn ? 'live' : table.status === 'bidding' ? 'warm' : 'quiet'));
    if (myTurn) pill.append(el('span', 'live-dot'));
    pill.append(document.createTextNode(myTurn
      ? (table.status === 'bidding' ? '轮到你叫地主' : '轮到你出牌')
      : (table.status === 'bidding' ? '叫地主' : '出牌')));
    phase.append(pill);
    if (table.multiplier) phase.append(el('span', 'ddz-mult', '倍数 x' + table.multiplier));
    if (table.status === 'playing' && table.landlord) {
      phase.append(el('span', 'ddz-lord-label', '地主 ' + (names.get(table.landlord) || table.landlord)));
    }
    felt.append(phase);

    const opps = el('div', 'ddz-seats');
    for (const seat of seats) {
      if (seat.id === me.id) continue;
      opps.append(seatCard(seat, table, view));
    }
    if (opps.children.length) felt.append(opps);

    felt.append(centerArea(table, priv, myTurn, view));

    const mySeat = seats.find((seat) => seat.id === me.id);
    if (mySeat) felt.append(meBar(mySeat, table, priv, myTurn, view));

    if (priv && Array.isArray(priv.hand) && priv.hand.length) {
      felt.append(handArea(priv, myTurn));
      if (priv.hand.length > 12) felt.append(el('div', 'ddz-hand-hint', '左右滑动手牌'));
    }

    surface.append(felt);
    box.append(surface);
    box.append(controlArea(table, priv, myTurn, seated, view));
  }

  /* —— 对手席 —— */

  function seatCard(seat, table, view) {
    const role = seat.role;
    const turn = seat.id === table.turn && (table.status === 'bidding' || table.status === 'playing');
    const node = el('div', 'ddz-seat'
      + (turn ? ' is-turn' : '')
      + (role === 'landlord' ? ' is-landlord' : ''));
    node.append(seatAvatar(seat, view, 'avatar'));
    const copy = el('div', 'ddz-seat-copy');
    const name = el('div', 'ddz-seat-name');
    name.append(document.createTextNode((view.names.get(seat.id) || seat.name) + (seat.bot ? '（脚本）' : '')));
    const tag = roleTag(role);
    if (tag) name.append(tag);
    copy.append(name);
    const max = role === 'landlord' ? 20 : 17;
    const count = Math.max(0, Number(seat.cardsLeft) || 0);
    const meta = el('div', 'ddz-seat-meta');
    meta.append(el('span', 'ddz-count', '剩 ' + count + ' 张'));
    if (turn) meta.append(el('span', 'ddz-turn-note', table.status === 'bidding' ? '正在叫' : '正在想'));
    copy.append(meta);
    const bar = el('div', 'ddz-left-bar');
    const fill = el('i');
    fill.style.setProperty('width', Math.max(0, Math.min(100, (count / max) * 100)) + '%');
    bar.append(fill);
    copy.append(bar);
    node.append(copy);
    return node;
  }

  function seatAvatar(seat, view, size) {
    const info = (view.seats || []).find((entry) => entry.id === seat.id);
    const isPet = !!(info && info.kind === 'pet');
    const cls = ['avatar', size, isPet ? 'avatar-coo' : (view.classes.get(seat.id) || 's1')]
      .filter(Boolean).join(' ');
    const node = el('span', cls, initialOf(seat.name));
    if (isPet) {
      const badge = el('span', 'avatar-badge');
      badge.append(icon('spark'));
      node.append(badge);
    }
    if (view.online.includes(seat.id)) node.append(el('span', 'status-dot online'));
    return node;
  }

  function roleTag(role) {
    if (role !== 'landlord' && role !== 'farmer') return null;
    const tag = el('span', 'tag ' + (role === 'landlord' ? 'tag-landlord' : 'tag-farmer'));
    if (role === 'landlord') tag.append(icon('crown'));
    tag.append(document.createTextNode(role === 'landlord' ? '地主' : '农民'));
    return tag;
  }

  /* —— 桌面中间 —— */

  function centerArea(table, priv, myTurn, view) {
    const center = el('div', 'ddz-center');
    center.append(el('div', 'ddz-mark ddz-mark-center', '斗'));
    if (table.status === 'bidding') {
      center.append(el('div', 'ddz-center-label', '底牌 3 张 · 叫地主后亮出'));
      center.append(bottomRow(table, true));
      return center;
    }
    const last = table.lastPlay;
    const label = last
      ? '上一手 · ' + (view.names.get(last.seat) || last.seat) + ' 出了 ' + (last.label || '')
      : (myTurn ? '新一轮 · 你先出' : '新一轮 · 等 ' + (view.names.get(table.turn) || '？'));
    center.append(el('div', 'ddz-center-label', label));
    if (last) {
      const row = el('div', 'ddz-last');
      for (const card of (last.cards || [])) row.append(cardButton(card, false, null, true));
      center.append(row);
    } else {
      center.append(el('div', 'ddz-empty', '还没人出牌'));
    }
    center.append(bottomRow(table, false));
    return center;
  }

  function bottomRow(table, backs) {
    const row = el('div', 'ddz-bottom');
    row.append(el('span', 'ddz-bottom-label', '底牌'));
    const cards = el('div', 'ddz-bottom-cards');
    if (!backs && table.bottom && table.bottom.length) {
      for (const card of table.bottom) cards.append(cardButton(card, false, null, true));
    } else {
      for (let index = 0; index < 3; index += 1) {
        const back = el('div', 'pcard back small-card');
        back.setAttribute('aria-hidden', 'true');
        cards.append(back);
      }
    }
    row.append(cards);
    return row;
  }

  /* —— 我的席位与手牌 —— */

  function meBar(seat, table, priv, myTurn, view) {
    const landlord = seat.role === 'landlord';
    const bar = el('div', 'ddz-me' + (myTurn ? ' is-turn' : '') + (landlord ? ' is-landlord' : ''));
    bar.append(seatAvatar(seat, view, 'avatar'));
    const copy = el('div', 'ddz-me-copy');
    const name = el('div', 'ddz-me-name');
    name.append(document.createTextNode(seat.name + '（你）'));
    const tag = roleTag(seat.role);
    if (tag) name.append(tag);
    copy.append(name);
    const meta = el('div', 'ddz-me-meta');
    const count = priv && Array.isArray(priv.hand) ? priv.hand.length : 0;
    meta.append(el('span', '', '手牌 ' + count + ' 张'));
    if (priv && priv.landlord && priv.landlord !== seat.id) {
      meta.append(el('span', '', '地主 ' + (view.names.get(priv.landlord) || '')));
    }
    if (table.multiplier) meta.append(el('span', '', '倍数 x' + table.multiplier));
    copy.append(meta);
    bar.append(copy);
    if (myTurn) {
      const turn = el('span', 'ddz-me-turn');
      turn.append(el('span', 'live-dot'), document.createTextNode('轮到你'));
      bar.append(turn);
    }
    return bar;
  }

  function handArea(priv, myTurn) {
    const hand = el('div', 'ddz-hand');
    const count = priv.hand.length;
    // 手牌多了就叠紧一点，17/20 张在桌面端也能一眼看全；手机仍然可以左右滑。
    const overlap = count <= 12 ? 14 : count <= 17 ? 21 : 27;
    hand.style.setProperty('--overlap', '-' + overlap + 'px');
    const mid = (count - 1) / 2;
    const step = count <= 8 ? 3 : Math.min(2.2, 26 / count);
    priv.hand.forEach((card, index) => {
      const node = cardButton(card, selection.has(index), myTurn ? () => {
        if (selection.has(index)) selection.delete(index);
        else selection.add(index);
        render();
      } : null);
      const deg = (index - mid) * step;
      node.style.setProperty('--rot', deg.toFixed(2) + 'deg');
      node.style.setProperty('--arc', (Math.abs(index - mid) * 0.7).toFixed(2) + 'px');
      hand.append(node);
    });
    return hand;
  }

  /* —— 动作与提示 —— */

  function controlArea(table, priv, myTurn, seated, view) {
    const wrap = el('div', 'ddz-controls');
    const actions = el('div', 'ddz-actions');
    const status = el('div', 'ddz-status-line');
    const names = view.names;

    if (table.status === 'bidding') {
      if (myTurn) {
        actions.append(btn('叫地主', () => {
          selection = new Set();
          ctx.act({ type: 'ddz_action', move: 'bid', call: true }).catch(() => {});
        }, { primary: true }));
        actions.append(btn('不叫', () => {
          selection = new Set();
          ctx.act({ type: 'ddz_action', move: 'bid', call: false }).catch(() => {});
        }));
        if (priv && priv.hint && typeof priv.hint.bid === 'boolean') {
          status.append(el('span', '', '提示：这手牌建议' + (priv.hint.bid ? '叫地主' : '不叫') + '。'));
        }
      } else if (seated) {
        status.append(el('span', '', '等 ' + (names.get(table.turn) || '？') + ' 叫地主。'));
      } else {
        status.append(el('span', '', '你在旁观；这一局结束后可以坐下一桌。'));
      }
    } else if (myTurn) {
      actions.append(btn('出牌', () => {
        const cards = [...selection].sort((left, right) => left - right).map((index) => priv.hand[index]);
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
      }, {
        disabled: priv ? priv.canPass !== true : true,
        title: priv && priv.canPass === true ? '' : '你先出，必须出牌',
      }));
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
      actions.append(btn('清空', () => {
        selection = new Set();
        render();
      }, { ghost: true, small: true, disabled: selection.size === 0 }));
      if (selection.size) status.append(el('span', 'ddz-selected', '已选 ' + selection.size + ' 张'));
      if (priv && priv.hint && Array.isArray(priv.hint.cards)) {
        const labels = priv.hint.cards.map((card) => cardLabel(card)).join(' ');
        status.append(el('span', '', '提示：可以出 ' + labels + (priv.hint.label ? '（' + priv.hint.label + '）' : '')));
      }
    } else if (seated) {
      status.append(el('span', '', '等 ' + (names.get(table.turn) || '？') + ' 出牌。'));
    } else {
      status.append(el('span', '', '你在旁观；这一局结束后可以坐下一桌。'));
    }

    const deadline = (priv && priv.deadline) || table.deadline;
    const turnSeat = (table.seats || []).find((seat) => seat.id === table.turn);
    const botTurn = !!(turnSeat && turnSeat.bot) && !myTurn;
    if (deadline && !botTurn) {
      if (status.children.length) status.append(el('span', 'ddz-dot', '·'));
      status.append(el('span', '', '本回合截止 ' + fmtClock(deadline)));
      status.append(clockSpan(deadline, 'clock'));
    } else if (botTurn) {
      if (status.children.length) status.append(el('span', 'ddz-dot', '·'));
      status.append(el('span', '', '脚本在想…'));
    }
    if (actions.children.length) wrap.append(actions);
    if (status.children.length) wrap.append(status);
    return wrap;
  }

  /* —— 结算：三家剩牌 —— */

  function renderEnd() {
    const table = view.table;
    const me = view.me;
    const names = view.names;
    const data = (view.endEvent && view.endEvent.data) || {};
    const revealed = Array.isArray(data.revealed) ? data.revealed : [];
    const winners = Array.isArray(data.winners) ? data.winners : [];
    const landlordId = data.landlord || (view.priv && view.priv.landlord)
      || (table.seats || []).find((seat) => seat.role === 'landlord')?.id;
    const landlordWon = landlordId && winners.length ? winners.includes(landlordId) : null;
    const result = readable(table.result || '');
    const side = landlordWon === true ? '地主赢'
      : landlordWon === false ? '农民赢'
        : result.includes('地主赢') ? '地主赢'
          : result.includes('农民赢') ? '农民赢' : '这局结束了';
    const extra = data.spring ? ' · 春天' : data.antiSpring ? ' · 反春' : '';
    const panel = el('div', 'ddz-end');
    const banner = el('div', 'ddz-end-banner' + (landlordWon === false ? ' farmers-win' : ''));
    banner.append(el('span', 'ddz-end-kicker', '斗地主 · 已结束'));
    banner.append(el('h2', '', side + extra));
    const sub = el('p');
    sub.append(document.createTextNode('倍数 x' + (data.multiplier || (view.priv && view.priv.multiplier) || 1)));
    if (winners.length) {
      sub.append(document.createTextNode(' · 赢家 ' + winners.map((id) => names.get(id) || id).join('、')));
    }
    banner.append(sub);
    panel.append(banner);

    const grid = el('div', 'ddz-end-seats');
    for (const seat of (table.seats || [])) {
      const row = revealed.find((entry) => entry.id === seat.id);
      const isLord = seat.id === landlordId;
      const won = winners.includes(seat.id);
      const node = el('div', 'ddz-end-seat' + (won ? ' is-winner' : '') + (isLord ? ' is-landlord' : ''));
      const head = el('div', 'ddz-end-seat-head');
      head.append(seatAvatar(seat, view, 'avatar-sm'));
      const copy = el('div', 'ddz-end-copy');
      copy.append(el('div', 'ddz-end-name',
        (names.get(seat.id) || seat.name) + (seat.id === me.id ? '（你）' : '') + (seat.bot ? '（脚本）' : '')));
      const tag = roleTag(isLord ? 'landlord' : 'farmer');
      if (tag) copy.append(tag);
      head.append(copy);
      if (won) head.append(el('span', 'ddz-end-win', '赢'));
      node.append(head);
      const cards = el('div', 'ddz-end-cards');
      if (row && Array.isArray(row.cards) && row.cards.length) {
        for (const card of row.cards) cards.append(cardButton(card, false, null, true));
      } else if (!row && (seat.cardsLeft ?? 0) > 0) {
        cards.append(el('span', 'ddz-end-empty', '剩 ' + seat.cardsLeft + ' 张'));
      } else {
        cards.append(el('span', 'ddz-end-empty', '出完了'));
      }
      node.append(cards);
      grid.append(node);
    }
    panel.append(grid);

    const actions = el('div', 'ddz-actions');
    actions.append(btn('再开一桌', () => ctx.openDdz(), { primary: true }));
    actions.append(btn('回大厅', () => ctx.showLobby(), { ghost: true }));
    panel.append(actions);
    box.append(panel);
  }
}
