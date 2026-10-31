/** 斗地主（奶油客厅主推）：一张木头小牌桌。
 *  左边/右边是对手的牌堆，中间是底牌与刚出的那手，最下面是我的扇形手牌。
 *  规则、牌型、提示、计分全在服务器；这里只摆牌、按钮和结果。 */
import {
  el, clear, btn, cardButton, fmtClock, clockSpan, cardLabel, icon, initialOf, readable,
} from '../common.js';

const HAND_ORDER = ['BJ', 'SJ', '2', 'A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3'];

export function mountDdz(root, ctx) {
  const box = el('section', 'panel game-ddz');
  root.append(box);
  let view = null;
  let selection = new Set();
  let signature = '';
  let handNodes = [];
  let playBtn = null;
  let clearBtn = null;
  let selectedLabel = null;

  // 窗口一变宽变窄，手牌要重新收一遍，不然会顶出桌沿。
  const onResize = () => {
    const hand = box.querySelector('.ddz-hand');
    if (hand) fitHand(hand, hand.children.length);
  };
  window.addEventListener('resize', onResize);

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
      window.removeEventListener('resize', onResize);
      box.remove();
    },
  };

  function render() {
    // 选牌不再走这里；但服务器快照会重绘。手牌滑到哪、焦点在哪张牌，
    // 只要那张牌还在就按原样还回去。
    const prevHand = box.querySelector('.ddz-hand');
    const prevScroll = prevHand ? prevHand.scrollLeft : 0;
    const prevIndex = prevHand ? [...prevHand.children].indexOf(document.activeElement) : -1;
    handNodes = [];
    playBtn = null;
    clearBtn = null;
    selectedLabel = null;
    clear(box);
    const table = view.table;
    if (table.status === 'ended') {
      renderEnd();
      return;
    }
    const priv = view.priv;
    const me = view.me;
    const seats = table.seats || [];
    const seated = seats.some((seat) => seat.id === me.id);
    const myTurn = !!(priv && priv.yourTurn);
    const handCards = (priv && Array.isArray(priv.handCards)) ? priv.handCards : null;

    const board = el('div', 'ddz-board' + (myTurn ? ' is-my-turn' : ''));
    board.append(topBar(table, priv, myTurn));
    board.append(bottomStrip(table));

    const grid = el('div', 'ddz-grid');
    const mine = seats.findIndex((seat) => seat.id === me.id);
    const mySeat = mine >= 0 ? seats[mine] : null;
    const leftSeat = mine >= 0 ? seats[(mine + 1) % seats.length] : seats[1] || null;
    const rightSeat = mine >= 0 ? seats[(mine + seats.length - 1) % seats.length] : seats[2] || null;
    if (leftSeat) grid.append(seatColumn(leftSeat, table, 'left'));
    grid.append(centerArea(table, mySeat, leftSeat, rightSeat, myTurn));
    if (rightSeat) grid.append(seatColumn(rightSeat, table, 'right'));

    const handbar = el('div', 'ddz-handbar');
    handbar.append(actionBar(table, priv, myTurn, seated, view));
    const hand = handArea(priv, handCards, myTurn);
    if (hand) handbar.append(hand);
    grid.append(handbar);
    board.append(grid);

    box.append(board);
    if (hand && hand.classList.contains('ddz-hand')) {
      fitHand(hand, (priv && priv.hand ? priv.hand.length : 0));
      if (prevScroll) hand.scrollLeft = prevScroll;
      if (prevIndex >= 0 && hand.children[prevIndex]) {
        hand.children[prevIndex].focus({ preventScroll: true });
      }
    }
    appendStatus(table, priv, myTurn, seated, view);
  }

  /* —— 桌头：状态、倍数、地主 —— */

  function topBar(table, priv, myTurn) {
    const bar = el('div', 'ddz-topbar');
    const pill = el('span', 'ddz-pill' + (myTurn ? ' live' : ''));
    if (myTurn) pill.append(el('span', 'live-dot'));
    pill.append(document.createTextNode(
      table.status === 'bidding'
        ? (myTurn ? '轮到你叫' : '叫地主')
        : (myTurn ? '轮到你出' : '出牌'),
    ));
    bar.append(pill);
    if (table.multiplier) bar.append(el('span', 'ddz-chip', '倍数 ×' + table.multiplier));
    if (table.status === 'playing' && table.landlord) {
      bar.append(el('span', 'ddz-chip gold',
        '地主 ' + (view.names.get(table.landlord) || table.landlord)));
    }
    const left = el('span', 'ddz-seat-mine');
    left.append(document.createTextNode(
      (view.names.get(view.me.id) || view.me.name)
      + (priv && Array.isArray(priv.hand) ? ' · 手牌 ' + priv.hand.length + ' 张' : ''),
    ));
    bar.append(left);
    return bar;
  }

  /* —— 对手：牌堆 + 头像 —— */

  function seatColumn(seat, table, side) {
    const column = el('div', 'ddz-side ddz-side-' + side);
    const turn = seat.id === table.turn && (table.status === 'bidding' || table.status === 'playing');
    const role = seat.role;
    const count = Math.max(0, Number(seat.cardsLeft) || 0);

    const stack = el('div', 'ddz-stack' + (turn ? ' is-turn' : ''));
    stack.setAttribute('aria-hidden', 'true');
    const slots = Math.max(1, Math.min(count, 20));
    for (let index = 0; index < slots; index += 1) stack.append(el('i', 'ddz-back'));
    column.append(stack);

    const info = el('div', 'ddz-side-info' + (turn ? ' is-turn' : '') + (role === 'landlord' ? ' is-landlord' : ''));
    info.append(seatAvatar(seat, view, 'avatar'));
    const name = el('div', 'ddz-side-name');
    name.append(document.createTextNode(view.names.get(seat.id) || seat.name));
    const tag = roleTag(role);
    if (tag) info.append(tag);
    info.append(name);
    const meta = el('div', 'ddz-side-meta');
    meta.append(el('span', 'ddz-left-count', count + ' 张'));
    if (turn) meta.append(el('span', 'ddz-think', table.status === 'bidding' ? '正在叫…' : '正在想…'));
    info.append(meta);
    if (seat.bot) info.append(el('span', 'ddz-bot-mark', '脚本'));
    column.append(info);
    return column;
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

  /* —— 底牌：置顶，叫地主时是三张牌背 —— */

  function bottomStrip(table) {
    const row = el('div', 'ddz-bottoms');
    row.append(el('span', 'ddz-bottom-label', '底牌'));
    const cards = el('div', 'ddz-bottom-cards');
    if (table.bottom && table.bottom.length) {
      const art = table.bottomCards || null;
      table.bottom.forEach((card, index) => {
        cards.append(cardButton(card, false, null, true, art ? art[index] : null));
      });
    } else {
      for (let index = 0; index < 3; index += 1) cards.append(backCard('small-card'));
    }
    row.append(cards);
    return row;
  }

  /* —— 桌面中间：每家这一轮打出的牌各留一处 —— */

  function centerArea(table, mySeat, leftSeat, rightSeat, myTurn) {
    const center = el('div', 'ddz-center');
    const entries = new Map();
    for (const entry of Array.isArray(table.plays) ? table.plays : []) entries.set(entry.seat, entry);
    const passed = new Set(Array.isArray(table.passed) ? table.passed : []);
    // 老服务器/老回放没有 plays：退回只显示最后一手。
    if (!entries.size && !passed.size && table.lastPlay) entries.set(table.lastPlay.seat, table.lastPlay);

    // 叫地主阶段桌上还没有牌，三格空着只是噪音。
    if (table.status !== 'bidding') {
      const plays = el('div', 'ddz-plays');
      plays.append(playSlot(leftSeat, 'left', entries, passed, table, myTurn));
      plays.append(playSlot(mySeat, 'me', entries, passed, table, myTurn));
      plays.append(playSlot(rightSeat, 'right', entries, passed, table, myTurn));
      center.append(plays);
    }

    if (table.status === 'bidding') {
      center.append(el('div', 'ddz-center-note', '叫地主 · 底牌先扣着'));
    }
    return center;
  }

  function playSlot(seat, side, entries, passed, table, myTurn) {
    const slot = el('div', 'ddz-play ddz-play-' + side);
    if (!seat) return slot;
    const entry = entries.get(seat.id);
    const name = el('span', 'ddz-play-name');
    name.append(document.createTextNode(side === 'me'
      ? '你'
      : (view.names.get(seat.id) || seat.name)));
    if (entry && entry.label) name.append(document.createTextNode(' · ' + entry.label));
    slot.append(name);
    const cards = el('div', 'ddz-play-cards');
    if (entry && Array.isArray(entry.cards) && entry.cards.length) {
      entry.cards.forEach((card, index) => {
        cards.append(cardButton(card, false, null, true,
          entry.playedCards ? entry.playedCards[index] : null));
      });
    } else if (passed.has(seat.id)) {
      cards.append(el('span', 'ddz-play-pass', '不要'));
    } else if (table.turn === seat.id && table.status !== 'ended') {
      cards.append(el('span', 'ddz-play-quiet',
        (table.status === 'bidding' ? '叫地主' : '在想') + '…'));
    } else {
      cards.append(el('span', 'ddz-play-quiet', '—'));
    }
    slot.append(cards);
    return slot;
  }

  function backCard(extra) {
    const back = el('div', 'pcard back' + (extra ? ' ' + extra : ''));
    back.setAttribute('aria-hidden', 'true');
    return back;
  }

  /* —— 我的手牌 —— */

  function handArea(priv, handCards, myTurn) {
    const count = priv && Array.isArray(priv.hand) ? priv.hand.length : 0;
    if (!count) return el('div', 'ddz-hand-empty', '你在旁观；这一局结束后可以坐下一桌。');
    const hand = el('div', 'ddz-hand');
    // 只改变显示顺序；选择、花色和提示仍按服务器手牌的原始索引对应。
    const ordered = priv.hand.map((card, index) => ({ card, index }))
      .sort((left, right) => HAND_ORDER.indexOf(left.card) - HAND_ORDER.indexOf(right.card)
        || left.index - right.index);
    ordered.forEach(({ card, index }) => {
      const node = cardButton(card, selection.has(index),
        myTurn ? () => toggleCard(index) : null, false, handCards ? handCards[index] : null);
      handNodes[index] = node;
      hand.append(node);
    });
    return hand;
  }

  /** 点一张牌只改这张牌和几个按钮，不重画牌桌——重画会把焦点和手牌的滑动位置一起冲掉。 */
  function toggleCard(index) {
    if (selection.has(index)) selection.delete(index);
    else selection.add(index);
    paintSelection();
  }

  function paintSelection() {
    handNodes.forEach((node, index) => {
      const on = selection.has(index);
      node.classList.toggle('sel', on);
      node.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (selectedLabel) {
      selectedLabel.textContent = '已选 ' + selection.size + ' 张';
      selectedLabel.hidden = selection.size === 0;
    }
    if (playBtn) playBtn.disabled = selection.size === 0;
    if (clearBtn) clearBtn.disabled = selection.size === 0;
  }

  /**
   * 摆完量一次：桌上放得下就居中；放不下时每张牌至少露出能读点数的宽度，
   * 手牌改成横向可以滑到头尾（CSS 里 overflow-x:auto + safe center）。
   */
  function fitHand(hand, count) {
    if (!hand.isConnected || count < 2) return;
    const card = hand.firstElementChild;
    if (!card) return;
    const cardWidth = card.offsetWidth;
    const available = hand.clientWidth - 24;
    if (!cardWidth || available <= 0) return;
    const maxStep = cardWidth * 0.66;
    const fitStep = (available - cardWidth) / (count - 1);
    // 露出这一条才读得出点数和花色：大牌 26px；小牌按牌宽的一半，至少 24px。
    // 放不下就横向滑（下面 overflow-x:auto），不再把每张压成一条缝。
    const readable = cardWidth >= 60 ? 26 : Math.max(24, cardWidth * 0.5);
    const step = Math.max(Math.min(readable, maxStep), Math.min(maxStep, fitStep));
    hand.style.setProperty('--overlap', (step - cardWidth).toFixed(1) + 'px');
  }

  /* —— 按钮 —— */

  function actionBar(table, priv, myTurn, seated, view) {
    const wrap = el('div', 'ddz-actionbar');
    const actions = el('div', 'ddz-actions');
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
      } else if (seated) {
        actions.append(el('span', 'ddz-wait', '等 ' + (names.get(table.turn) || '？') + ' 叫地主'));
      } else {
        actions.append(el('span', 'ddz-wait', '旁观中'));
      }
    } else if (myTurn) {
      const play = btn('出牌', () => {
        const cards = [...selection].sort((left, right) => left - right).map((index) => priv.hand[index]);
        if (!cards.length) {
          ctx.toast('先点几张牌');
          return;
        }
        selection = new Set();
        paintSelection();
        ctx.act({ type: 'ddz_action', move: 'play', cards }).catch(() => {});
      }, { primary: true, disabled: selection.size === 0 });
      playBtn = play;
      actions.append(play);
      actions.append(btn('不要', () => {
        selection = new Set();
        paintSelection();
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
          paintSelection();
        }
      }, { small: true }));
      const clear = btn('清空', () => {
        selection = new Set();
        paintSelection();
      }, { ghost: true, small: true, disabled: selection.size === 0 });
      clearBtn = clear;
      actions.append(clear);
      const count = el('span', 'ddz-selected', '已选 ' + selection.size + ' 张');
      count.hidden = selection.size === 0;
      selectedLabel = count;
      actions.append(count);
    } else if (seated) {
      actions.append(el('span', 'ddz-wait', '等 ' + (names.get(table.turn) || '？') + ' 出牌'));
    } else {
      actions.append(el('span', 'ddz-wait', '旁观中'));
    }
    wrap.append(actions);

    const deadline = (priv && priv.deadline) || table.deadline;
    const turnSeat = (table.seats || []).find((seat) => seat.id === table.turn);
    const botTurn = !!(turnSeat && turnSeat.bot) && !myTurn;
    if (deadline && !botTurn) {
      const clock = el('span', 'ddz-clock');
      clock.append(document.createTextNode('本回合 ' + fmtClock(deadline) + ' · '));
      clock.append(clockSpan(deadline, 'clock'));
      wrap.append(clock);
    } else if (botTurn) {
      wrap.append(el('span', 'ddz-clock quiet', '脚本在想…'));
    }
    return wrap;
  }

  /* —— 桌子下面那行小字：提示与剩余时间 —— */

  function appendStatus(table, priv, myTurn, seated, view) {
    const line = el('div', 'ddz-status-line');
    const names = view.names;
    if (table.status === 'bidding') {
      if (priv && priv.hint && typeof priv.hint.bid === 'boolean' && myTurn) {
        line.append(el('span', '', '提示：这手牌建议' + (priv.hint.bid ? '叫地主' : '不叫') + '。'));
      }
    } else if (myTurn && priv) {
      if (priv.hint && Array.isArray(priv.hint.cards)) {
        const labels = priv.hint.cards.map((card) => cardLabel(card)).join(' ');
        line.append(el('span', '', '提示：可以出 ' + labels + (priv.hint.label ? '（' + priv.hint.label + '）' : '')));
      }
    } else if (seated && table.turn) {
      line.append(el('span', '', '等 ' + (names.get(table.turn) || '？') + (table.status === 'bidding' ? ' 叫地主' : ' 出牌') + '。'));
    }
    if (line.children.length) box.append(line);
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
    sub.append(document.createTextNode('倍数 ×' + (data.multiplier || (view.priv && view.priv.multiplier) || 1)));
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
        row.cards.forEach((card, index) => {
          cards.append(cardButton(card, false, null, true,
            row.handCards ? row.handCards[index] : null));
        });
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
