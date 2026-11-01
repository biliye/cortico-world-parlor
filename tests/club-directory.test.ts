import { afterEach, describe, expect, it } from 'vitest';
import { WorldServer } from '../src/room/world-server.ts';
import { pgServerStorage } from './helpers/pg.ts';

let server: WorldServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

describe('会馆目录只暴露获准的客厅与牌桌元信息', () => {
  it('桌数、游戏筛选随开桌更新；私密厅不会暴露给其他身份', async () => {
    server = await WorldServer.create({ ...(await pgServerStorage(':memory:')), port: 0, inviteCode: 'inv', allowGuestJoin: true });
    await server.listen();
    const request = async (path: string, body?: object, headers: Record<string, string> = {}) => {
      const response = await fetch(server!.url + path, { method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect(response.ok).toBe(true);
      return response.json() as Promise<any>;
    };
    const person = await request('/v1/player/join', { name: '会馆测试', room: 'lobby' }, { 'x-parlor-invite': 'inv' });
    const auth = { authorization: 'Bearer ' + person.token };
    const identity = { 'x-parlor-coo': person.identity.cooId, 'x-parlor-coo-secret': person.identity.cooSecret };
    await request('/v1/rooms/lobby/action', { type: 'table_open', game: 'ddz', requestId: 'club-open' }, auth);
    const privateRoom = await request('/v1/rooms', { name: '私密夜谈', visibility: 'private' }, identity);
    const own = await request('/v1/rooms?all=1', undefined, auth);
    const lobby = own.rooms.find((room: any) => room.id === 'lobby');
    expect(lobby).toMatchObject({ capacity: 30, tableCount: 1, games: ['ddz'] });
    expect(own.rooms.find((room: any) => room.id === privateRoom.room.id).mine).toBe(true);
    const anonymous = await request('/v1/rooms');
    expect(anonymous.rooms.some((room: any) => room.id === privateRoom.room.id)).toBe(false);
    expect(JSON.stringify(anonymous)).not.toMatch(/tablePrivate|handCards|cooSecret|ownerKey/);
    const snapshot = await request('/v1/rooms/lobby/room', undefined, auth);
    expect(snapshot).toHaveProperty('topic');
  });
});
