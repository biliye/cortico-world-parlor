/**
 * 真机网页验证（公网 + 真实 Chrome，无头）：一个进程里既开桌又开浏览器，避免两脚本抢时序。
 *   pnpm exec tsx scripts/live-aeroplane-web.mts
 * 1) 真客户端在本轮新建的私密厅开一张飞行棋桌；另起身份取家长钥匙（浏览器用它入场）；
 * 2) Chrome 直落牌桌 → 点「坐下」入座 → 真客户端开局 → 点「掷骰」→ 点「认输」；
 * 3) 核对重做后的棋盘、认输确认文案、终局「其余玩家已认输」；
 * 4) Chrome 打开对外首页，点飞行棋规则卡，核对「认输」「只剩一人」；收桌退厅删临时目录。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { qaRequest, ReleaseQaRoom } from './release-qa-room.ts';
import { leaveQaSeat, makeQaClient, qaRun } from './release-qa-client.mts';

if (process.env.DRY === '1') { console.log('imports ok（DRY）'); process.exit(0); }

const CHROME = process.env.PARLOR_QA_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const { base: BASE, scratch } = qaRun();
const SHOTS = resolve('.task-tmp', 'shots', basename(scratch));
const rows: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  rows.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

type BrowserSeat = { room: string; token: string; seatId: string };
const clients: Array<Awaited<ReturnType<typeof makeQaClient>>> = [];
let room: ReleaseQaRoom | undefined;
let bootstrap: { token: string; seat: { id: string } } | undefined;
let captureBrowserSeat: (() => Promise<BrowserSeat>) | undefined;
let browserRegistered = false;
let chrome: ReturnType<typeof spawn> | undefined;
let socket: WebSocket | undefined;
try {
  const host = await makeQaClient(BASE, scratch, 'QA飞行桌主');
  clients.push(host);
  const guest = await makeQaClient(BASE, scratch, 'QA飞行观众');
  clients.push(guest);
  room = await ReleaseQaRoom.create(BASE, host.token);
  const ROOM = room.id;
  console.log('本轮 QA 厅', ROOM);
  const key = guest.secrets.PARLOR_OWNER_TOKEN;
  if (!key) throw new Error('没有拿到本轮家长钥匙');
  // 先让服务器为本轮家长签发玩家身份，再只给这个身份私密厅权限。
  bootstrap = await qaRequest(BASE, guest.token(), '/v1/parent/play', { room: 'hall', key });
  if (!bootstrap?.token || !bootstrap.seat?.id) throw new Error('没有拿到本轮家长的临时席位');
  writeFileSync(join(scratch, 'parent-bootstrap.json'), JSON.stringify({
    token: bootstrap.token, seatId: bootstrap.seat.id,
  }), { mode: 0o600 });
  await room.allow(bootstrap.token);
  await host.call('parlor_room_visit', { room: ROOM });
  await room.captureSeat(host.token());
  const hostState = async () => JSON.parse(await host.call('parlor_game_info', { op: 'state' })) as any;
  await host.call('parlor_table_open', { game: 'aeroplane' });
  const tableId = (await hostState()).table?.id ?? '';
  room.trackTable(tableId);

  mkdirSync(SHOTS, { recursive: true });
  const profile = mkdtempSync(join(scratch, 'chrome-'));
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-component-update',
    '--no-first-run', '--disable-sync', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=0', '--window-size=1440,1000', '--user-data-dir=' + profile, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore', env: { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch } });
  let browserError: Error | undefined;
  chrome.on('error', error => { browserError = error; });

  const retry = async <T,>(task: () => Promise<T> | T, label: string, tries = 100, gap = 150): Promise<T> => {
    let last: unknown;
    for (let i = 0; i < tries; i += 1) {
      try {
        const value = await task();
        if (value) return value;
      } catch (error) { last = error; }
      await delay(gap);
    }
    throw last ?? new Error('等待超时：' + label);
  };

  const portFile = await retry(() => {
    if (browserError) throw browserError;
    return readFileSync(join(profile, 'DevToolsActivePort'), 'utf8');
  }, 'DevToolsActivePort');
  const port = portFile.trim().split(/\s+/)[0];
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
  const tab = tabs.find(t => t.type === 'page');
  if (!tab) throw new Error('没有可用的标签页');
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket!.addEventListener('open', () => resolve(), { once: true });
    socket!.addEventListener('error', e => reject(e), { once: true });
  });

  let id = 0;
  const pending = new Map<number, (value: any) => void>();
  const errors: string[] = [];
  const confirmations: string[] = [];
  const badRequests: string[] = [];
  socket.addEventListener('message', event => {
    const data = JSON.parse(String((event as MessageEvent).data));
    if (data.id) { pending.get(data.id)?.(data); pending.delete(data.id); return; }
    if (data.method === 'Page.javascriptDialogOpening') {
      const message = String(data.params.message);
      confirmations.push(message);
      const accept = data.params.type === 'confirm' && message.includes('认输后对手赢得本局');
      void cdp('Page.handleJavaScriptDialog', { accept }).catch(() => { errors.push('原生确认框处理失败'); });
    }
    if (data.method === 'Runtime.exceptionThrown') {
      errors.push('页面脚本异常');
    }
    if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') {
      errors.push('页面控制台错误');
    }
    if (data.method === 'Network.responseReceived' && data.params.response.status >= 400
      && data.params.response.url.includes('/v1/')) {
      badRequests.push(`${data.params.response.status} ${new URL(data.params.response.url).pathname}`);
    }
  });
  async function cdp(method: string, params: Record<string, unknown> = {}) {
    const rid = ++id;
    const task = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(rid);
        reject(new Error('Chrome CDP 超时：' + method));
      }, 12_000);
      pending.set(rid, value => { clearTimeout(timeout); resolve(value); });
    });
    socket!.send(JSON.stringify({ id: rid, method, params }));
    const answer = await task;
    if (answer.error) throw new Error(answer.error.message);
    return answer.result;
  }
  const evalPage = async (expression: string) => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const shot = async (name: string) => {
    const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const path = join(SHOTS, name);
    writeFileSync(path, Buffer.from(data, 'base64'));
    console.log('   截图：', path);
  };
  async function clickText(label: string): Promise<string> {
    const point = await evalPage(`(() => {
      const text = ${JSON.stringify(label)};
      const el = [...document.querySelectorAll('button')].find(el => !el.disabled && el.textContent.trim() === text);
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest' });
      const { x, y, width, height } = el.getBoundingClientRect();
      const point = { x: x + width / 2, y: y + height / 2 };
      return el.contains(document.elementFromPoint(point.x, point.y)) ? point : null;
    })()`);
    if (!point) return 'no-button';
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    return 'clicked';
  }
  const diagnose = async (tag: string) => {
    const info = await evalPage(`({
      path: location.pathname,
      text: (document.body.innerText || '').replace(/\\n{2,}/g, '\\n').slice(0, 400),
      toast: [...document.querySelectorAll('.toast')].map(el => el.textContent.trim()),
      board: !!document.querySelector('.flight-board'),
      hasSeat: !!localStorage.getItem('parlor-play-v1')
    })`);
    console.log(`   [诊断 ${tag}]`, JSON.stringify(info, null, 1));
    if (badRequests.length) console.log('   [4xx/5xx]', badRequests.slice(-6).join(' | '));
    if (errors.length) console.log('   [页面报错]', errors.slice(-3).join(' | '));
    await shot(`live-aeroplane-diag-${tag}.png`);
  };

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Network.enable');
  await cdp('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });


  console.log(`\n── A1 家长钥匙直落牌桌 room=${ROOM} table=${tableId}`);
  await cdp('Page.navigate', { url: `${BASE}/play?room=${ROOM}&view=table&table=${tableId}#key=${key}` });
  try {
    await retry(() => evalPage("!!document.querySelector('button') && document.body.innerText.includes('飞行棋')"), '牌桌壳', 100);
  } catch { await diagnose('a1'); throw new Error('牌桌壳没渲染'); }

  captureBrowserSeat = () => retry(() => evalPage(`(() => {
    const seat = JSON.parse(localStorage.getItem('parlor-play-v1') || 'null');
    return seat?.room === ${JSON.stringify(ROOM)} && seat?.token && seat?.seatId
      ? { room: seat.room, token: seat.token, seatId: seat.seatId } : null;
  })()`), '本轮浏览器席位', 30);
  const browserSeat = await captureBrowserSeat();
  writeFileSync(join(scratch, 'browser-seat.json'), JSON.stringify(browserSeat), { mode: 0o600 });
  if (await room.captureSeat(browserSeat.token) !== browserSeat.seatId) throw new Error('浏览器席位与服务端不一致');
  browserRegistered = true;

  const waiting = await evalPage(`({
    text: (document.body.innerText || '').replace(/\\n{2,}/g, '\\n'),
    sit: [...document.querySelectorAll('button')].filter(el => el.textContent.trim() === '坐下').length,
    resign: document.querySelectorAll('.flight-resign').length,
    board: !!document.querySelector('.flight-board')
  })`);
  check('未入座时看得到「坐下」', waiting.sit === 1, String(waiting.sit));
  check('未入座时没有认输按钮', waiting.resign === 0, String(waiting.resign));
  check('等人时不出棋盘', waiting.board === false, String(waiting.board));
  check('牌桌写着等人', /等人|1 位/.test(waiting.text), waiting.text.split('\n').filter((line: string) => /等人|位/.test(line)).join(' / ').slice(0, 50));
  await shot('live-aeroplane-waiting.png');

  console.log('\n── A2 点「坐下」入座，再由真客户端开局');
  check('点了坐下', await clickText('坐下') === 'clicked');
  const seated = await retry(async () => {
    const state = await hostState();
    return (state.table?.seats?.length ?? 0) >= 2 ? state : null;
  }, '第二位入座', 80);
  check('桌上两人', seated.table.seats.length === 2, seated.table.seats.map((s: any) => s.name).join(' / '));

  const started = await host.call('parlor_table_start', {});
  check('开局被接受', !started.includes('"failed":true'), started.replace(/\s+/g, ' ').slice(0, 50));
  try {
    await retry(() => evalPage("!!document.querySelector('.flight-board')"), '棋盘渲染', 100);
    check('棋盘已渲染', true, '1440×1000');
  } catch {
    await diagnose('a2');
    check('棋盘已渲染', false, '没等到 .flight-board');
  }

  const layout = await evalPage(`({
    tracks: document.querySelectorAll('.flight-board .track').length,
    lanes: document.querySelectorAll('.flight-board .lane').length,
    hangars: document.querySelectorAll('.flight-board .hangar').length,
    parkings: document.querySelectorAll('.flight-board .parking').length,
    planes: document.querySelectorAll('.flight-board .plane').length,
    grid: getComputedStyle(document.querySelector('.flight-board')).gridTemplateColumns,
    roster: document.querySelector('.flight-roster')?.innerText || '',
    heading: document.querySelector('.flight-turn strong')?.textContent || '',
    overflow: document.documentElement.scrollWidth > window.innerWidth
  })`);
  check('赛道 52 格', layout.tracks === 52, String(layout.tracks));
  check('终点航道 24 格', layout.lanes === 24, String(layout.lanes));
  check('四个机库', layout.hangars === 4, String(layout.hangars));
  check('四个停机坪', layout.parkings === 4, String(layout.parkings));
  check('桌上八架飞机可见', layout.planes === 8, String(layout.planes));
  check('棋盘是 15 列网格', (layout.grid.match(/px/g) || []).length === 15, layout.grid.slice(0, 60));
  check('名单里有桌主', layout.roster.includes('QA飞行桌主'), layout.roster.replace(/\s+/g, ' ').slice(0, 60));
  check('页面无横向溢出', layout.overflow === false, String(layout.overflow));
  await shot('live-aeroplane-table.png');

  console.log('\n── A3 轮到我方：掷骰 → 认输');
  const waitForTurn = async () => {
    for (let i = 0; i < 90; i += 1) {
      if (await evalPage("!!document.querySelector('.flight-resign')")) return;
      const state = await hostState();
      if (state.table?.status !== 'playing') break;
      if (state.tablePrivate?.yourTurn) {
        const revision = state.table.revision;
        if (state.table.phase === 'await_move') {
          const plane = state.tablePrivate?.moves?.[0]?.plane;
          if (plane) await host.call('parlor_game_action', { action: 'move', params: { plane }, revision });
        } else {
          await host.call('parlor_game_action', { action: 'roll', params: {}, revision });
        }
      }
      await delay(350);
    }
    throw new Error('等不到我方回合');
  };
  await waitForTurn();
  check('轮到我方（认得认输按钮）', true);

  const beforeRoll = (await hostState()).table.revision;
  if (await clickText('掷骰') !== 'clicked') throw new Error('掷骰按钮不可点击');
  await retry(async () => (await hostState()).table?.revision > beforeRoll, '服务端接受掷骰', 30);
  const dice = await retry(async () => {
    const face = await evalPage("document.querySelector('.flight-dice')?.getAttribute('aria-label') || ''");
    return /掷出 [1-6] 点|上一掷 [1-6] 点/.test(face) ? face : null;
  }, '骰面渲染', 30);
  check('浏览器掷骰已被接受并显示点数', true, dice);
  const movesShown = await evalPage("document.querySelectorAll('.flight-move').length");
  console.log(`   可选机身按钮：${movesShown}`);

  await waitForTurn();
  check('点了认输', await clickText('认输') === 'clicked');
  const confirmation = await retry(() => confirmations[0], '认输原生确认框', 40);
  check('认输前弹确认并写明后果', confirmation.includes('认输后对手赢得本局'), confirmation);

  const ended = await retry(() => evalPage(`(() => {
    const turn = document.querySelector('.flight-turn')?.innerText || '';
    if (!/赢得本局/.test(turn)) return null;
    return {
      turn,
      resignedSeats: document.querySelectorAll('.flight-seats li.resigned').length,
      resignButtons: document.querySelectorAll('.flight-resign').length,
      board: !!document.querySelector('.flight-board')
    };
  })()`), '终局文案', 80);
  check('终局写着对手赢得本局', ended.turn.includes('QA飞行桌主 赢得本局'), ended.turn.replace(/\s+/g, ' ').slice(0, 60));
  check('终局说明其余玩家认输', ended.turn.includes('其余玩家已认输'), ended.turn.replace(/\s+/g, ' ').slice(0, 60));
  check('名单里认输席位被标出', ended.resignedSeats === 1, String(ended.resignedSeats));
  check('终局收起认输按钮', ended.resignButtons === 0, String(ended.resignButtons));
  check('终局棋盘仍在', ended.board === true, String(ended.board));
  await shot('live-aeroplane-ended.png');

  const after = await hostState();
  check('服务端 status=ended', after.table?.status === 'ended', String(after.table?.status));
  check('服务端 endReason=resign', after.table?.endReason === 'resign', String(after.table?.endReason));
  const hostSeat = after.table?.seats?.find((seat: any) => seat.name === 'QA飞行桌主');
  check('服务端胜者是桌主', after.table?.winners?.length === 1 && after.table.winners[0] === hostSeat?.id,
    `${after.table?.winners?.join(',')} vs ${hostSeat?.id}`);

  console.log('\n── B1 对外首页点开飞行棋规则');
  await cdp('Page.navigate', { url: `${BASE}/` });
  await retry(() => evalPage("document.documentElement.classList.contains('ef-rules') && document.querySelectorAll('.rule-card').length === 8"), '八格玩法已完成初始化', 80);
  const focused = await evalPage(`(() => {
    const card = document.querySelector('.rule-card[data-rule="aeroplane"]');
    if (!card) return false;
    card.focus();
    return document.activeElement === card;
  })()`);
  if (!focused) throw new Error('飞行棋规则卡无法获取键盘焦点');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await retry(() => evalPage("!!document.querySelector('#rule-dialog[open]')"), '规则弹层', 60);
  const dialogText = await evalPage("document.querySelector('#rule-dialog')?.innerText || ''");
  check('规则里写了认输', dialogText.includes('认输') && dialogText.includes('只剩一人'), dialogText.replace(/\s+/g, ' ').slice(0, 90));
  await shot('live-aeroplane-rules.png');

  check('无脚本异常', errors.length === 0, errors.slice(0, 2).join(' | '));

} catch (error) {
  console.error('QA 网页飞行棋中断：', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  try {
    if (room && captureBrowserSeat && !browserRegistered) {
      const seat = await captureBrowserSeat().catch(() => null);
      if (seat) {
        writeFileSync(join(scratch, 'browser-seat.json'), JSON.stringify(seat), { mode: 0o600 });
        if (await room.captureSeat(seat.token) !== seat.seatId) throw new Error('浏览器席位与服务端不一致');
      }
    }
    if (room) {
      console.log('QA 清理计划', await room.plan());
      await room.cleanup();
    }
    if (bootstrap) await leaveQaSeat(BASE, bootstrap.token, bootstrap.seat.id);
    for (const client of clients) await leaveQaSeat(BASE, client.token());
    check('本轮临时客厅和席位已清理', true);
  } catch (error) {
    process.exitCode = 1;
    check('本轮临时客厅和席位已清理', false, error instanceof Error ? error.message : String(error));
    console.error('请保留凭据目录', scratch);
  } finally {
    await Promise.allSettled(clients.map(client => client.stop()));
    socket?.close();
    if (chrome && chrome.exitCode === null && chrome.pid) {
      const ended = new Promise(resolve => chrome!.once('exit', resolve));
      chrome.kill();
      await Promise.race([ended, delay(2000)]);
    }
  }
  const failed = rows.filter(([, ok]) => !ok);
  if (rows.at(-1)?.[1] && clients.length === 2) rmSync(scratch, { recursive: true });
  else if (clients.length < 2) console.error('临时客户端启动不完整，请保留凭据目录', scratch);
  console.log(`合计 ${rows.length} 项：${rows.length - failed.length} 通过 / ${failed.length} 失败`);
  if (failed.length) process.exitCode = 1;
}
