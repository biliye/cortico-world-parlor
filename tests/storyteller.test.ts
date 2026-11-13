import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { LocalHistory } from '../src/local-history.ts';
import { ParlorClient } from '../src/room/client.ts';
import { CooAccountDb } from '../src/room/coo-account-db.ts';
import { createRoom } from '../src/room/room-seat-db.ts';
import { StoryDb } from '../src/room/story-db.ts';
import { STORY_PRESENCE_MS, STORY_RETENTION_MS, STORY_TALK_MS, STORY_TOTAL_MS } from '../src/room/story-protocol.ts';
import { WorldServer } from '../src/room/world-server.ts';
import { pgServerStorage } from './helpers/pg.ts';
import { closeTestDb, openTestDb } from './helpers/test-db.ts';

it('说书厅在场人数按身份和访客去重，停止轮询后到期', async () => {
  let now = Date.now();
  const server = await WorldServer.create({
    ...(await pgServerStorage(':memory:')), inviteCode: 'story-invite', allowGuestJoin: true, now: () => now,
  });
  try {
    await server.listen();
    const url = `${server.url}/v1/story/live`;
    const visitor = '00000000-0000-4000-8000-000000000001';
    const watch = (id: string) => fetch(`${url}?visitor=${id}`).then(response => response.json());
    expect(await fetch(url).then(response => response.json())).toMatchObject({ present: 0 });
    expect((await fetch(`${url}?visitor=invalid`)).status).toBe(400);
    expect(await watch(visitor)).toMatchObject({ present: 1, round: null });
    expect(await watch(visitor)).toMatchObject({ present: 1 });

    const client = new ParlorClient(server.url, { cooId: 'coo-presence', cooSecret: 'test-story-presence-12345678' });
    const { token } = await client.join('story-invite', { name: '阿岚', kind: 'human' }, 'lobby');
    const joined = await fetch(`${url}?visitor=${visitor}`, { headers: { authorization: `Bearer ${token}` } });
    expect(await joined.json()).toMatchObject({ present: 1 });
    expect(await watch(visitor)).toMatchObject({ present: 2 });
    expect(await client.storyLive(token)).toMatchObject({ present: 2 });
    expect(await client.storyLive(token)).toMatchObject({ present: 2 });
    expect(await client.storyAction(token, { action: 'start' })).toMatchObject({ present: 2, round: { speaking: true } });

    now += STORY_PRESENCE_MS - 1;
    const during = await watch(visitor);
    expect(during).toMatchObject({ present: 2, round: { speaking: false } });
    expect(during).not.toHaveProperty('chat');
    now++;
    expect(await fetch(url).then(response => response.json())).toMatchObject({ present: 1 });
    now += STORY_PRESENCE_MS;
    expect(await fetch(url).then(response => response.json())).toMatchObject({ present: 0 });
  } finally { await server.close(); }
});

it('真实网关限制台席、分批投递和投喂，往期与家长页按各自权限读取', async () => {
  let now = Date.now();
  const server = await WorldServer.create({
    ...(await pgServerStorage(':memory:')), inviteCode: 'story-invite', allowGuestJoin: true, now: () => now,
  });
  try {
    await server.listen();
    const guestLive = await fetch(server.url + '/v1/story/live');
    expect(guestLive.status).toBe(200);
    expect(guestLive.headers.get('cache-control')).toBe('no-store');
    expect((await fetch(server.url + '/v1/story/live', {
      headers: { authorization: 'Bearer invalid-token' },
    })).status).toBe(401);
    expect((await fetch(server.url + '/v1/story/live?after=-1')).status).toBe(400);
    expect((await fetch(server.url + '/v1/story/missing')).status).toBe(404);
    expect((await fetch(server.url + '/v1/story/missing', { method: 'POST' })).status).toBe(405);
    expect((await fetch(server.url + '/v1/me/story/archive')).status).toBe(401);
    expect((await fetch(server.url + '/v1/parent/story')).status).toBe(401);
    const enter = async (name: string, kind: 'pet' | 'human', suffix: string) => {
      const client = new ParlorClient(server.url, { cooId: `coo-story-${suffix}`, cooSecret: `test-story-secret-${suffix}-12345678` });
      const joined = await client.join('story-invite', { name, kind }, 'lobby');
      return { client, ...joined, act: (body: Record<string, unknown>) => client.storyAction(joined.token, body) };
    };
    const coo = await enter('小满', 'pet', 'speaker');
    const listener = await enter('阿岚', 'human', 'listener');
    const outsider = await enter('南枝', 'pet', 'outsider');
    const chat = { action: 'chat', text: '等人开讲', requestId: 'chat-1' };
    expect((await listener.act(chat)).chat).toMatchObject({ round: null, messages: [{ text: chat.text }] });
    expect((await listener.act(chat)).chat?.messages).toHaveLength(1);
    expect((await fetch(server.url + '/v1/story/chat')).status).toBe(401);
    const simultaneous = await Promise.allSettled([
      coo.act({ action: 'start', title: '和家长散步' }), outsider.act({ action: 'start', title: '另一场' }),
    ]);
    expect(simultaneous.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const speaker = simultaneous[0].status === 'fulfilled' ? coo : outsider;
    const queued = speaker === coo ? outsider : coo;
    const live = await speaker.client.storyLive(speaker.token);
    const id = live.round!.id;
    expect(live.round).toMatchObject({ notesAt: now + STORY_TALK_MS, endsAt: now + STORY_TOTAL_MS, speaking: true });
    expect(live.chat).toBeUndefined();
    await expect(listener.act({ ...chat, requestId: 'chat-live' })).rejects.toMatchObject({ status: 409 });
    await expect(listener.client.storyDiscussion(listener.token)).rejects.toMatchObject({ status: 409 });
    const hint = async ({ client, token }: typeof coo) => (await client.inbox(token, { topics: ['story'], afterPublish: 0, afterId: '' })).story;
    expect(await hint(queued)).toBeNull();
    await queued.act({ action: 'queue' });
    await expect(queued.act({ action: 'start' })).rejects.toMatchObject({ status: 409 });
    await listener.act({ action: 'listen', round: id });
    const part = { action: 'speak', round: id, text: '我们走到桥边，看见水里有月亮。', requestId: 'part-1' };
    await speaker.act(part);
    expect(await hint(queued)).toMatchObject({ id, speaker: live.round!.speaker, title: live.round!.title });
    expect(await hint(speaker)).toBeNull();
    expect(await hint(listener)).toBeNull();
    await speaker.act(part);
    await expect(speaker.act({ ...part, text: '另一段' })).rejects.toMatchObject({ status: 409 });
    await expect(listener.act(part)).rejects.toMatchObject({ status: 403 });
    await listener.act({ action: 'note', round: id, text: '原来的纸条' });
    const peek = { action: 'peek_notes', round: id };
    await expect(listener.act(peek)).rejects.toMatchObject({ status: 403 });
    expect((await speaker.act(peek)).preview?.notes).toEqual([{ name: '阿岚', text: '原来的纸条' }]);
    expect((await speaker.client.storyLive(speaker.token)).preview).toBeUndefined();
    await listener.act({ action: 'note', round: id, text: '桥边有灯吗？' });
    expect((await speaker.act(peek)).preview?.notes).toEqual([{ name: '阿岚', text: '桥边有灯吗？' }]);
    await speaker.act({ ...part, text: '桥边确实有灯。', requestId: 'reply-early' });
    await listener.act({ action: 'snack', round: id, item: 'guihuagao' });
    await listener.act({ action: 'snack', round: id, item: 'guihuagao' });
    await expect(listener.act({ action: 'snack', round: id, item: 'moli' })).rejects.toMatchObject({ status: 400 });
    expect((await speaker.client.gifts(speaker.token, true, 'lobby')).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'guihuagao', count: 1 })]),
    );
    now = live.round!.notesAt - 1;
    expect((await speaker.client.storyNotice(speaker.token)).round?.batch).toBeNull();
    expect((await listener.client.storyLive(listener.token)).round).toMatchObject({ note: { status: 'waiting' }, snacks: 1 });
    now++;
    const close = await speaker.client.storyNotice(speaker.token);
    expect(close.round?.batch).toEqual([{ name: '阿岚', text: '桥边有灯吗？' }]);
    expect((await listener.client.storyLive(listener.token)).round).toMatchObject({ batch: null, note: { status: 'delivered' } });
    expect((await queued.client.storyLive(queued.token)).round).toMatchObject({ batch: null, note: null });
    const guest = await fetch(server.url + '/v1/story/live').then(response => response.json());
    expect(JSON.stringify(guest)).not.toContain('桥边有灯吗？');
    await expect(listener.act({ action: 'note', round: id, text: '来迟了' })).rejects.toMatchObject({ status: 409 });
    await speaker.act({ ...part, text: '有一盏橘黄色的灯。', requestId: 'part-2' });
    now = live.round!.endsAt;
    expect(await hint(queued)).toBeNull();
    expect((await listener.client.storyLive(listener.token)).chat?.round?.id).toBe(id);
    await expect(listener.act({ ...chat, requestId: 'wrong-round' })).rejects.toMatchObject({ status: 409 });
    for (let i = 1; i <= 21; i++) {
      await listener.act({ action: 'chat', round: id, text: `散场讨论 ${i}`, requestId: `discussion-${i}` });
    }
    const next = await queued.act({ action: 'start', title: '下一场' });
    expect(next.round?.id).not.toBe(id);
    const discussion = await speaker.client.storyDiscussion(speaker.token, id);
    expect(discussion.messages).toHaveLength(20);
    expect(discussion.messages.at(-1)?.text).toBe('散场讨论 21');
    expect((await speaker.client.storyDiscussion(speaker.token, id, discussion.before!)).messages)
      .toMatchObject([{ text: '散场讨论 1' }]);
    await expect(listener.act({ action: 'snack', round: id, item: 'guihuagao' })).rejects.toMatchObject({ status: 409 });
    const transcript = await listener.client.storyArchive(listener.token, id, true);
    expect(transcript.parts.map(part => part.text)).toEqual([part.text, '桥边确实有灯。', '有一盏橘黄色的灯。']);
    expect(transcript.endedAt).toBe(now);
    expect((await listener.client.storyHistory(listener.token, undefined, true, true)).rounds).toHaveLength(1);
    await expect(queued.client.storyArchive(queued.token, id, true)).rejects.toMatchObject({ status: 404 });
    await queued.act({ ...part, round: next.round!.id });
    const finished = await queued.act({ action: 'finish', round: next.round!.id });
    expect(finished.chat?.round?.id).toBe(next.round!.id);
    await expect(listener.act({ ...chat, round: id, requestId: 'stale-chat' })).rejects.toMatchObject({ status: 409 });
    const parentCookie = async (key: string) => {
      const response = await fetch(server.url + '/v1/parent/session', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }),
      });
      expect(response.status).toBe(200);
      return response.headers.get('set-cookie')!.split(';')[0];
    };
    const parentUrl = `${server.url}/v1/parent/story?id=${id}`;
    expect((await fetch(parentUrl, { headers: { cookie: await parentCookie(speaker.ownerKey!) } })).status).toBe(200);
    expect((await fetch(parentUrl, { headers: { cookie: await parentCookie(queued.ownerKey!) } })).status).toBe(404);
    const localDir = mkdtempSync(join(tmpdir(), 'parlor-story-'));
    const local = new LocalHistory(localDir, server.url, 'listener');
    try {
      local.saveStory(transcript);
      local.saveStory(transcript);
      now += STORY_RETENTION_MS;
      await expect(listener.client.storyArchive(listener.token, id)).rejects.toMatchObject({ status: 404 });
      await expect(speaker.client.storyDiscussion(speaker.token, id)).rejects.toMatchObject({ status: 404 });
      expect(local.storyList().rounds).toHaveLength(1);
      local.close();
      expect(local.story(id)).toEqual(transcript);
      expect(local.query().messages).toEqual([]);
    } finally {
      local.close();
      rmSync(localDir, { recursive: true, force: true });
    }
  } finally { await server.close(); }
});

it('同一场的抽签结果固定，未确认的排队席会顺延，过期场次级联清理', async () => {
  const db = await openTestDb();
  try {
    const accounts = new CooAccountDb(db);
    const people = Array.from({ length: 12 }, (_, i) => ({ id: `coo-story-test-${i}`, name: `茶客 ${i}` }));
    for (const actor of people) {
      expect(await accounts.registerCoo(actor.id, `test-story-secret-${actor.id}-12345678`, 'pet', actor.name)).toBe('ok');
    }
    await createRoom(db, { id: 'story-ledger', ownerCooId: people[0].id, name: '账本归属厅' }, 1);
    let now = 100;
    const story = new StoryDb(db, () => now, () => 'story-ledger');
    const [speaker, ...listeners] = people;
    const active = (await story.action(speaker, { action: 'start' })).round!;
    for (const actor of listeners) await story.action(actor, { action: 'note', round: active.id, text: actor.name });
    await story.action(speaker, { action: 'speak', round: active.id, text: '正文', requestId: 'one' });
    await story.action(listeners[0], { action: 'queue' });
    now++;
    await story.action(listeners[1], { action: 'queue' });
    now = active.notesAt;
    const batch = (await story.notice(speaker.id)).round?.batch;
    expect(batch).toHaveLength(10);
    expect((await story.state(speaker.id)).round?.batch).toEqual(batch);
    now = active.endsAt;
    await story.tick();
    expect((await story.state(listeners[0].id)).queue.readyUntil).toBe(now + 60_000);
    now += 60_000;
    expect((await story.state(listeners[0].id)).queue.readyUntil).toBeNull();
    expect((await story.notice(listeners[0].id)).readyUntil).toBeNull();
    await story.tick();
    expect((await story.state(listeners[0].id)).queue.position).toBeNull();
    expect((await story.state(listeners[1].id)).queue.readyUntil).toBe(now + 60_000);
    await story.prune(active.endsAt + STORY_RETENTION_MS);
    for (const table of ['story_rounds', 'story_parts', 'story_notes', 'story_attendance']) {
      expect(await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  } finally { await closeTestDb(db); }
});
