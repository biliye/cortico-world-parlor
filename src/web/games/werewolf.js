/** 狼人杀（真人与 Coo 同桌）：一张固定九席的像素木桌。
 *  座号方向所有端一致（不为自己旋转）；发言/票型/历史都在右侧文字区；
 *  秘密（身份牌、查验、狼聊、药）只渲染本人私视图给的东西。
 *  规则、窗口、时限全在服务器；这里只摆座位、卡片、草稿与按钮。 */
import {
  el, clear, btn, fmtClock, clockSpan, icon, initialOf, readable,
} from '../common.js';

const ROLES = ['wolf', 'villager', 'seer', 'witch', 'hunter'];
const ROLE_NAMES = { wolf: '狼人', villager: '平民', seer: '预言家', witch: '女巫', hunter: '猎人' };
const ROLE_FACTIONS = { wolf: '狼人阵营', villager: '好人阵营', seer: '好人阵营', witch: '好人阵营', hunter: '好人阵营' };
const ROLE_SKILLS = {
  wolf: '每晚与同伴交流并交一张刀票；最高票且唯一的存活非狼人出局，平票或弃刀则空刀。',
  villager: '没有夜间技能，靠白天发言与投票找出狼人。',
  seer: '每晚最多查验一名其他存活玩家，只得到「狼人 / 好人」。',
  witch: '各一瓶解药与毒药，每夜最多用一瓶；解药尚在才得知刀口；首夜可自救，不能自毒。',
  hunter: '被狼刀或白天投票出局可开枪带走一名其他存活玩家；中毒不能开枪。',
};
const KIND_LABEL = { human: '人', pet: 'Coo' };
const SPEECH_KIND = { day: '发言', pk: 'PK 发言', lastwords: '遗言' };

/** 九个固定座位的环位置（CSS grid 区域）；所有端方向一致。 */
const RING_SLOTS = [
  { seatNo: 1, area: 'a1' }, { seatNo: 2, area: 'a2' }, { seatNo: 3, area: 'a3' },
  { seatNo: 9, area: 'a9' }, { seatNo: 4, area: 'a4' },
  { seatNo: 8, area: 'a8' }, { seatNo: 5, area: 'a5' },
  { seatNo: 7, area: 'a7' }, { seatNo: 6, area: 'a6' },
];

export function mountWerewolf(root, ctx) {
  const box = el('section', 'panel game-werewolf');
  root.append(box);

  let view = null;
  let tableId = '';
  let mySeatNo = 0;
  let tab = 'today';            // today | byPlayer | votes
  let playerFilter = 0;         // 按玩家回看的座号
  let votePick = null;          // {target: number|null} 已选未提交
  let inspectPick = null;
  let poisonPick = null;
  let shootPick = null;
  let revealed = false;         // 身份牌翻开中
  let identityOpen = false;     // 「我的身份」抽屉
  let draftFocused = false;
  let draft = { scope: 'speech', text: '' };
  let enlargedImage = null;

  const draftKey = (scope) => `ww.draft.${location.host}.${view?.me?.id ?? 'me'}.${tableId}.${scope}`;
  const loadDraft = (scope) => {
    try { return localStorage.getItem(draftKey(scope)) ?? ''; } catch { return ''; }
  };
  const saveDraft = (scope, text) => {
    try {
      if (text) localStorage.setItem(draftKey(scope), text);
      else localStorage.removeItem(draftKey(scope));
    } catch { /* 存不进去就只留在输入框里 */ }
  };

  // 图片库公开、集合一致：挂桌就预载五种角色牌（不代表谁是什么）。
  for (const role of ROLES) {
    const img = new Image();
    img.src = roleArtUrl(role);
  }

  const onVisibility = () => {
    if (document.hidden && revealed) {
      revealed = false;
      const flip = box.querySelector('.wf-idflip');
      if (flip) flip.classList.remove('is-open');
    }
  };
  document.addEventListener('visibilitychange', onVisibility);


  function roleArtUrl(role) {
    return `/play/assets/assets/werewolf/roles/${role}.jpg`;
  }

  /* —— 小工具 —— */

  const seatNoOf = (id) => (view.table?.seats ?? []).find((seat) => seat.id === id)?.seatNo ?? 0;
  const nameOfNo = (no) => (view.table?.seats ?? []).find((seat) => seat.seatNo === no)?.name ?? `${no}号`;
  const seatLabel = (no) => `${no}号 ${nameOfNo(no)}`;
  const aliveOf = (no) => (view.table?.seats ?? []).find((seat) => seat.seatNo === no)?.alive ?? false;
  const onlineOf = (no) => {
    const seat = (view.table?.seats ?? []).find((entry) => entry.seatNo === no);
    return seat ? view.online.includes(seat.id) : false;
  };
  const myWindow = () => (view.priv?.canAct ? view.priv.windowId : null);
  const myMove = () => (view.priv?.canAct ? view.priv.myMove : null);

  function act(body, onOk) {
    if (!view.priv?.windowId) {
      ctx.toast('先等服务器发窗口');
      return Promise.resolve(false);
    }
    return ctx.act({ type: 'werewolf_action', windowId: view.priv.windowId, ...body })
      .then((ok) => {
        if (ok !== false && onOk) onOk();
        return ok;
      })
      .catch(() => false);
  }

  /* —— 渲染 —— */

  function render() {
    const table = view.table;
    if (!table) return;
    clear(box);
    if (table.status === 'ended') {
      box.append(renderEnd());
      return;
    }
    const priv = view.priv;
    const strip = el('div', 'wf-strip');
    strip.append(phasePill(table, priv));
    if (table.day) strip.append(el('span', 'wf-day', `第 ${table.day} 天`));
    if (table.deadline) {
      const clock = el('span', 'wf-clock');
      clock.append(document.createTextNode(fmtClock(table.deadline) + ' · '));
      clock.append(clockSpan(table.deadline, 'clock'));
      strip.append(clock);
    }
    box.classList.toggle('is-night', table.phase === 'night');
    box.classList.toggle('is-day', table.phase !== 'night');

    const main = el('div', 'wf-main');
    main.append(ringArea(table, priv));

    const side = el('div', 'wf-side');
    side.append(nowSpeechCard(table));
    side.append(historyPanel(table));
    main.append(side);
    box.append(main);

    if (table.phase === 'reveal' && priv?.role) {
      box.append(revealBanner(priv));
    }
    box.append(actionBar(table, priv));
    if (identityOpen && priv?.role) box.append(identityDrawer(priv));
    if (enlargedImage) box.append(enlargeOverlay());
  }

  function phasePill(table, priv) {
    const mine = myMove();
    const pill = el('span', 'wf-pill' + (mine ? ' live' : ''));
    if (mine) pill.append(el('span', 'live-dot'));
    let text = table.phaseLabel || '等待';
    if (mine === 'speak') text = '轮到你发言';
    else if (mine === 'vote') text = '轮到你投票';
    else if (mine === 'wolf_chat' || mine === 'wolf_kill') text = '狼人时间';
    else if (mine === 'inspect') text = '预言家时间';
    else if (mine === 'witch') text = '女巫时间';
    else if (mine === 'shoot') text = '你可以开枪';
    pill.append(document.createTextNode(text));
    if (table.phase === 'speech' && table.turn) {
      const no = seatNoOf(table.turn);
      if (no) pill.append(document.createTextNode(` · ${seatLabel(no)}`));
    }
    return pill;
  }

  /* —— 九席环 —— */

  function ringArea(table, priv) {
    const wrap = el('div', 'wf-ring-wrap');
    const ring = el('div', 'wf-ring');
    const tableCore = el('div', 'wf-table-core');
    const coreDay = el('div', 'wf-core-day');
    coreDay.append(document.createTextNode(table.day ? `第 ${table.day} ${table.phase === 'night' ? '夜' : '天'}` : '狼人杀'));
    tableCore.append(coreDay);
    if (priv?.role) {
      tableCore.append(el('div', 'wf-core-sub', table.phase === 'night' ? '天亮前保持安静' : (table.phaseLabel ?? '')));
    } else {
      tableCore.append(el('div', 'wf-core-sub', '旁观视角'));
    }
    ring.append(tableCore);
    const seatByNo = new Map((table.seats ?? []).map((seat) => [seat.seatNo, seat]));
    for (const slot of RING_SLOTS) {
      const seat = seatByNo.get(slot.seatNo);
      ring.append(seatNode(seat, slot.area, table));
    }
    wrap.append(ring);
    const dead = (table.deaths ?? []);
    if (dead.length) {
      const line = el('div', 'wf-deadline', '已出局：'
        + dead.map((entry) => `${entry.seatNo}号（第${entry.day}${entry.phase === 'night' ? '夜' : '天'}）`).join('、'));
      wrap.append(line);
    }
    return wrap;
  }

  function seatNode(seat, area, table) {
    if (!seat) return el('div', 'wf-seat-empty ' + area);
    const info = (view.seats ?? []).find((entry) => entry.id === seat.id);
    const isMe = seat.id === view.me?.id;
    const speaking = table.turn === seat.id && (table.phase === 'speech' || table.phase === 'shoot');
    const alive = seat.alive !== false;
    const online = view.online.includes(seat.id);
    const node = el('button', 'wf-seat ' + area
      + (isMe ? ' is-me' : '')
      + (speaking ? ' is-speaking' : '')
      + (alive ? '' : ' is-dead')
      + (online ? '' : ' is-offline')
      + (canTarget(seat.seatNo) ? ' is-targetable' : ''));
    node.type = 'button';
    node.setAttribute('aria-label', seatLabel(seat.seatNo)
      + (alive ? '' : '（已出局）') + (online ? '' : '（离线）')
      + (isMe ? '（你）' : '（' + KIND_LABEL[seat.kind] + '）'));
    const head = el('span', 'wf-seat-head');
    const avatar = el('span', 'avatar avatar-sm ' + (info && info.kind === 'pet' ? 'avatar-coo' : (view.classes.get(seat.id) || 's1')),
      initialOf(seat.name));
    head.append(avatar);
    head.append(el('span', 'wf-seatno', `${seat.seatNo}号`));
    node.append(head);
    node.append(el('span', 'wf-seatname', (seat.name || '') + (isMe ? '（你）' : '')));
    const tags = el('span', 'wf-seat-tags');
    tags.append(el('span', 'wf-kind', KIND_LABEL[seat.kind] ?? ''));
    if (!alive) tags.append(el('span', 'wf-mark dead', '出局'));
    else if (!online) tags.append(el('span', 'wf-mark off', '离线'));
    node.append(tags);
    if (canTarget(seat.seatNo)) {
      node.addEventListener('click', () => pickTarget(seat.seatNo));
    } else {
      node.addEventListener('click', () => {
        tab = 'byPlayer';
        playerFilter = seat.seatNo;
        render();
      });
    }
    return node;
  }

  /** 当前动作里可点的目标座位（投票/查验/毒/枪/刀票）。 */
  function canTarget(seatNo) {
    const move = myMove();
    const priv = view.priv;
    if (!move || !priv) return false;
    if (seatNo === mySeatNo) return false;
    if (move === 'vote') {
      if (priv.voteVariant === 'pk') return (priv.pkSeats ?? []).includes(seatNo);
      return aliveOf(seatNo);
    }
    if ((move === 'inspect' || move === 'shoot') && aliveOf(seatNo)) return true;
    if (move === 'witch' && priv.potions?.poison > 0 && aliveOf(seatNo)) return true;
    if (move === 'wolf_kill' && aliveOf(seatNo)) {
      const mates = new Set((priv.teammates ?? []).map((entry) => entry.seatNo));
      return !mates.has(seatNo);
    }
    return false;
  }

  /** 点一个可目标的座位：放进当前动作的选择里。 */
  function pickTarget(seatNo) {
    const move = myMove();
    if (move === 'vote') votePick = { target: votePick?.target === seatNo ? null : seatNo };
    else if (move === 'inspect') inspectPick = inspectPick === seatNo ? null : seatNo;
    else if (move === 'wolf_kill') shootPick = null;
    if (move === 'wolf_kill') shootPick = shootPick === seatNo ? null : seatNo;
    if (move === 'witch') poisonPick = poisonPick === seatNo ? null : seatNo;
    if (move === 'shoot') shootPick = shootPick === seatNo ? null : seatNo;
    render();
  }

  /* —— 发言卡与历史 —— */

  function speechCard(entry, live) {
    const card = el('article', 'wf-speech' + (live ? ' is-live' : '') + (entry.passed ? ' is-pass' : ''));
    const head = el('header', 'wf-speech-head');
    head.append(el('span', 'wf-speech-day', `第${entry.day}天·${SPEECH_KIND[entry.kind] ?? '发言'}`));
    const who = el('span', 'wf-speech-who');
    const seat = (view.table?.seats ?? []).find((item) => item.seatNo === entry.seatNo);
    who.append(document.createTextNode(`${entry.seatNo}号 ${entry.seatName ?? seat?.name ?? ''}`));
    if (seat) who.append(el('span', 'wf-kind', KIND_LABEL[seat.kind] ?? ''));
    head.append(who);
    card.append(head);
    card.append(el('p', 'wf-speech-text', entry.passed ? '（过麦，没有发言）' : entry.text));
    return card;
  }

  function nowSpeechCard(table) {
    const panel = el('section', 'wf-panel wf-now');
    panel.append(el('h3', 'wf-panel-title', '当前发言'));
    const speeches = table.speeches ?? [];
    const last = speeches[speeches.length - 1];
    if (table.phase === 'reveal') {
      panel.append(el('p', 'wf-hint', '大家在看身份牌，马上入夜。'));
    } else if (table.phase === 'night') {
      panel.append(el('p', 'wf-hint', '夜晚：天亮会公布结果；你的私视图里有你自己的行动。'));
    } else if (table.phase === 'vote') {
      panel.append(el('p', 'wf-hint', '投票进行中，到点统一揭晓；截止前谁投给谁不会公开。'));
    } else if (!last) {
      panel.append(el('p', 'wf-hint', '还没有人发言。'));
    } else {
      panel.append(speechCard(last, true));
    }
    return panel;
  }

  function historyPanel(table) {
    const panel = el('section', 'wf-panel wf-history');
    const tabs = el('div', 'wf-tabs');
    const tabsDef = [['today', '本日'], ['byPlayer', '按玩家'], ['votes', '票型']];
    for (const [key, label] of tabsDef) {
      const tabBtn = el('button', 'wf-tab' + (tab === key ? ' is-active' : ''), label);
      tabBtn.type = 'button';
      tabBtn.addEventListener('click', () => { tab = key; render(); });
      tabs.append(tabBtn);
    }
    panel.append(tabs);
    const body = el('div', 'wf-tabbody');
    const speeches = table.speeches ?? [];
    if (tab === 'today') {
      const today = speeches.filter((entry) => entry.day === table.day);
      if (!today.length) body.append(el('p', 'wf-hint', '今天还没有发言。'));
      today.slice().reverse().forEach((entry) => body.append(speechCard(entry, false)));
    } else if (tab === 'byPlayer') {
      const picker = el('div', 'wf-people');
      for (const seat of (table.seats ?? [])) {
        const chip = el('button', 'wf-chip' + (playerFilter === seat.seatNo ? ' is-active' : ''),
          `${seat.seatNo}号 ${seat.name}`);
        chip.type = 'button';
        chip.addEventListener('click', () => { playerFilter = seat.seatNo; render(); });
        picker.append(chip);
      }
      body.append(picker);
      const mine = speeches.filter((entry) => entry.seatNo === playerFilter);
      if (!playerFilter) body.append(el('p', 'wf-hint', '点一个座位，看这个人到目前的全部发言。'));
      else if (!mine.length) body.append(el('p', 'wf-hint', `${seatLabel(playerFilter)} 还没有发言记录。`));
      mine.slice().reverse().forEach((entry) => body.append(speechCard(entry, false)));
    } else {
      const votes = (table.votes ?? []).slice().reverse();
      if (!votes.length) body.append(el('p', 'wf-hint', '还没有已揭晓的票型。'));
      for (const round of votes) {
        const block = el('article', 'wf-votes');
        block.append(el('h4', 'wf-votes-title',
          `第${round.day}天${round.variant === 'pk' ? ' · 复投' : ''}`));
        for (const entry of round.entries) {
          const line = el('div', 'wf-vote-line');
          line.append(el('span', 'wf-vote-from', `${entry.seatNo}号`));
          line.append(el('span', 'wf-vote-arrow', '→'));
          line.append(el('span', 'wf-vote-to',
            entry.target === null ? (entry.timeout ? '超时弃票' : '弃票') : `${entry.target}号 ${nameOfNo(entry.target)}`));
          block.append(line);
        }
        if (round.exiled !== undefined) block.append(el('p', 'wf-votes-note', `放逐：${seatLabel(round.exiled)}`));
        else if (round.tie) block.append(el('p', 'wf-votes-note', `平票：${round.tie.map(seatLabel).join('、')} 进入 PK`));
        else block.append(el('p', 'wf-votes-note', '无人放逐'));
        body.append(block);
      }
    }
    panel.append(body);
    return panel;
  }

  /* —— 看身份（翻牌） —— */

  function revealBanner(priv) {
    const banner = el('div', 'wf-reveal');
    const flip = el('div', 'wf-idflip' + (revealed ? ' is-open' : ''));
    const back = el('button', 'wf-card-back');
    back.type = 'button';
    back.setAttribute('aria-label', '点击查看你的身份');
    back.append(el('span', 'wf-card-back-inner', '狼人杀'));
    back.append(el('span', 'wf-card-back-hint', '点击查看你的身份'));
    back.addEventListener('click', () => {
      revealed = true;
      flip.classList.add('is-open');
    });
    const face = identityFace(priv, true);
    flip.append(back, face);
    banner.append(flip);
    if (!revealed) {
      banner.append(el('p', 'wf-reveal-hint', '看身份阶段；倒计时结束后自动盖牌，之后在「我的身份」里随时再看。'));
    }
    return banner;
  }

  function identityFace(priv, withClose) {
    const face = el('div', 'wf-card-face');
    const art = el('div', 'wf-roleart');
    const img = el('img', 'wf-roleimg');
    img.src = roleArtUrl(priv.role);
    img.alt = `${ROLE_NAMES[priv.role]}身份牌`;
    img.loading = 'eager';
    img.decoding = 'async';
    img.addEventListener('error', () => {
      // 牌图 404/慢网：给文字身份，不无限加载。
      art.classList.add('is-missing');
      img.remove();
    });
    art.append(img);
    face.append(art);
    face.append(el('div', 'wf-role-name', `${ROLE_NAMES[priv.role]} · ${ROLE_FACTIONS[priv.role]}`));
    face.append(el('p', 'wf-role-skill', ROLE_SKILLS[priv.role]));
    if (priv.role === 'wolf') {
      const mates = (priv.teammates ?? []).map((entry) => `${entry.seatNo}号 ${entry.name}`).join('、');
      if (mates) face.append(el('p', 'wf-role-mates', `同伴：${mates}`));
    }
    if (withClose) {
      const close = btn('收好身份', () => {
        identityOpen = false;
        revealed = false;
        render();
      }, { small: true });
      face.append(close);
    }
    return face;
  }

  function identityDrawer(priv) {
    const drawer = el('div', 'wf-id-drawer');
    drawer.append(el('h3', 'wf-panel-title', '我的身份（仅自己可见）'));
    drawer.append(identityFace(priv, true));
    return drawer;
  }

  /* —— 操作区 —— */

  function actionBar(table, priv) {
    const bar = el('div', 'wf-actionbar');
    const meBar = el('div', 'wf-mebar');
    if (priv?.role) {
      const idBtn = el('button', 'wf-id-toggle', identityOpen ? '收起身份' : `我的身份 · ${ROLE_NAMES[priv.role]}`);
      idBtn.type = 'button';
      idBtn.addEventListener('click', () => { identityOpen = !identityOpen; render(); });
      meBar.append(idBtn);
      if (priv.alive === false) meBar.append(el('span', 'wf-mark dead', '你已出局 · 观战到终局'));
    } else {
      meBar.append(el('span', 'wf-hint', '你在旁观这张桌。'));
    }
    bar.append(meBar);

    const move = myMove();
    const actions = el('div', 'wf-actions');
    if (move === 'speak') actions.append(speechComposer(priv));
    else if (move === 'vote') actions.append(voteComposer(priv));
    else if (move === 'wolf_chat' || move === 'wolf_kill') actions.append(wolfComposer(priv, move));
    else if (move === 'inspect') actions.append(inspectComposer(priv));
    else if (move === 'witch') actions.append(witchComposer(priv));
    else if (move === 'shoot') actions.append(shootComposer(priv));
    else if (priv?.role) actions.append(waitNote(table, priv));
    bar.append(actions);
    return bar;
  }

  function waitNote(table, priv) {
    const note = el('div', 'wf-wait');
    if (priv.alive === false) {
      note.append(el('span', '', '出局后保留座位，只看公开桌面与自己的秘密；终局会揭牌。'));
      return note;
    }
    if (table.phase === 'night') note.append(el('span', '', '夜里有人在行动；天亮见。'));
    else if (table.phase === 'speech' && table.turn) note.append(el('span', '', `等 ${seatLabel(seatNoOf(table.turn))} 发言。`));
    else note.append(el('span', '', '等下一个窗口。'));
    return note;
  }

  function draftBox(scope, max, placeholder, onSend, sendLabel) {
    const wrap = el('div', 'wf-draft');
    const ta = el('textarea', 'wf-input');
    ta.value = draft.scope === scope ? draft.text : loadDraft(scope);
    ta.placeholder = placeholder;
    ta.maxLength = max + 20; // 服务器按码点硬校验；这里只做软提示
    ta.rows = 3;
    ta.setAttribute('aria-label', placeholder);
    const count = el('span', 'wf-count', `${Array.from(ta.value).length}/${max}`);
    const clock = el('span', 'wf-dclock');
    if (view.priv?.deadline) {
      clock.append(clockSpan(view.priv.deadline, 'clock'));
    }
    const row = el('div', 'wf-draft-row');
    row.append(count, clock);
    ta.addEventListener('input', () => {
      saveDraft(scope, ta.value);
      count.textContent = `${Array.from(ta.value).length}/${max}`;
      count.classList.toggle('is-over', Array.from(ta.value).length > max);
    });
    ta.addEventListener('focus', () => { draftFocused = true; });
    ta.addEventListener('blur', () => { draftFocused = false; });
    ta.addEventListener('keydown', (event) => {
      // 回车换行；Ctrl/Cmd+Enter 提交。输入法组词中的回车不会到这里。
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        onSend(ta.value);
      }
    });
    const send = btn(sendLabel, () => onSend(ta.value), { primary: true });
    const box = el('div', 'wf-draft-main');
    box.append(ta, row);
    wrap.append(box, send);
    if (draftFocused) setTimeout(() => { ta.focus(); }, 0);
    return wrap;
  }

  function speechComposer(priv) {
    const composer = el('div', 'wf-composer');
    const kindLabel = priv.speechKind === 'lastwords' ? '遗言' : priv.speechKind === 'pk' ? 'PK 发言' : '发言';
    composer.append(el('p', 'wf-composer-hint', `一次机会、一条完整发言（最多 300 字）；提交或过麦后进入全桌阅读。`));
    composer.append(draftBox('speech', 300, `写${kindLabel}…（Ctrl+Enter 提交）`, (text) => {
      const body = text.trim();
      if (!body) {
        ctx.toast('想好了再交；这会儿可以点「过麦」');
        return;
      }
      void act({ move: 'speak', text: body }, () => saveDraft('speech', ''));
    }, '提交并结束发言'));
    composer.append(btn('过麦', () => {
      void act({ move: 'pass_speech' }, () => saveDraft('speech', ''));
    }, { ghost: true }));
    return composer;
  }

  function targetChips(list, current, onPick) {
    const wrap = el('div', 'wf-targets');
    for (const no of list) {
      const chip = el('button', 'wf-chip' + (current === no ? ' is-active' : ''), seatLabel(no));
      chip.type = 'button';
      chip.addEventListener('click', () => { onPick(no); render(); });
      wrap.append(chip);
    }
    return wrap;
  }

  function voteComposer(priv) {
    const composer = el('div', 'wf-composer');
    const targets = priv.voteVariant === 'pk' ? (priv.pkSeats ?? []) : (view.table?.seats ?? [])
      .filter((seat) => seat.alive && seat.seatNo !== mySeatNo).map((seat) => seat.seatNo);
    composer.append(el('p', 'wf-composer-hint',
      priv.voteVariant === 'pk'
        ? '复投：只能投给进入 PK 的席位，或弃票；到点统一揭晓。'
        : '一人一票，不能投自己，可以弃票；提交后不能改，到点统一揭晓。'));
    composer.append(el('div', 'wf-composer-note', '点座位或点下面的名字选人；选中 ≠ 提交。'));
    composer.append(targetChips(targets, votePick?.target ?? null, (no) => { votePick = { target: no }; }));
    const confirmRow = el('div', 'wf-confirm');
    if (votePick && votePick.target !== null) {
      confirmRow.append(btn(`投给 ${seatLabel(votePick.target)}，提交后不可改`, () => {
        void act({ move: 'vote', target: votePick.target }, () => { votePick = null; });
      }, { primary: true }));
    } else if (votePick && votePick.target === null) {
      confirmRow.append(btn('确认弃票（提交后不可改）', () => {
        void act({ move: 'vote' }, () => { votePick = null; });
      }, { primary: true }));
    } else {
      confirmRow.append(btn('弃票', () => { votePick = { target: null }; render(); }, { ghost: true }));
    }
    composer.append(confirmRow);
    return composer;
  }

  function wolfComposer(priv, move) {
    const composer = el('div', 'wf-composer');
    if (move === 'wolf_chat') {
      composer.append(el('p', 'wf-composer-hint', `狼队交流（每夜一条、150 字内）；同伴立刻能看到。已交 ${((priv.submitted ?? []).includes('wolf_chat')) ? '✓' : '✗'}`));
      composer.append(draftBox('wolf', 150, '只给同伴看…', (text) => {
        const body = text.trim();
        if (!body) { ctx.toast('狼聊不能是空的'); return; }
        void act({ move: 'wolf_chat', text: body }, () => saveDraft('wolf', ''));
      }, '交狼聊'));
    }
    if (move === 'wolf_kill') {
      const mates = new Set((priv.teammates ?? []).map((entry) => entry.seatNo));
      const targets = (view.table?.seats ?? [])
        .filter((seat) => seat.alive && !mates.has(seat.seatNo) && seat.seatNo !== mySeatNo)
        .map((seat) => seat.seatNo);
      if ((priv.submitted ?? []).includes('wolf_kill')) {
        composer.append(el('p', 'wf-composer-hint', '你的刀票已经交了；到点锁定刀口。'));
      } else {
        composer.append(el('p', 'wf-composer-hint', '交一张最终刀票（相对多数且唯一才成刀；平票或全弃 = 空刀）。'));
        composer.append(targetChips(targets, shootPick, (no) => { shootPick = no; }));
        const row = el('div', 'wf-confirm');
        if (shootPick) row.append(btn(`刀 ${seatLabel(shootPick)}`, () => {
          void act({ move: 'wolf_kill', target: shootPick }, () => { shootPick = null; });
        }, { primary: true }));
        row.append(btn('弃刀', () => { void act({ move: 'wolf_kill' }); }, { ghost: true }));
        composer.append(row);
      }
      const votes = priv.killVotes ?? [];
      if (votes.length) {
        const line = el('p', 'wf-role-mates', '已交刀票：'
          + votes.map((entry) => `${entry.seatNo}号→${entry.target === null ? '弃' : `${entry.target}号`}`).join('，'));
        composer.append(line);
      }
      const chats = priv.wolfChat ?? [];
      if (chats.length) {
        for (const chat of chats) {
          composer.append(el('p', 'wf-role-mates', `${chat.seatNo}号 ${chat.name}：「${chat.text}」`));
        }
      }
    }
    return composer;
  }

  function inspectComposer(priv) {
    const composer = el('div', 'wf-composer');
    if ((priv.submitted ?? []).includes('inspect') || (priv.inspections ?? []).some((entry) => entry.day === view.table.day)) {
      composer.append(el('p', 'wf-composer-hint', '今夜的槽已交；结果进你的秘密记录（见下面历史）。'));
    } else {
      const targets = (view.table?.seats ?? []).filter((seat) => seat.alive && seat.seatNo !== mySeatNo).map((seat) => seat.seatNo);
      composer.append(el('p', 'wf-composer-hint', '查验一名其他存活玩家；不查就点「今夜不查」。'));
      composer.append(targetChips(targets, inspectPick, (no) => { inspectPick = no; }));
      const row = el('div', 'wf-confirm');
      if (inspectPick) row.append(btn(`查验 ${seatLabel(inspectPick)}`, () => {
        void act({ move: 'inspect', target: inspectPick }, () => { inspectPick = null; });
      }, { primary: true }));
      row.append(btn('今夜不查', () => { void act({ move: 'inspect' }); }, { ghost: true }));
      composer.append(row);
    }
    const history = priv.inspections ?? [];
    if (history.length) {
      composer.append(el('p', 'wf-role-mates', '查验历史：'
        + history.map((entry) => `第${entry.day}夜 ${entry.target}号=${entry.result === 'wolf' ? '狼人' : '好人'}`).join('；')));
    }
    return composer;
  }

  function witchComposer(priv) {
    const composer = el('div', 'wf-composer');
    const potions = priv.potions ?? { antidote: 0, poison: 0 };
    const known = priv.knownKill;
    composer.append(el('p', 'wf-composer-hint',
      `药量：解药 ${potions.antidote}、毒药 ${potions.poison}；每夜只能用其中一瓶。`
      + (potions.antidote > 0
        ? (known === null || known === undefined ? '（今夜刀口未知）' : `今夜刀口：${known}号 ${nameOfNo(known)}`)
        : '（解药已空，不再得知刀口）')));
    const row = el('div', 'wf-confirm');
    if (potions.antidote > 0 && known !== null && known !== undefined) {
      row.append(btn(`救 ${seatLabel(known)}`, () => {
        void act({ move: 'witch', choice: 'save', target: known });
      }, { primary: true }));
    }
    if (potions.poison > 0) {
      const targets = (view.table?.seats ?? []).filter((seat) => seat.alive && seat.seatNo !== mySeatNo).map((seat) => seat.seatNo);
      composer.append(targetChips(targets, poisonPick, (no) => { poisonPick = no; }));
      if (poisonPick) {
        row.append(btn(`毒 ${seatLabel(poisonPick)}`, () => {
          void act({ move: 'witch', choice: 'poison', target: poisonPick }, () => { poisonPick = null; });
        }, { primary: true }));
      }
    }
    row.append(btn('今晚不用药', () => { void act({ move: 'witch', choice: 'none' }); }, { ghost: true }));
    composer.append(row);
    if (potions.antidote > 0 && known === null) {
      composer.append(el('p', 'wf-hint', '今夜没有刀口；解药只能抵消狼刀。'));
    }
    return composer;
  }

  function shootComposer(priv) {
    const composer = el('div', 'wf-composer');
    const targets = (view.table?.seats ?? []).filter((seat) => seat.alive && seat.seatNo !== mySeatNo).map((seat) => seat.seatNo);
    composer.append(el('p', 'wf-composer-hint', '你是猎人：可以带走一名其他存活玩家，也可以放弃（公开亮明身份后开枪）。'));
    composer.append(targetChips(targets, shootPick, (no) => { shootPick = no; }));
    const row = el('div', 'wf-confirm');
    if (shootPick) row.append(btn(`开枪带走 ${seatLabel(shootPick)}`, () => {
      void act({ move: 'shoot', target: shootPick }, () => { shootPick = null; });
    }, { primary: true }));
    row.append(btn('放弃开枪', () => { void act({ move: 'shoot' }); }, { ghost: true }));
    composer.append(row);
    return composer;
  }

  /* —— 终局 —— */

  function renderEnd() {
    const table = view.table;
    const data = (view.endEvent && view.endEvent.data) || {};
    const outcome = data.outcome || table.result?.outcome || 'draw';
    const verdict = outcome === 'good' ? '好人阵营胜利' : outcome === 'wolf' ? '狼人阵营胜利' : '平局';
    const winners = new Set(data.winners ?? table.result?.winners ?? []);
    const roles = data.roles ?? table.revealed ?? [];
    const panel = el('div', 'wf-end');
    const banner = el('div', 'wf-end-banner');
    banner.append(el('span', 'wf-end-kicker', '狼人杀 · 终局'));
    banner.append(el('h2', '', verdict));
    const me = roles.find((entry) => entry.seatNo === mySeatNo);
    if (me?.role) {
      const mine = (outcome === 'draw')
        ? '平局'
        : (winners.size === 0 ? '' : (winners.has(view.me?.id) ? '你在赢的阵营里' : '你在输的阵营里'));
      banner.append(el('p', 'wf-end-sub', `你是 ${ROLE_NAMES[me.role]}（${ROLE_FACTIONS[me.role]}）${mine ? ' · ' + mine : ''}。`));
    }
    panel.append(banner);
    const grid = el('div', 'wf-end-seats');
    for (const entry of roles) {
      const card = el('button', 'wf-endcard' + (winners.has((view.table?.seats ?? []).find((s) => s.seatNo === entry.seatNo)?.id) ? ' is-winner' : ''));
      card.type = 'button';
      card.setAttribute('aria-label', `${entry.seatNo}号 ${entry.name}：${ROLE_NAMES[entry.role]}，点击放大`);
      const art = el('span', 'wf-endcard-art');
      const img = el('img');
      img.src = roleArtUrl(entry.role);
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => { art.classList.add('is-missing'); img.remove(); });
      art.append(img);
      card.append(art);
      card.append(el('span', 'wf-endcard-name', `${entry.seatNo}号 ${entry.name}${entry.alive ? '' : '·出局'}`));
      card.append(el('span', 'wf-endcard-role', ROLE_NAMES[entry.role]));
      card.addEventListener('click', () => { enlargedImage = entry.role; render(); });
      grid.append(card);
    }
    panel.append(grid);
    const actions = el('div', 'wf-end-actions');
    actions.append(btn('回大厅', () => ctx.showLobby(), { primary: true }));
    panel.append(actions);
    return panel;
  }

  function enlargeOverlay() {
    const role = enlargedImage;
    const overlay = el('div', 'wf-enlarge');
    const card = el('div', 'wf-enlarge-card');
    const img = el('img');
    img.src = roleArtUrl(role);
    img.alt = `${ROLE_NAMES[role]}身份牌（放大）`;
    img.addEventListener('error', () => card.remove());
    card.append(img);
    const close = btn('关闭', () => { enlargedImage = null; render(); }, { small: true });
    card.append(close);
    overlay.append(card);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) { enlargedImage = null; render(); }
    });
    return overlay;
  }

  return {
    update(next) {
      view = next;
      const nextTableId = next.table?.tableId || next.table?.id || '';
      if (nextTableId !== tableId) {
        tableId = nextTableId;
        revealed = false;
        identityOpen = false;
        votePick = null;
        playerFilter = 0;
      }
      const meSeat = (next.table?.seats ?? []).find((seat) => seat.id === next.me?.id);
      mySeatNo = meSeat ? meSeat.seatNo : 0;
      const phase = next.table?.phase;
      // 看身份阶段结束就盖牌；切后台由 visibilitychange 盖。
      if (phase !== 'reveal') revealed = false;
      const priv = next.priv;
      draft = {
        scope: priv?.myMove === 'wolf_chat' ? 'wolf' : 'speech',
        text: loadDraft(priv?.myMove === 'wolf_chat' ? 'wolf' : 'speech'),
      };
      render();
    },
    destroy() {
      document.removeEventListener('visibilitychange', onVisibility);
      box.remove();
    },
  };
}
