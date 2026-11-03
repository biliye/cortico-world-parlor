import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive } from 'vue';
import { gameComponent, sourceFunction } from './helpers/game-component.ts';

const werewolf = gameComponent('WerewolfGame.vue');
const ddz = gameComponent('DdzGame.vue');
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach((stop) => stop()); vi.unstubAllGlobals(); });

function fixture(game = 'werewolf'): any {
  return reactive({
    table: {
      tableId: 't1', status: 'playing', phase: 'night', game, day: 1,
      seats: [1, 2, 3, 4].map((n) => ({ id: `s${n}`, name: `玩家${n}`, seatNo: n, alive: true, kind: 'human' })),
    },
    priv: { role: 'wolf', canAct: true, myMove: 'wolf_kill', windowId: 'w1', hand: ['3', '4'], yourTurn: true },
    me: { id: 's1', name: '玩家1' }, seats: [], names: new Map(), classes: new Map(), online: [], now: 0,
  });
}
function context(act = vi.fn().mockResolvedValue(null)): any {
  return { act, toast: vi.fn(), serverNow: () => 0 };
}
function logic(component: typeof werewolf, view: any, ctx: any) {
  const instance = component.logic({ view, ctx });
  cleanup.push(instance.stop);
  return instance.state;
}

describe('W1/E1：未发出或失败的动作保留输入', () => {
  it.each(['store', 'legacy'])('%s 忙闸门返回 null 并明确提示未发送', async (entry) => {
    const toast = vi.fn();
    const path = entry === 'store' ? 'web-src/stores/parlor.ts' : 'src/web/play.js';
    const act = sourceFunction(path, 'act', { acting: true, state: { busy: true }, showToast: toast });
    expect(await act({ type: 'werewolf_action', move: 'speak' })).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('尚未发送'), 'bad');
  });

  it.each([null, false, 'reject', { seq: 3 }])('狼人杀仅成功回执清草稿：%j', async (receipt) => {
    const storage = new Map<string, string>();
    vi.stubGlobal('location', { host: 'local.test' });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    const ctx = context(receipt === 'reject' ? vi.fn().mockRejectedValue(new Error('409')) : vi.fn().mockResolvedValue(receipt));
    const state = logic(werewolf, fixture(), ctx);
    state.draftText.speech = '保留发言';
    state.saveDraft('speech', '保留发言');
    state.sendSpeech();
    await vi.waitFor(() => expect(ctx.act).toHaveBeenCalledTimes(1));
    await nextTick();
    const sent = !!receipt && receipt !== 'reject';
    expect(state.draftText.speech).toBe(sent ? '' : '保留发言');
    expect(storage.size).toBe(sent ? 0 : 1);
  });

  it.each([null, false, 'reject', { seq: 3 }])('legacy 狼人杀也仅成功回执执行清理：%j', async (receipt) => {
    const onOk = vi.fn();
    const act = sourceFunction('src/web/games/werewolf.js', 'act', {
      view: { priv: { windowId: 'w1' } },
      ctx: context(receipt === 'reject' ? vi.fn().mockRejectedValue(new Error('400')) : vi.fn().mockResolvedValue(receipt)),
    });
    await act({ move: 'speak', text: '草稿' }, onOk);
    expect(onOk).toHaveBeenCalledTimes(receipt && receipt !== 'reject' ? 1 : 0);
  });

  it.each(['sendPlay', 'sendPass', 'sendBid'])('斗地主 %s 失败/忙时保留选牌，成功才清', async (action) => {
    for (const receipt of [null, false, 'reject', { seq: 3 }]) {
      const ctx = context(receipt === 'reject' ? vi.fn().mockRejectedValue(new Error('409')) : vi.fn().mockResolvedValue(receipt));
      const state = logic(ddz, fixture('ddz'), ctx);
      state.toggleCard(0);
      state[action](true);
      await nextTick(); await nextTick();
      expect(state.selection.value.size).toBe(receipt && receipt !== 'reject' ? 0 : 1);
    }
  });

  it('旧请求成功不会清除等待期间重新选择的牌', async () => {
    let done!: (value: unknown) => void;
    const state = logic(ddz, fixture('ddz'), context(vi.fn(() => new Promise((resolve) => { done = resolve; }))));
    state.toggleCard(0);
    state.sendPlay();
    state.toggleCard(1);
    done({ seq: 3 });
    await nextTick(); await nextTick();
    expect([...state.selection.value]).toEqual([0, 1]);
  });

  it.each([null, false, 'reject', { seq: 3 }])('legacy 斗地主也仅成功后清选牌：%j', async (receipt) => {
    const paint = vi.fn();
    const ctx = context(receipt === 'reject' ? vi.fn().mockRejectedValue(new Error('409')) : vi.fn().mockResolvedValue(receipt));
    const send = sourceFunction('src/web/games/ddz.js', 'sendAction', {
      ctx, selection: new Set([0]), paintSelection: paint,
    });
    send({ type: 'ddz_action', move: 'play', cards: ['3'] });
    await nextTick(); await nextTick();
    expect(paint).toHaveBeenCalledTimes(receipt && receipt !== 'reject' ? 1 : 0);
  });
});

describe('W2/W3：选人生命周期与刀票独立状态', () => {
  it('同窗口刷新保留选择，新窗口、阶段、桌或身份变化则清除', async () => {
    const view = fixture();
    const state = logic(werewolf, view, context());
    for (const change of [
      () => { view.priv.windowId = 'w2'; },
      () => { view.table.phase = 'vote'; },
      () => { view.table.tableId = 't2'; },
      () => { view.me.id = 's2'; },
    ]) {
      state.votePick.value = { target: 3 };
      state.inspectPick.value = 3;
      state.poisonPick.value = 3;
      state.shootPick.value = 3;
      state.wolfKillPick.value = 3;
      view.priv = { ...view.priv };
      view.table = { ...view.table, seats: [...view.table.seats] };
      await nextTick();
      expect(state.wolfKillPick.value).toBe(3);
      change();
      await nextTick();
      for (const field of ['votePick', 'inspectPick', 'poisonPick', 'shootPick', 'wolfKillPick']) expect(state[field].value).toBeNull();
    }
  });

  it('重复点击取消刀票，刀票与猎枪互不占用', () => {
    const state = logic(werewolf, fixture(), context());
    state.shootPick.value = 4;
    state.pickTarget(3);
    expect(state.wolfKillPick.value).toBe(3);
    expect(state.shootPick.value).toBe(4);
    state.pickTarget(3);
    expect(state.wolfKillPick.value).toBeNull();
  });
});

describe('W4：真实 Vue 模板的狼队面板', () => {
  it('出局狼人不呈现旧服务器仍下发的后续狼队信息', async () => {
    const view = fixture();
    Object.assign(view.priv, {
      alive: false, canAct: false, myMove: null,
      wolfChat: [{ seatNo: 2, name: '同伴', text: '出局后的新暗号' }],
      killVotes: [{ seatNo: 2, target: 3 }], lockedKill: 3,
    });
    const html = await werewolf.html({ view, ctx: context() });
    expect(html).not.toContain('wf-wolf-info');
    expect(html).not.toContain('出局后的新暗号');
  });
  it.each(['wolf_chat', 'wolf_kill', null])('动作槽 %s 时私信息均可读', async (myMove) => {
    const view = fixture();
    Object.assign(view.priv, {
      myMove, canAct: !!myMove, wolfChat: [{ seatNo: 2, name: '同伴', text: '狼队暗号' }],
      killVotes: [{ seatNo: 2, target: 3 }], lockedKill: 3,
    });
    const html = await werewolf.html({ view, ctx: context() });
    expect(html).toContain('狼队暗号');
    expect(html).toContain('已交刀票');
    expect(html).toContain('今夜锁定刀口');
  });

  it('非狼/旁观者不渲染狼队信息，新夜无数据不残留上一夜', async () => {
    for (const role of ['seer', undefined, 'wolf']) {
      const view = fixture();
      Object.assign(view.priv, { role, myMove: null, canAct: false });
      if (role !== 'wolf') Object.assign(view.priv, { wolfChat: [{ seatNo: 2, text: '秘密' }], killVotes: [{ seatNo: 2, target: 3 }], lockedKill: 3 });
      const html = await werewolf.html({ view, ctx: context() });
      expect(html).not.toContain('wf-wolf-info');
      expect(html).not.toContain('秘密');
    }
  });
});
