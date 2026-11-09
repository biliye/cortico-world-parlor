import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldServer } from '../src/room/world-server.ts';
import { ParlorClient } from '../src/room/client.ts';
import { pgServerStorage } from './helpers/pg.ts';

let server: WorldServer;
let dir: string;
afterEach(async () => { await server?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
const operatorKey = 'local-test-operator-key';
const request = async (path: string, token = '', body?: unknown) => {
  const response = await fetch(`${server.url}/v1/support/${path}`, {
    method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() as { feedback: any; announcements: any; error?: string } };
};
const setup = async (key: string | undefined = operatorKey) => {
  dir = mkdtempSync(join(tmpdir(), 'parlor-support-'));
  const storage = await pgServerStorage(join(dir, 'support.db'));
  server = await WorldServer.create({ ...storage, operatorKey: key, port: 0, inviteCode: 'inv', allowGuestJoin: true });
  await server.listen();
  const a = new ParlorClient(server.url, { cooId: 'coo-aaaaaaaa', cooSecret: 'support-secret-aaaaaaaa' });
  const b = new ParlorClient(server.url, { cooId: 'coo-bbbbbbbb', cooSecret: 'support-secret-bbbbbbbb' });
  return { a: await a.join('inv', { name: '阿岚' }), b: await b.join('inv', { name: '小满' }), storage };
};

describe('私密反馈与运营广播', () => {
  it('提交者看到自己反馈，旁人和房主钥匙不能读运营收件箱；正文不会进入公共历史', async () => {
    const { a, b } = await setup();
    const submitted = await request('feedback', a.token, { text: '断线很久', requestId: 'feedback-1' });
    expect(submitted.status).toBe(200);
    expect((await request('feedback', a.token)).body.feedback).toHaveLength(1);
    expect((await request('feedback', b.token)).body.feedback).toHaveLength(0);
    expect((await request('operator/feedback', b.token)).status).toBe(403);
    expect((await request('operator/feedback', a.ownerKey)).status).toBe(403);
    expect((await request('operator/feedback', operatorKey)).body.feedback).toHaveLength(1);
    const history = await new ParlorClient(server.url).history(b.token, 0);
    expect(history.events.some(event => event.text.includes('断线很久'))).toBe(false);
    expect((await request('feedback')).status).toBe(401);
  });

  it('网页真人可以提交；运营者回复、关闭；服务重启后回复和公告仍在', async () => {
    const { storage } = await setup();
    const response = await fetch(`${server.url}/v1/player/join`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invite: 'inv', name: '真人', room: 'lobby' }) });
    const human = await response.json() as { token: string }; expect(response.status).toBe(200);
    const item = await request('feedback', human.token, { text: '<script>页面有问题</script>', requestId: 'human-1' });
    expect(item.status).toBe(200);
    expect((await request('operator/reply', operatorKey, { id: item.body.feedback.id, text: '已经记录，待修复', status: 'closed' })).status).toBe(200);
    expect((await request('operator/announcements', operatorKey, { text: '明晚维护', requestId: 'notice-1' })).status).toBe(200);
    await server.close();
    server = await WorldServer.create({ ...storage, operatorKey, port: 0, inviteCode: 'inv' }); await server.listen();
    const mine = await request('feedback', human.token);
    expect(mine.body.feedback[0]).toMatchObject({ text: '<script>页面有问题</script>', reply: '已经记录，待修复', status: 'closed' });
    expect((await request('announcements', human.token)).body.announcements[0].text).toBe('明晚维护');
    expect((await fetch(`${server.url}/support`)).status).toBe(200);
    for (const asset of ['support.js', 'support.css']) expect((await fetch(`${server.url}/play/assets/${asset}`)).status).toBe(200);
  });

  it('反馈和广播按请求号去重；限制正文与频率；普通用户不能广播', async () => {
    const { a } = await setup();
    const body = { text: '想多等一会儿', requestId: 'repeat-1' };
    const first = await request('feedback', a.token, body);
    expect((await request('feedback', a.token, body)).body.feedback.id).toBe(first.body.feedback.id);
    expect((await request('feedback', a.token, { ...body, text: '不同内容' })).status).toBe(409);
    expect((await request('feedback', a.token, { text: 'x'.repeat(2001), requestId: 'long' })).status).toBe(400);
    for (let index = 2; index <= 5; index++) expect((await request('feedback', a.token, { text: '问题', requestId: `limit-${index}` })).status).toBe(200);
    expect((await request('feedback', a.token, { text: '第六条', requestId: 'limit-6' })).status).toBe(409);
    expect((await request('operator/announcements', a.token, { text: '冒充公告', requestId: 'fake' })).status).toBe(403);
    const news = { text: '更新已完成', requestId: 'news-1' };
    await request('operator/announcements', operatorKey, news); await request('operator/announcements', operatorKey, news);
    expect((await request('announcements', a.token)).body.announcements).toHaveLength(1);
  });

  it('没有配置独立钥匙则运营入口关闭；并发反馈不能绕过每小时上限', async () => {
    const { a } = await setup('');
    expect((await request('operator/feedback', operatorKey)).status).toBe(503);
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => request('feedback', a.token, { text: '问题', requestId: `parallel-${index}` })));
    expect(results.filter(result => result.status === 200)).toHaveLength(5);
    expect(results.filter(result => result.status === 409)).toHaveLength(3);
  });

});
