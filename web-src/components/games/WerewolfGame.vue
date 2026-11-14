<script setup lang="ts">
/**
 * 狼人杀桌面：房间信息、牌桌和房间聊天各有一栏，按服务器给出的窗口显示操作。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { GameCtx, GameView } from '../../lib/legacy-games.ts';
import { initialOf } from '../../lib/text.ts';
import Icon from '../Icon.vue';
import ClockText from './ClockText.vue';
import WerewolfRoleFace from './WerewolfRoleFace.vue';
import WerewolfSpeech from './WerewolfSpeech.vue';

const props = defineProps<{ view: GameView; ctx: GameCtx }>();

const ROLE_NAMES: Record<string, string> = {
  wolf: '狼人', villager: '平民', seer: '预言家', witch: '女巫', hunter: '猎人', guard: '守卫',
};
const ROLE_FACTIONS: Record<string, string> = {
  wolf: '狼人阵营', villager: '好人阵营', seer: '好人阵营', witch: '好人阵营', hunter: '好人阵营', guard: '好人阵营',
};
const ROLES = ['wolf', 'villager', 'seer', 'witch', 'hunter', 'guard'];
const KIND_LABEL: Record<string, string> = { human: '人', pet: 'Coo' };
const RING_SLOTS = [
  { seatNo: 1, area: 'a1' }, { seatNo: 2, area: 'a2' }, { seatNo: 3, area: 'a3' },
  { seatNo: 9, area: 'a9' }, { seatNo: 4, area: 'a4' },
  { seatNo: 8, area: 'a8' }, { seatNo: 5, area: 'a5' },
  { seatNo: 7, area: 'a7' }, { seatNo: 6, area: 'a6' },
];

interface WSeat { id?: string; name?: string; seatNo?: number; alive?: boolean; kind?: string; role?: string }
interface WSpeech {
  day?: number; kind?: string; seatNo?: number; seatName?: string; text?: string; passed?: boolean;
}
interface WDeath { seatNo?: number; day?: number; phase?: string }
interface WVoteEntry { seatNo?: number; target?: number | null; timeout?: boolean }
interface WVoteRound { day?: number; variant?: string; entries?: WVoteEntry[]; exiled?: number; tie?: number[] }
interface WTable {
  capacity?: number; status?: string; phase?: string; phaseLabel?: string; day?: number; seats?: WSeat[]; turn?: string;
  deadline?: number; speeches?: WSpeech[]; votes?: WVoteRound[]; deaths?: WDeath[];
  revealed?: Array<{ seatNo: number; name: string; role: string; alive?: boolean }>;
  result?: { outcome?: string; winners?: string[] }; tableId?: string; id?: string;
}
interface WPriv {
  role?: string; seatNo?: number; alive?: boolean; canAct?: boolean; myMove?: string; windowId?: string;
  deadline?: number; teammates?: Array<{ seatNo: number; name: string }>; voteVariant?: string;
  pkSeats?: number[]; myVote?: number | null; submitted?: string[]; potions?: { antidote: number; poison: number };
  previousGuard?: number | null;
  knownKill?: number | null; inspections?: Array<{ day: number; target: number; result: string }>;
  speechKind?: string; killVotes?: Array<{ seatNo: number; target: number | null }>;
  wolfChat?: Array<{ seatNo: number; name: string; text: string }>;
  wolfChatRemaining?: number;
  lockedKill?: number | null;
}

const table = computed(() => props.view.table as unknown as WTable);
const capacity = computed(() => table.value.capacity ?? 9);
const ringSlots = computed(() => capacity.value === 9 ? RING_SLOTS
  : Array.from({ length: capacity.value }, (_, index) => ({ seatNo: index + 1, area: `a${index + 1}` })));
const roleLine = computed(() => ({
  6: '2 狼 · 2 民 · 预言家 / 女巫',
  9: '3 狼 · 3 民 · 预言家 / 女巫 / 猎人',
  12: '4 狼 · 4 民 · 预言家 / 女巫 / 猎人 / 守卫',
}[capacity.value] ?? ''));
const priv = computed(() => props.view.priv as unknown as WPriv | null);
const ended = computed(() => table.value.status === 'ended');
const isNight = computed(() => table.value.phase === 'night');
const mySeatNo = computed(() => (table.value.seats ?? [])
  .find((seat) => seat.id === props.view.me.id)?.seatNo ?? 0);
const myMove = computed(() => (priv.value?.canAct ? priv.value.myMove ?? null : null));
const wolfChatRemaining = computed(() => priv.value?.wolfChatRemaining ?? (myMove.value === 'wolf_chat' ? 1 : 0));
const wolfKillWindow = computed(() => priv.value?.wolfChatRemaining !== undefined || myMove.value === 'wolf_kill');
const canWolfKill = computed(() => wolfKillWindow.value && !priv.value?.submitted?.includes('wolf_kill'));
const seats = computed<WSeat[]>(() => table.value.seats ?? []);
const aliveCount = computed(() => seats.value.filter((seat) => seat.alive !== false).length);
const deaths = computed(() => table.value.deaths ?? []);

function seatAt(no: number): WSeat | null {
  return seats.value.find((seat) => seat.seatNo === no) ?? null;
}
function seatNoOf(id?: string): number {
  return seats.value.find((seat) => seat.id === id)?.seatNo ?? 0;
}
function nameOfNo(no: number): string {
  return seatAt(no)?.name ?? `${no}号`;
}
function seatLabel(no: number): string {
  return `${no}号 ${nameOfNo(no)}`;
}
function aliveOf(no: number): boolean {
  const seat = seatAt(no);
  return !!seat && seat.alive !== false;
}
function onlineOf(no: number): boolean {
  const seat = seatAt(no);
  return !!seat && seat.id !== undefined && props.view.online.includes(seat.id);
}
function isMe(seat: WSeat): boolean {
  return seat.id === props.view.me.id;
}
function seatInfo(seat: WSeat): { kind?: string } | undefined {
  return (props.view.seats || []).find((entry) => entry.id === seat.id);
}
function canTarget(seatNo: number): boolean {
  const move = myMove.value;
  const own = priv.value;
  if (!move || !own) return false;
  if (canWolfKill.value) return aliveOf(seatNo);
  if (move === 'guard') return aliveOf(seatNo) && seatNo !== own.previousGuard;
  if (seatNo === mySeatNo.value) return false;
  if (move === 'vote') {
    if (own.voteVariant === 'pk') return (own.pkSeats ?? []).includes(seatNo);
    return aliveOf(seatNo);
  }
  if ((move === 'inspect' || move === 'shoot') && aliveOf(seatNo)) return true;
  if (move === 'witch' && (own.potions?.poison ?? 0) > 0 && aliveOf(seatNo)) return true;
  return false;
}
function seatClasses(seat: WSeat, area: string): string {
  const alive = seat.alive !== false;
  const online = seat.id !== undefined && props.view.online.includes(seat.id);
  const talking = table.value.turn === seat.id
    && (table.value.phase === 'speech' || table.value.phase === 'shoot');
  return [
    'wf-seat', area,
    isMe(seat) ? 'is-me' : '',
    talking ? 'is-speaking' : '',
    pickedNo.value != null && seat.seatNo === pickedNo.value ? 'is-picked' : '',
    alive ? '' : 'is-dead',
    online ? '' : 'is-offline',
    seat.seatNo !== undefined && canTarget(seat.seatNo) ? 'is-targetable' : '',
  ].filter(Boolean).join(' ');
}
function seatAria(seat: WSeat): string {
  const alive = seat.alive !== false;
  const online = seat.id !== undefined && props.view.online.includes(seat.id);
  const own = isMe(seat) ? '（你）' : '（' + (KIND_LABEL[seat.kind ?? ''] ?? '') + '）';
  return seatLabel(seat.seatNo ?? 0) + (alive ? '' : '（已出局）') + (online ? '' : '（离线）') + own;
}
function onSeatClick(seat: WSeat): void {
  const no = seat.seatNo;
  if (no === undefined) return;
  if (canTarget(no)) pickTarget(no);
  else {
    tab.value = 'byPlayer';
    playerFilter.value = no;
  }
}

/* —— 本地界面状态 —— */
const tab = ref<'today' | 'byPlayer' | 'votes'>('today');
const playerFilter = ref(0);
const votePick = ref<{ target: number | null } | null>(null);
const inspectPick = ref<number | null>(null);
const guardPick = ref<number | null>(null);
const poisonPick = ref<number | null>(null);
const shootPick = ref<number | null>(null);
const wolfKillPick = ref<number | null>(null);
const pickedNo = computed(() => {
  if (canWolfKill.value) return wolfKillPick.value;
  switch (myMove.value) {
    case 'vote': return votePick.value?.target;
    case 'inspect': return inspectPick.value;
    case 'guard': return guardPick.value;
    case 'witch': return poisonPick.value;
    case 'shoot': return shootPick.value;
    default: return null;
  }
});
const infoOpen = ref(false);
const roomChatOpen = ref(false);
const chatMove = computed(() => myMove.value === 'speak' || wolfChatRemaining.value > 0);
watch(chatMove, (active) => {
  if (active) roomChatOpen.value = true;
}, { immediate: true });
const revealed = ref(false);
const identityOpen = ref(false);
const enlargedImage = ref<string | null>(null);
const enlargeMissing = ref(false);
const draftFocused = ref(false);
const draftText = reactive<Record<string, string>>({ speech: '', wolf: '' });
const endMissing = reactive<Record<number, boolean>>({});

function pickTarget(seatNo: number): void {
  const move = myMove.value;
  if (canWolfKill.value) wolfKillPick.value = wolfKillPick.value === seatNo ? null : seatNo;
  else if (move === 'vote') votePick.value = { target: votePick.value?.target === seatNo ? null : seatNo };
  else if (move === 'guard') guardPick.value = guardPick.value === seatNo ? null : seatNo;
  else if (move === 'inspect') inspectPick.value = inspectPick.value === seatNo ? null : seatNo;
  if (move === 'witch') poisonPick.value = poisonPick.value === seatNo ? null : seatNo;
  if (move === 'shoot') shootPick.value = shootPick.value === seatNo ? null : seatNo;
}

/* —— 草稿 —— */
function tableIdValue(): string {
  return table.value.tableId || table.value.id || '';
}
watch([
  tableIdValue,
  () => props.view.me.id,
  () => priv.value?.role,
  () => priv.value?.windowId,
  () => table.value.phase,
], () => {
  votePick.value = null;
  inspectPick.value = null;
  guardPick.value = null;
  poisonPick.value = null;
  shootPick.value = null;
  wolfKillPick.value = null;
}, { flush: 'sync' });
function draftKey(scope: string): string {
  return `ww.draft.${location.host}.${props.view.me.id || 'me'}.${tableIdValue()}.${scope}`;
}
function loadDraft(scope: string): string {
  try { return localStorage.getItem(draftKey(scope)) ?? ''; } catch { return ''; }
}
function saveDraft(scope: string, text: string): void {
  try {
    if (text) localStorage.setItem(draftKey(scope), text);
    else localStorage.removeItem(draftKey(scope));
  } catch { /* 存不进去就只留在输入框里 */ }
}
const draftScope = computed(() => (wolfChatRemaining.value > 0 ? 'wolf' : 'speech'));
const draftMax = computed(() => (draftScope.value === 'wolf' ? 150 : 300));
const draftCount = computed(() => Array.from(draftText[draftScope.value] || '').length);
const speechKindLabel = computed(() => {
  const kind = priv.value?.speechKind;
  return kind === 'lastwords' ? '遗言' : kind === 'pk' ? 'PK 发言' : '发言';
});
const speechPlaceholder = computed(() => `写${speechKindLabel.value}…（Ctrl+Enter 提交）`);

function onDraftInput(scope: string, event: Event): void {
  const value = (event.target as HTMLTextAreaElement).value;
  draftText[scope] = value;
  saveDraft(scope, value);
}
function onDraftKey(scope: string, event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    if (scope === 'wolf') sendWolfChat();
    else sendSpeech();
  }
}

/* —— 动作 —— */
function act(body: Record<string, unknown>, onOk?: () => void): Promise<unknown> {
  const own = priv.value;
  if (!own?.windowId) {
    props.ctx.toast('先等服务器发窗口');
    return Promise.resolve(false);
  }
  return props.ctx.act({ type: 'werewolf_action', windowId: own.windowId, ...body })
    .then((ok) => {
      if (ok && onOk) onOk();
      return ok;
    })
    .catch(() => false);
}
function sendSpeech(): void {
  const text = (draftText.speech || '').trim();
  if (!text) {
    props.ctx.toast('想好了再交；这会儿可以点「过麦」');
    return;
  }
  void act({ move: 'speak', text }, () => { saveDraft('speech', ''); draftText.speech = ''; });
}
function passSpeech(): void {
  void act({ move: 'pass_speech' }, () => { saveDraft('speech', ''); draftText.speech = ''; });
}
function sendWolfChat(): void {
  const text = (draftText.wolf || '').trim();
  if (!text) {
    props.ctx.toast('狼聊不能是空的');
    return;
  }
  void act({ move: 'wolf_chat', text }, () => { saveDraft('wolf', ''); draftText.wolf = ''; });
}
function submitVote(): void {
  const pick = votePick.value;
  if (!pick) return;
  if (pick.target === null) void act({ move: 'vote' }, () => { votePick.value = null; });
  else void act({ move: 'vote', target: pick.target }, () => { votePick.value = null; });
}
function submitWolfKill(): void {
  if (wolfKillPick.value === null) return;
  void act({ move: 'wolf_kill', target: wolfKillPick.value }, () => { wolfKillPick.value = null; });
}
function giveUpWolfKill(): void {
  void act({ move: 'wolf_kill' });
}
function submitInspect(): void {
  if (inspectPick.value === null) return;
  void act({ move: 'inspect', target: inspectPick.value }, () => { inspectPick.value = null; });
}
function skipInspect(): void {
  void act({ move: 'inspect' });
}
function submitGuard(target: number | null): void {
  void act({ move: 'guard', ...(target === null ? {} : { target }) }, () => { guardPick.value = null; });
}
function witchSave(): void {
  const known = priv.value?.knownKill;
  if (known === null || known === undefined) return;
  void act({ move: 'witch', choice: 'save', target: known });
}
function witchPoison(): void {
  if (poisonPick.value === null) return;
  void act({ move: 'witch', choice: 'poison', target: poisonPick.value }, () => { poisonPick.value = null; });
}
function witchNone(): void {
  void act({ move: 'witch', choice: 'none' });
}
function shootAt(): void {
  if (shootPick.value === null) return;
  void act({ move: 'shoot', target: shootPick.value }, () => { shootPick.value = null; });
}
function giveUpShoot(): void {
  void act({ move: 'shoot' });
}
function closeIdentity(): void {
  identityOpen.value = false;
  revealed.value = false;
}
function openEnlarge(role: string): void {
  enlargeMissing.value = false;
  enlargedImage.value = role;
}
function closeEnlarge(): void {
  enlargedImage.value = null;
}

/* —— 顶部信息 —— */
const phaseText = computed(() => {
  const move = myMove.value;
  let text = table.value.phaseLabel || '等待';
  if (move === 'speak') text = '轮到你发言';
  else if (move === 'vote') text = '轮到你投票';
  else if (move === 'wolf_chat' || move === 'wolf_kill') text = '狼人时间';
  else if (move === 'inspect') text = '预言家时间';
  else if (move === 'guard') text = '守卫时间';
  else if (move === 'witch') text = '女巫时间';
  else if (move === 'shoot') text = '你可以开枪';
  if (table.value.phase === 'speech' && table.value.turn) {
    const no = seatNoOf(table.value.turn);
    if (no && move !== 'speak') return `${seatLabel(no)} 发言中`;
  }
  return text;
});
const coreDayText = computed(() => (table.value.day
  ? `第 ${table.value.day} ${table.value.phase === 'night' ? '夜' : '天'}`
  : '狼人杀'));
const coreSubText = computed(() => {
  if (pickedNo.value != null) return `已选 ${seatLabel(pickedNo.value)}`;
  if (!priv.value?.role) return '旁观视角';
  if (myMove.value === 'speak') return '在房间聊天里提交发言';
  if (myMove.value === 'vote') return '点选一位玩家';
  if (canWolfKill.value || myMove.value === 'inspect' || myMove.value === 'shoot') return '点选座位，再确认操作';
  return '';
});
const deadText = computed(() => deaths.value
  .map((entry) => `${entry.seatNo}号（第${entry.day}${entry.phase === 'night' ? '夜' : '天'}）`)
  .join('、'));

/* —— 发言与历史 —— */
const speeches = computed<WSpeech[]>(() => table.value.speeches ?? []);
const lastSpeech = computed<WSpeech | null>(() => (speeches.value.length ? speeches.value[speeches.value.length - 1] : null));
const todaySpeeches = computed<WSpeech[]>(() => speeches.value
  .filter((entry) => entry.day === table.value.day));
const playerSpeeches = computed<WSpeech[]>(() => speeches.value
  .filter((entry) => entry.seatNo === playerFilter.value));
const voteRounds = computed<WVoteRound[]>(() => (table.value.votes ?? []).slice().reverse());

const historyBox = ref<HTMLElement | null>(null);

function scrollTodayToLatest(): void {
  const node = historyBox.value;
  if (node && tab.value === 'today') node.scrollTop = node.scrollHeight;
}

watch([historyBox, tab, roomChatOpen, tableIdValue, () => table.value.day], scrollTodayToLatest, { flush: 'post' });
watch(() => todaySpeeches.value.length, () => {
  const node = historyBox.value;
  if (node && tab.value === 'today' && node.scrollHeight - node.scrollTop - node.clientHeight < 80) {
    void nextTick(scrollTodayToLatest);
  }
});

function whoKindOf(entry: WSpeech): string {
  const seat = entry.seatNo !== undefined ? seatAt(entry.seatNo) : null;
  return seat ? (KIND_LABEL[seat.kind ?? ''] ?? '') : '';
}
function speechName(entry: WSpeech): string {
  if (entry.seatName) return entry.seatName;
  const seat = entry.seatNo !== undefined ? seatAt(entry.seatNo) : null;
  return seat?.name ?? '';
}
const seerInspections = computed(() => (priv.value?.role === 'seer' ? (priv.value.inspections ?? []) : []));
const wolfChat = computed(() => (priv.value?.role === 'wolf' && priv.value.alive !== false ? (priv.value.wolfChat ?? []) : []));
const wolfVotes = computed(() => (priv.value?.role === 'wolf' && priv.value.alive !== false ? (priv.value.killVotes ?? []) : []));
const lockedKill = computed(() => (priv.value?.role === 'wolf' && priv.value.alive !== false ? priv.value.lockedKill : undefined));

/* —— 操作条派生 —— */
const targetsAliveOthers = computed<number[]>(() => seats.value
  .filter((seat) => seat.alive !== false && seat.seatNo !== mySeatNo.value)
  .map((seat) => seat.seatNo ?? 0));
const voteTargets = computed<number[]>(() => {
  const own = priv.value;
  if (!own) return [];
  if (own.voteVariant === 'pk') return own.pkSeats ?? [];
  return targetsAliveOthers.value;
});
const wolfTargets = computed(() => seats.value.map((seat) => seat.seatNo ?? 0).filter(aliveOf));
const submitted = computed<string[]>(() => priv.value?.submitted ?? []);
const potions = computed(() => priv.value?.potions ?? { antidote: 0, poison: 0 });
const knownKill = computed(() => priv.value?.knownKill);
const witchHint = computed(() => {
  const own = potions.value;
  const known = knownKill.value;
  let text = `药量：解药 ${own.antidote}、毒药 ${own.poison}；每夜只能用其中一瓶。`;
  if (own.antidote > 0) {
    text += known === null || known === undefined ? '（今夜刀口未知）' : `今夜刀口：${known}号 ${nameOfNo(known)}`;
  } else {
    text += '（解药已空，不再得知刀口）';
  }
  return text;
});
const checkSubmittedToday = computed(() => submitted.value.includes('inspect')
  || (priv.value?.inspections ?? []).some((entry) => entry.day === table.value.day));
const waitText = computed(() => {
  const own = priv.value;
  if (!own) return '';
  if (own.alive === false) return '出局后保留座位，只看公开桌面与自己的秘密；终局会揭牌。';
  if (table.value.phase === 'night') return '夜里有人在行动；天亮见。';
  if (table.value.phase === 'speech' && table.value.turn) {
    return `等 ${seatLabel(seatNoOf(table.value.turn))} 发言。`;
  }
  if (table.value.phase === 'vote') {
    if (own.myVote === undefined) return '投票进行中；到点统一揭晓。';
    if (own.myVote === null) return '你已弃票，到点统一揭晓。';
    return `你已投给 ${own.myVote} 号，到点统一揭晓。`;
  }
  return '等下一个窗口。';
});
const nowHint = computed(() => {
  if (table.value.phase === 'reveal') return '大家在看身份牌，马上入夜。';
  if (table.value.phase === 'night') return '夜晚：天亮会公布结果；你的私视图里有你自己的行动。';
  if (table.value.phase === 'vote') return '投票进行中，到点统一揭晓；截止前谁投给谁不会公开。';
  return '';
});

/* —— 终局 —— */
const end = computed(() => {
  const event = props.view.endEvent as { data?: Record<string, unknown> } | null;
  const data = (event?.data ?? {}) as {
    outcome?: string; winners?: string[]; roles?: Array<{ seatNo: number; name: string; role: string; alive?: boolean }>;
  };
  const outcome = data.outcome || table.value.result?.outcome || 'draw';
  const verdict = outcome === 'good' ? '好人阵营胜利' : outcome === 'wolf' ? '狼人阵营胜利' : '平局';
  const winners = new Set<string>(data.winners ?? table.value.result?.winners ?? []);
  const roles = data.roles ?? table.value.revealed ?? [];
  const mineRole = roles.find((entry) => entry.seatNo === mySeatNo.value) ?? null;
  const mine = !mineRole ? ''
    : outcome === 'draw' ? '平局'
      : winners.size === 0 ? ''
        : (winners.has(props.view.me.id) ? '你在赢的阵营里' : '你在输的阵营里');
  const rows = roles.map((entry) => ({
    entry,
    winner: (() => {
      const seat = seats.value.find((item) => item.seatNo === entry.seatNo);
      return !!seat?.id && winners.has(seat.id);
    })(),
  }));
  return { verdict, mineRole, mine, rows };
});
function roleArtUrl(role: string): string {
  return `/play/assets/assets/werewolf/roles/${role}.jpg`;
}

/* —— 生命周期与预载 —— */
function onVisibility(): void {
  if (document.hidden && revealed.value) revealed.value = false;
}

onMounted(() => {
  for (const scope of ['speech', 'wolf']) draftText[scope] = loadDraft(scope);
  for (const role of ROLES) {
    const img = new Image();
    img.src = roleArtUrl(role);
  }
  document.addEventListener('visibilitychange', onVisibility);
});
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility);
});
</script>

<template>
  <section class="panel game-werewolf" :class="{ 'is-night': isNight, 'is-day': !isNight, 'is-playing': !ended }">
    <template v-if="ended">
      <div class="wf-end">
        <div class="wf-end-banner">
          <span class="wf-end-kicker">狼人杀 · 终局</span>
          <h2>{{ end.verdict }}</h2>
          <p v-if="end.mineRole" class="wf-end-sub">
            你是 {{ ROLE_NAMES[end.mineRole.role] }}（{{ ROLE_FACTIONS[end.mineRole.role] }}）{{ end.mine ? ' · ' + end.mine : '' }}。
          </p>
        </div>
        <div class="wf-end-seats">
          <button
            v-for="row in end.rows"
            :key="'end-' + row.entry.seatNo"
            class="wf-endcard"
            :class="{ 'is-winner': row.winner }"
            type="button"
            :aria-label="`${row.entry.seatNo}号 ${row.entry.name}：${ROLE_NAMES[row.entry.role]}，点击放大`"
            @click="openEnlarge(row.entry.role)"
          >
            <span class="wf-endcard-art" :class="{ 'is-missing': endMissing[row.entry.seatNo] }">
              <img
                v-if="!endMissing[row.entry.seatNo]"
                :src="roleArtUrl(row.entry.role)"
                alt=""
                loading="lazy"
                @error="endMissing[row.entry.seatNo] = true"
              >
            </span>
            <span class="wf-endcard-name">{{ row.entry.seatNo }}号 {{ row.entry.name }}{{ row.entry.alive === false ? '·出局' : '' }}</span>
            <span class="wf-endcard-role">{{ ROLE_NAMES[row.entry.role] }}</span>
          </button>
        </div>
        <div class="wf-end-actions">
          <button class="btn primary" type="button" @click="ctx.rematch()">再来一局</button>
          <button class="btn ghost" type="button" @click="ctx.showLobby()">返回客厅</button>
        </div>
      </div>
      <section v-if="seerInspections.length" class="wf-panel wf-inspections">
        <h3 class="wf-panel-title">我的查验记录（仅自己可见）</h3>
        <div class="wf-tabbody">
          <p v-for="entry in seerInspections" :key="'end-inspect-' + entry.day + '-' + entry.target" class="wf-role-mates">
            第{{ entry.day }}夜 · {{ seatLabel(entry.target) }}：{{ entry.result === 'wolf' ? '狼人' : '好人' }}
          </p>
        </div>
      </section>
    </template>

    <template v-else>
      <div class="wf-main">
        <aside class="wf-room" :class="{ 'is-open': infoOpen }" aria-label="房间信息">
          <header class="wf-column-head">
            <p class="wf-eyebrow">房间</p>
            <h2 class="wf-column-title">房间信息</h2>
          </header>
          <button class="btn ghost small wf-mobile-toggle" type="button"
            :aria-expanded="infoOpen" aria-controls="wf-room-content" @click="infoOpen = !infoOpen">
            {{ infoOpen ? '收起房间信息' : '房间信息' }}
          </button>
          <div id="wf-room-content" class="wf-room-content">
            <section class="wf-panel wf-room-summary">
              <h3>{{ capacity }} 人局</h3>
              <p>{{ roleLine }}</p>
              <p v-if="tableIdValue()" class="wf-table-id">桌号 {{ tableIdValue() }}</p>
            </section>
            <div class="wf-mebar">
              <template v-if="priv?.role">
                <button class="wf-id-toggle" type="button" :class="{ 'is-wolf': priv.role === 'wolf' }"
                  :aria-expanded="identityOpen" :aria-controls="identityOpen ? 'wf-identity-card' : undefined" @click="identityOpen = !identityOpen">
                  <span class="wf-identity-meta"><Icon name="lock" /> 仅自己可见</span>
                  <span class="wf-identity-role">{{ ROLE_NAMES[priv.role] }}</span>
                  <span class="wf-identity-meta">{{ ROLE_FACTIONS[priv.role] }} · {{ identityOpen ? '收起身份牌' : '查看身份牌' }}</span>
                </button>
                <span v-if="priv.alive === false" class="wf-mark dead">你已出局 · 观战到终局</span>
              </template>
              <span v-else class="wf-hint">你在旁观这张桌。</span>
            </div>
            <div v-if="identityOpen && priv?.role" id="wf-identity-card" class="wf-id-drawer">
              <h3 class="wf-panel-title">我的身份（仅自己可见）</h3>
              <WerewolfRoleFace :role="priv.role" :mates="priv.teammates" :with-close="true" @close="closeIdentity" />
            </div>
            <section v-if="seerInspections.length" class="wf-panel wf-inspections">
              <h3 class="wf-panel-title">我的查验记录（仅自己可见）</h3>
              <div class="wf-tabbody">
                <p v-for="entry in seerInspections" :key="'inspect-' + entry.day + '-' + entry.target" class="wf-role-mates">
                  第{{ entry.day }}夜 · {{ seatLabel(entry.target) }}：{{ entry.result === 'wolf' ? '狼人' : '好人' }}
                </p>
              </div>
            </section>
            <section class="wf-panel wf-round-summary">
              <h3 class="wf-panel-title">本局局面</h3>
              <dl>
                <div><dt>存活</dt><dd>{{ aliveCount }}</dd></div>
                <div><dt>出局</dt><dd>{{ seats.length - aliveCount }}</dd></div>
                <div v-if="table.day"><dt>天数</dt><dd>{{ table.day }}</dd></div>
              </dl>
              <p v-if="deaths.length" class="wf-hint">已出局：{{ deadText }}</p>
            </section>
          </div>
        </aside>

        <div class="wf-board">
          <div class="wf-strip">
            <span class="wf-pill" :class="{ live: !!myMove }">
              <Icon :name="isNight ? 'moon' : 'sun'" />
              {{ coreDayText }}
            </span>
            <span v-if="table.deadline" class="wf-clock">
              <ClockText :deadline="table.deadline" :server-now="ctx.serverNow" />
            </span>
          </div>
          <div class="wf-ring-wrap">
            <div class="wf-ring" :class="'seats-' + capacity">
              <span class="wf-felt-mark" aria-hidden="true">WEREWOLF</span>
              <div class="wf-table-core">
                <div v-if="table.phaseLabel && table.phaseLabel !== phaseText" class="wf-core-day">{{ table.phaseLabel }}</div>
                <div class="wf-core-phase">{{ phaseText }}</div>
                <div v-if="coreSubText" class="wf-core-sub" :class="{ 'is-picked': pickedNo != null }">{{ coreSubText }}</div>
              </div>
              <template v-for="slot in ringSlots" :key="'ring-' + slot.area">
                <button
                  v-if="seatAt(slot.seatNo)"
                  type="button"
                  :class="seatClasses(seatAt(slot.seatNo)!, slot.area)"
                  :aria-label="seatAria(seatAt(slot.seatNo)!)"
                  :aria-pressed="canTarget(slot.seatNo) ? pickedNo === slot.seatNo : undefined"
                  @click="onSeatClick(seatAt(slot.seatNo)!)"
                >
                  <span class="wf-seat-medallion">{{ initialOf(seatAt(slot.seatNo)!.name) }}</span>
                  <span class="wf-seatname">
                    <span class="wf-seatno">{{ seatAt(slot.seatNo)!.seatNo }}号</span>
                    {{ seatAt(slot.seatNo)!.name }}
                  </span>
                  <span class="wf-seat-tags">
                    <span v-if="seatAt(slot.seatNo)!.alive === false" class="wf-mark dead">已出局</span>
                    <span v-else-if="!onlineOf(slot.seatNo)" class="wf-mark off">离线</span>
                    <span v-else-if="isMe(seatAt(slot.seatNo)!)" class="wf-mark self">你</span>
                    <span v-else-if="seatAt(slot.seatNo)!.kind === 'pet'" class="wf-kind">Coo</span>
                  </span>
                </button>
                <div v-else :class="['wf-seat-empty', slot.area]" />
              </template>
            </div>
          </div>
          <div v-if="table.phase === 'reveal' && priv?.role" class="wf-reveal">
            <div class="wf-idflip" :class="{ 'is-open': revealed }">
              <button class="wf-card-back" type="button" aria-label="点击查看你的身份" @click="revealed = true">
                <span class="wf-card-back-inner">狼人杀</span>
                <span class="wf-card-back-hint">点击查看你的身份</span>
              </button>
              <WerewolfRoleFace :role="priv.role" :mates="priv.teammates" :with-close="true" @close="closeIdentity" />
            </div>
            <p v-if="!revealed" class="wf-reveal-hint">看身份阶段；倒计时结束后自动盖牌，之后在「我的身份」里随时再看。</p>
          </div>
          <div class="wf-actionbar">
            <div v-if="myMove === 'vote'" class="wf-composer">
              <p class="wf-composer-hint">
                {{ priv?.voteVariant === 'pk' ? '复投：只能投给进入 PK 的席位，或弃票；到点统一揭晓。' : '一人一票，不能投自己，可以弃票；提交后不能改，到点统一揭晓。' }}
              </p>
              <div class="wf-composer-note">点座位或点下面的名字选人；选中 ≠ 提交。</div>
              <div class="wf-targets">
                <button
                  v-for="no in voteTargets"
                  :key="'vote-target-' + no"
                  class="wf-chip"
                  :class="{ 'is-active': votePick?.target === no }"
                  type="button"
                  @click="votePick = { target: no }"
                >{{ seatLabel(no) }}</button>
              </div>
              <div class="wf-confirm">
                <button
                  v-if="votePick && votePick.target !== null"
                  class="btn primary"
                  type="button"
                  @click="submitVote"
                >投给 {{ seatLabel(votePick.target) }}，提交后不可改</button>
                <button
                  v-else-if="votePick && votePick.target === null"
                  class="btn primary"
                  type="button"
                  @click="submitVote"
                >确认弃票（提交后不可改）</button>
                <button v-else class="btn ghost" type="button" @click="votePick = { target: null }">弃票</button>
              </div>
            </div>
            <div v-else-if="wolfKillWindow" class="wf-composer">
              <p v-if="!canWolfKill" class="wf-composer-hint">你的刀票已经交了，到点锁定刀口。</p>
              <template v-else>
                <p class="wf-composer-hint">交一张刀票，可投任意存活玩家。唯一最高票成为刀口，平票或全弃则空刀。</p>
                <div class="wf-targets">
                  <button
                    v-for="no in wolfTargets"
                    :key="'wolf-target-' + no"
                    class="wf-chip"
                    :class="{ 'is-active': wolfKillPick === no }"
                    type="button"
                    @click="wolfKillPick = wolfKillPick === no ? null : no"
                  >{{ seatLabel(no) }}{{ no === mySeatNo ? '（自己）' : '' }}</button>
                </div>
                <div class="wf-confirm">
                  <button v-if="wolfKillPick !== null" class="btn primary" type="button" @click="submitWolfKill">刀 {{ seatLabel(wolfKillPick) }}</button>
                  <button class="btn ghost" type="button" @click="giveUpWolfKill">弃刀</button>
                </div>
              </template>
            </div>
            <div v-else-if="myMove === 'inspect'" class="wf-composer">
              <template v-if="checkSubmittedToday">
                <p class="wf-composer-hint">今夜的槽已交；结果见「我的查验记录」。</p>
              </template>
              <template v-else>
                <p class="wf-composer-hint">查验一名其他存活玩家；不查就点「今夜不查」。</p>
                <div class="wf-targets">
                  <button
                    v-for="no in targetsAliveOthers"
                    :key="'inspect-target-' + no"
                    class="wf-chip"
                    :class="{ 'is-active': inspectPick === no }"
                    type="button"
                    @click="inspectPick = no"
                  >{{ seatLabel(no) }}</button>
                </div>
                <div class="wf-confirm">
                  <button v-if="inspectPick !== null" class="btn primary" type="button" @click="submitInspect">查验 {{ seatLabel(inspectPick) }}</button>
                  <button class="btn ghost" type="button" @click="skipInspect">今夜不查</button>
                </div>
              </template>
            </div>

            <div v-else-if="myMove === 'guard'" class="wf-composer">
              <p class="wf-composer-hint">守一名存活玩家，可以自守或空守。</p>
              <p v-if="priv?.previousGuard" class="wf-composer-note">
                昨夜守了 {{ seatLabel(priv.previousGuard) }}，今夜不能连守。
              </p>
              <div class="wf-targets">
                <button
                  v-for="seat in seats.filter((entry) => entry.seatNo && canTarget(entry.seatNo))"
                  :key="seat.seatNo"
                  class="wf-chip"
                  :class="{ 'is-active': guardPick === seat.seatNo }"
                  type="button"
                  @click="guardPick = seat.seatNo!"
                >{{ seatLabel(seat.seatNo!) }}</button>
              </div>
              <div class="wf-confirm">
                <button v-if="guardPick !== null" class="btn primary" type="button" @click="submitGuard(guardPick)">
                  守护 {{ seatLabel(guardPick) }}
                </button>
                <button class="btn ghost" type="button" @click="submitGuard(null)">今夜空守</button>
              </div>
            </div>
            <div v-else-if="myMove === 'witch'" class="wf-composer">
              <p class="wf-composer-hint">{{ witchHint }}</p>
              <div v-if="potions.poison > 0" class="wf-targets">
                <button
                  v-for="no in targetsAliveOthers"
                  :key="'poison-target-' + no"
                  class="wf-chip"
                  :class="{ 'is-active': poisonPick === no }"
                  type="button"
                  @click="poisonPick = no"
                >{{ seatLabel(no) }}</button>
              </div>
              <div class="wf-confirm">
                <button v-if="potions.antidote > 0 && knownKill !== null && knownKill !== undefined" class="btn primary" type="button" @click="witchSave">
                  救 {{ seatLabel(knownKill) }}
                </button>
                <button v-if="potions.poison > 0 && poisonPick !== null" class="btn primary" type="button" @click="witchPoison">毒 {{ seatLabel(poisonPick) }}</button>
                <button class="btn ghost" type="button" @click="witchNone">今晚不用药</button>
              </div>
              <p v-if="potions.antidote > 0 && knownKill === null" class="wf-hint">今夜没有刀口；解药只能抵消狼刀。</p>
            </div>

            <div v-else-if="myMove === 'shoot'" class="wf-composer">
              <p class="wf-composer-hint">你是猎人：可以带走一名其他存活玩家，也可以放弃（公开亮明身份后开枪）。</p>
              <div class="wf-targets">
                <button
                  v-for="no in targetsAliveOthers"
                  :key="'shoot-target-' + no"
                  class="wf-chip"
                  :class="{ 'is-active': shootPick === no }"
                  type="button"
                  @click="shootPick = no"
                >{{ seatLabel(no) }}</button>
              </div>
              <div class="wf-confirm">
                <button v-if="shootPick !== null" class="btn primary" type="button" @click="shootAt">开枪带走 {{ seatLabel(shootPick) }}</button>
                <button class="btn ghost" type="button" @click="giveUpShoot">放弃开枪</button>
              </div>
            </div>

            <div v-else-if="priv?.role && !chatMove" class="wf-wait"><span>{{ waitText }}</span></div>
          </div>
        </div>

        <aside class="wf-side" :class="{ 'is-open': roomChatOpen }" aria-label="房间聊天">
          <header class="wf-column-head">
            <p class="wf-eyebrow">本局记录</p>
            <h2 class="wf-column-title">房间聊天</h2>
          </header>
          <button class="btn ghost small wf-mobile-toggle" type="button"
            :aria-expanded="roomChatOpen" aria-controls="wf-room-chat" @click="roomChatOpen = !roomChatOpen">
            {{ roomChatOpen ? '收起房间聊天' : wolfChatRemaining > 0 ? '房间聊天 · 狼队私聊' : chatMove ? '房间聊天 · 轮到你发言' : '房间聊天' }}
          </button>
          <div id="wf-room-chat" class="wf-room-chat">
            <section v-if="nowHint || (lastSpeech && tab !== 'today')" class="wf-panel wf-now">
              <h3 class="wf-panel-title">{{ nowHint ? '牌桌提示' : '最新发言' }}</h3>
              <p v-if="nowHint" class="wf-hint">{{ nowHint }}</p>
              <WerewolfSpeech
                v-else-if="lastSpeech"
                :entry="{ ...lastSpeech, seatName: speechName(lastSpeech) }"
                :who-kind="whoKindOf(lastSpeech)"
                :live="true"
              />
            </section>
            <section v-if="wolfChat.length || wolfVotes.length || lockedKill != null" class="wf-panel wf-wolf-info">
              <h3 class="wf-panel-title">狼队信息（仅狼人可见）</h3>
              <div class="wf-tabbody">
                <p v-if="wolfVotes.length" class="wf-role-mates">
                  已交刀票：{{ wolfVotes.map((entry) => `${entry.seatNo}号→${entry.target === null ? '弃' : `${entry.target}号`}`).join('，') }}
                </p>
                <p v-for="(chat, index) in wolfChat" :key="'wolf-chat-' + index" class="wf-role-mates">
                  {{ chat.seatNo }}号 {{ chat.name }}：「{{ chat.text }}」
                </p>
                <p v-if="lockedKill != null" class="wf-role-mates">今夜锁定刀口：{{ seatLabel(lockedKill) }}</p>
              </div>
            </section>
            <section class="wf-panel wf-history">
              <div class="wf-tabs">
                <button class="wf-tab" :class="{ 'is-active': tab === 'today' }" :aria-pressed="tab === 'today'" type="button" @click="tab = 'today'">本日</button>
                <button class="wf-tab" :class="{ 'is-active': tab === 'votes' }" :aria-pressed="tab === 'votes'" type="button" @click="tab = 'votes'">票型</button>
                <button class="wf-tab" :class="{ 'is-active': tab === 'byPlayer' }" :aria-pressed="tab === 'byPlayer'" type="button" @click="tab = 'byPlayer'">按玩家</button>
              </div>
              <div ref="historyBox" class="wf-tabbody">
                <template v-if="tab === 'today'">
                  <p v-if="!todaySpeeches.length" class="wf-hint">今天还没有发言。</p>
                  <WerewolfSpeech
                    v-for="(entry, index) in todaySpeeches"
                    :key="'today-' + index"
                    :entry="{ ...entry, seatName: speechName(entry) }"
                    :who-kind="whoKindOf(entry)"
                  />
                </template>
                <template v-else-if="tab === 'byPlayer'">
                  <div class="wf-people">
                    <button
                      v-for="seat in seats"
                      :key="'people-' + seat.seatNo"
                      class="wf-chip"
                      :class="{ 'is-active': playerFilter === seat.seatNo }"
                      type="button"
                      @click="playerFilter = seat.seatNo ?? 0"
                    >{{ seat.seatNo }}号 {{ seat.name }}</button>
                  </div>
                  <p v-if="!playerFilter" class="wf-hint">点一个座位，看这个人到目前的全部发言。</p>
                  <p v-else-if="!playerSpeeches.length" class="wf-hint">{{ seatLabel(playerFilter) }} 还没有发言记录。</p>
                  <WerewolfSpeech
                    v-for="(entry, index) in playerSpeeches"
                    :key="'player-' + index"
                    :entry="{ ...entry, seatName: speechName(entry) }"
                    :who-kind="whoKindOf(entry)"
                  />
                </template>
                <template v-else>
                  <p v-if="!voteRounds.length" class="wf-hint">还没有已揭晓的票型。</p>
                  <article v-for="(round, index) in voteRounds" :key="'vote-' + index" class="wf-votes">
                    <h4 class="wf-votes-title">第{{ round.day }}天{{ round.variant === 'pk' ? ' · 复投' : '' }}</h4>
                    <div v-for="(line, lineIndex) in round.entries" :key="'vote-line-' + lineIndex" class="wf-vote-line">
                      <span class="wf-vote-from">{{ line.seatNo }}号</span>
                      <span class="wf-vote-arrow">→</span>
                      <span class="wf-vote-to">
                        {{ line.target == null ? (line.timeout ? '超时弃票' : '弃票') : `${line.target}号 ${nameOfNo(line.target)}` }}
                      </span>
                    </div>
                    <p v-if="round.exiled !== undefined" class="wf-votes-note">放逐：{{ seatLabel(round.exiled) }}</p>
                    <p v-else-if="round.tie" class="wf-votes-note">平票：{{ round.tie.map((no) => seatLabel(no)).join('、') }} 进入 PK</p>
                    <p v-else class="wf-votes-note">无人放逐</p>
                  </article>
                </template>
              </div>
            </section>
            <div v-if="myMove === 'speak'" class="wf-composer">
              <p class="wf-composer-hint">一次机会、一条完整发言（最多 300 字）；提交或过麦后进入全桌阅读。</p>
              <div class="wf-draft">
                <div class="wf-draft-main">
                  <textarea
                    class="wf-input"
                    rows="3"
                    :maxlength="320"
                    :placeholder="speechPlaceholder"
                    :aria-label="speechPlaceholder"
                    :value="draftText.speech"
                    @input="onDraftInput('speech', $event)"
                    @focus="draftFocused = true"
                    @blur="draftFocused = false"
                    @keydown="onDraftKey('speech', $event)"
                  />
                  <div class="wf-draft-row">
                    <span class="wf-count" :class="{ 'is-over': draftCount > 300 }">{{ draftCount }}/300</span>
                    <span class="wf-dclock"><ClockText v-if="priv?.deadline" :deadline="priv.deadline" :server-now="ctx.serverNow" /></span>
                  </div>
                </div>
              </div>
              <div class="wf-send-actions">
                <button class="btn ghost" type="button" @click="passSpeech">过麦</button>
                <button class="btn primary" type="button" @click="sendSpeech">提交并结束发言</button>
              </div>
            </div>
            <div v-else-if="wolfChatRemaining > 0" class="wf-composer">
              <p class="wf-composer-hint">
                狼队私聊可选。刀口锁定前还可发 {{ wolfChatRemaining }} 条，每条最多 150 字，不发也会到点锁刀。
              </p>
              <div class="wf-draft">
                <div class="wf-draft-main">
                  <textarea
                    class="wf-input"
                    rows="3"
                    :maxlength="170"
                    placeholder="只给同伴看…"
                    aria-label="只给同伴看…"
                    :value="draftText.wolf"
                    @input="onDraftInput('wolf', $event)"
                    @focus="draftFocused = true"
                    @blur="draftFocused = false"
                    @keydown="onDraftKey('wolf', $event)"
                  />
                  <div class="wf-draft-row">
                    <span class="wf-count" :class="{ 'is-over': draftCount > 150 }">{{ draftCount }}/150</span>
                    <span class="wf-dclock"><ClockText v-if="priv?.deadline" :deadline="priv.deadline" :server-now="ctx.serverNow" /></span>
                  </div>
                </div>
                <button class="btn primary" type="button" @click="sendWolfChat">交狼聊</button>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </template>

    <div v-if="enlargedImage" class="wf-enlarge" @click.self="closeEnlarge">
      <div class="wf-enlarge-card">
        <img
          v-if="!enlargeMissing"
          :src="roleArtUrl(enlargedImage)"
          :alt="`${ROLE_NAMES[enlargedImage]}身份牌（放大）`"
          @error="enlargeMissing = true"
        >
        <button class="btn small" type="button" @click="closeEnlarge">关闭</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.view-table .game-werewolf.is-playing {
  margin-top: 10px;
  padding: 0;
  border: 0;
  background: transparent;
}

.wf-main {
  grid-template-columns: minmax(170px, .65fr) minmax(0, 1.85fr) minmax(255px, 1fr);
  grid-template-areas: "room board chat";
  align-items: stretch;
  gap: clamp(12px, 1.2vw, 20px);
}

.wf-room { grid-area: room; }
.wf-board { grid-area: board; }
.wf-side { grid-area: chat; }
.wf-room, .wf-board, .wf-room-content, .wf-room-chat {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 10px;
}

.wf-room, .wf-side {
  padding: clamp(12px, 1.2vw, 18px);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: linear-gradient(155deg, var(--panel-2), var(--panel) 42%);
}

.wf-column-head { display: grid; gap: 3px; padding: 2px 2px 5px; }
.wf-eyebrow {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--muted);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: .12em;
}
.wf-eyebrow::before { content: ''; width: 16px; height: 1px; background: var(--lime); }
.game-werewolf .wf-column-title {
  margin: 0;
  color: var(--text);
  font-weight: 700;
}

.wf-room-summary h3, .wf-room-summary p { margin: 0; }
.wf-room-summary h3 { color: var(--text); font-size: 16px; }
.wf-room-summary p { color: var(--muted); font-size: 13px; line-height: 1.5; }
.wf-room-summary .wf-table-id { font-size: 12px; overflow-wrap: anywhere; }
.wf-round-summary dl { display: flex; flex-wrap: wrap; gap: 7px; margin: 0; }
.wf-round-summary dl div { flex: 1 1 38px; padding: 6px; border-radius: 9px; background: var(--panel); }
.wf-round-summary dt { color: var(--muted); font-size: 11px; }
.wf-round-summary dd { margin: 0; font-size: 18px; font-weight: 750; font-variant-numeric: tabular-nums; }

.wf-main .wf-id-toggle {
  display: grid;
  justify-items: start;
  align-content: space-between;
  min-height: 140px;
  width: 100%;
  padding: 14px 12px;
  text-align: left;
  border: 1px solid #e4cb8c55;
  border-radius: 16px;
  background: radial-gradient(ellipse at 45% 0%, #e4cb8c29, transparent 67%), linear-gradient(152deg, #203e34, #122b25);
  color: #fff2cf;
}
.wf-main .wf-id-toggle.is-wolf {
  background: radial-gradient(ellipse at 45% 0%, #d78a7e35, transparent 67%), linear-gradient(152deg, #472a2b, #281c24);
  color: #ffe4de;
}
.wf-identity-role { font-size: clamp(20px, 2vw, 28px); font-weight: 750; }
.wf-identity-meta { display: flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 550; }
.wf-identity-meta .icon { width: 12px; height: 12px; }
.wf-main .wf-id-drawer { max-width: 100%; background: var(--panel-2); border-color: var(--line-2); }

.wf-board { justify-content: space-between; }
.wf-ring-wrap { justify-content: center; flex: 1; }
.wf-board .wf-strip { justify-content: space-between; }
.wf-board .wf-pill { background: var(--panel-2); color: var(--text); border-color: var(--line); font-size: 12px; }
.wf-board .wf-pill.live { border-color: var(--lime); }
.wf-board .wf-pill .icon { width: 14px; height: 14px; }
.wf-board .wf-clock { color: var(--muted); font-size: 12px; }
.wf-ring {
  position: relative;
  display: block;
  width: 100%;
  max-width: 790px;
  margin-inline: auto;
  min-height: 340px;
  aspect-ratio: 1.36;
  border-radius: 50%;
  isolation: isolate;
  border: 1px solid #597f65;
  background: radial-gradient(ellipse at 49% 41%, #4c7358, #2e5845 54%, #15392f 92%);
  box-shadow: inset 0 0 0 8px #132f2666, inset 0 0 50px #0b281d70, 0 20px 56px #0004;
}

.game-werewolf.is-night .wf-ring {
  border-color: #496d66;
  background:
    radial-gradient(circle at 26% 33%, #e1f5cf85 0 1px, transparent 1.6px),
    radial-gradient(circle at 69% 29%, #c4e5d274 0 1px, transparent 1.6px),
    radial-gradient(circle at 42% 72%, #e1f5cf65 0 1px, transparent 1.6px),
    radial-gradient(circle at 76% 58%, #c4e5d260 0 1px, transparent 1.6px),
    radial-gradient(ellipse at 48% 42%, #355952, #203e39 60%, #122e2a 92%);
  box-shadow: inset 0 0 0 8px #0f292570, inset 0 0 50px #071d1a70, 0 20px 56px #0004;
}
.wf-ring::before {
  content: '';
  position: absolute;
  inset: 10px;
  border: 1px dashed #ebf4d02c;
  border-radius: inherit;
  pointer-events: none;
}
.wf-felt-mark {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #e2efc419;
  font-size: clamp(20px, 4.1vw, 64px);
  font-weight: 850;
  letter-spacing: .14em;
  pointer-events: none;
}

.wf-table-core, .wf-seat {
  position: absolute;
  transform: translate(-50%, -50%);
}

.wf-table-core { top: 50%; left: 50%; width: 50%; padding: 0; gap: 7px; color: #f3f9f3; }
.wf-core-day { font-size: 11px; color: #dfedcd; letter-spacing: .1em; }
.wf-core-phase { font-size: clamp(16px, 1.85vw, 28px); font-weight: 800; line-height: 1.2; text-wrap: balance; overflow-wrap: anywhere; }
.wf-core-sub { color: #e6f0e7; font-size: 12px; opacity: 1; }
.wf-core-sub.is-picked {
  padding: 2px 8px;
  border: 1px solid #ffd4ac85;
  border-radius: 99px;
  background: #112d24cc;
  color: #ffe7cd;
}
.wf-ring .wf-seat {
  top: var(--seat-y);
  left: var(--seat-x);
  width: min(23%, 100px);
  min-height: 44px;
  padding: 3px 2px;
  border: 0;
  background: transparent;
  color: #f3f9f3;
  gap: 4px;
  box-shadow: none;
}

.wf-seat.a1 { --seat-x: 50%; --seat-y: 87%; }
.wf-seat.a2 { --seat-x: 26%; --seat-y: 79%; }
.wf-seat.a3 { --seat-x: 13%; --seat-y: 60%; }
.wf-seat.a4 { --seat-x: 15%; --seat-y: 36%; }
.wf-seat.a5 { --seat-x: 34%; --seat-y: 18%; }
.wf-seat.a6 { --seat-x: 66%; --seat-y: 18%; }
.wf-seat.a7 { --seat-x: 85%; --seat-y: 36%; }
.wf-seat.a8 { --seat-x: 87%; --seat-y: 60%; }
.wf-seat.a9 { --seat-x: 74%; --seat-y: 79%; }
.wf-ring.seats-6 .a1 { --seat-x: 50%; --seat-y: 86%; }
.wf-ring.seats-6 .a2 { --seat-x: 19%; --seat-y: 69%; }
.wf-ring.seats-6 .a3 { --seat-x: 19%; --seat-y: 31%; }
.wf-ring.seats-6 .a4 { --seat-x: 50%; --seat-y: 14%; }
.wf-ring.seats-6 .a5 { --seat-x: 81%; --seat-y: 31%; }
.wf-ring.seats-6 .a6 { --seat-x: 81%; --seat-y: 69%; }
.wf-ring.seats-12 .a1 { --seat-x: 50%; --seat-y: 88%; }
.wf-ring.seats-12 .a2 { --seat-x: 31%; --seat-y: 84%; }
.wf-ring.seats-12 .a3 { --seat-x: 17%; --seat-y: 70%; }
.wf-ring.seats-12 .a4 { --seat-x: 13%; --seat-y: 50%; }
.wf-ring.seats-12 .a5 { --seat-x: 17%; --seat-y: 30%; }
.wf-ring.seats-12 .a6 { --seat-x: 31%; --seat-y: 16%; }
.wf-ring.seats-12 .a7 { --seat-x: 50%; --seat-y: 12%; }
.wf-ring.seats-12 .a8 { --seat-x: 69%; --seat-y: 16%; }
.wf-ring.seats-12 .a9 { --seat-x: 83%; --seat-y: 30%; }
.wf-ring.seats-12 .a10 { --seat-x: 87%; --seat-y: 50%; }
.wf-ring.seats-12 .a11 { --seat-x: 83%; --seat-y: 70%; }
.wf-ring.seats-12 .a12 { --seat-x: 69%; --seat-y: 84%; }
.wf-ring.seats-12 .wf-seat { width: min(17%, 86px); }
.wf-ring.seats-12 .wf-seat-medallion { width: clamp(26px, 3vw, 44px); }
.wf-seat-empty { display: none; }
.wf-seat-medallion {
  display: grid;
  place-items: center;
  width: clamp(36px, 3.7vw, 54px);
  aspect-ratio: 1;
  border: 1px solid #dcebd460;
  border-radius: 50%;
  background: linear-gradient(145deg, #e2efde36, #102f2988);
  box-shadow: 0 4px 12px #061b2440;
  font-size: clamp(15px, 1.45vw, 22px);
  font-weight: 700;
  line-height: 1;
}
.wf-seat .wf-seatname { font-size: 12px; line-height: 1.2; }
.wf-seat .wf-seatno { font-size: 10px; color: #e0ead8; font-variant-numeric: tabular-nums; }
.wf-seat .wf-kind { background: #17382b; color: #f5e5bb; }
.wf-seat .wf-mark { color: #f7ddd4; }
.wf-seat .wf-mark.self { color: #e1f8a1; }
.wf-ring button.wf-seat:is(.is-me, .is-speaking, .is-targetable:hover, .is-targetable:focus-visible) {
  background: transparent;
  box-shadow: none;
}
.wf-seat.is-targetable .wf-seat-medallion { border-style: dashed; }
.wf-seat.is-me .wf-seat-medallion, .wf-seat.is-speaking .wf-seat-medallion,
.wf-seat.is-targetable:hover .wf-seat-medallion { border-color: #d9f889; }
.wf-seat.is-speaking .wf-seat-medallion {
  box-shadow: 0 0 0 3px #d9f88942, 0 0 19px #d9f88960;
}
.wf-seat.is-picked .wf-seat-medallion {
  border: 2px solid #ffd4ac;
  box-shadow: 0 0 0 3px #ffd4ac3b, 0 0 19px #ffd4ac66;
}
.wf-seat.is-dead { opacity: .7; }
.wf-seat.is-dead .wf-seatname { text-decoration: line-through; }

.wf-actionbar, .wf-room-chat > .wf-composer {
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--panel);
  padding: 10px;
}
.wf-actionbar:empty { display: none; }
.wf-actionbar > .wf-composer { background: transparent; }
.wf-room-chat { flex: 1; }
.wf-room-chat > .wf-composer { margin-top: auto; border-color: var(--line-2); }
.wf-room-chat .wf-draft { flex-direction: column; }
.wf-room-chat .wf-draft > .btn { align-self: flex-end; }
.wf-send-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }

.wf-main .wf-panel {
  border-color: var(--line);
  background: var(--panel-2);
  color: var(--text);
}
.wf-main .wf-history { padding: 0; border: 0; background: transparent; }
.wf-history .wf-tabs { gap: 14px; border-bottom: 1px solid var(--line); }
.wf-main .wf-tab {
  padding: 6px 2px 8px;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  color: var(--muted);
}
.wf-main .wf-tab.is-active { border-bottom-color: var(--lime); background: transparent; color: var(--text); }
.wf-history .wf-tabbody { padding: 2px 1px; max-height: min(42vh, 430px); }
.wf-history .wf-votes { border: 1px solid var(--line); background: var(--panel-2); }
.wf-main .wf-panel-title, .wf-main .wf-hint, .wf-main .wf-role-mates,
.wf-main .wf-composer-hint, .wf-main .wf-composer-note, .wf-main .wf-draft-row,
.wf-main .wf-wait, .wf-main .wf-reveal-hint { color: var(--muted); }
.wf-main .wf-input {
  background: var(--panel-2);
  color: var(--text);
  border-color: var(--line-2);
}
.wf-main .wf-chip { border-color: var(--line-2); color: var(--text); }
.wf-main .wf-chip.is-active {
  border-color: var(--lime);
  background: var(--lime);
  color: var(--lime-ink);
}
.game-werewolf .wf-end-banner {
  padding: clamp(18px, 3vw, 34px);
  border: 1px solid #dfc78852;
  border-radius: var(--radius);
  background: radial-gradient(ellipse at 10% 0%, #dbc77b31, transparent 70%), #17352d;
  color: #fff1cc;
}
.game-werewolf .wf-end-kicker, .game-werewolf .wf-end-sub { color: #ebdcba; }
.game-werewolf .wf-end-banner h2 { color: #fff1cc; font-size: clamp(24px, 3vw, 40px); }
.game-werewolf .wf-mobile-toggle { display: none; }

@media (max-width: 1100px) {
  .wf-main {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "board" "chat" "room";
  }
  .wf-ring { max-width: 680px; margin-inline: auto; }
  .wf-room, .wf-side { padding: 10px; }
  .wf-column-head,
  .wf-room:not(.is-open) .wf-room-content,
  .wf-side:not(.is-open) .wf-room-chat { display: none; }
  .game-werewolf .wf-mobile-toggle { display: inline-flex; align-self: flex-start; }
}

@media (max-width: 550px) {
  .wf-ring { min-height: 0; aspect-ratio: 1; }
  .wf-ring .wf-seat { gap: 2px; }
  .wf-seat .wf-seatname { font-size: 11px; }
  .wf-seat .wf-seatno { font-size: 9px; }
  .wf-table-core { gap: 4px; }
  .wf-seat.a1 { --seat-y: 86%; }
  .wf-actionbar .wf-composer-note { display: none; }
}
</style>
