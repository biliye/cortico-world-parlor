import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WorldServer } from '../src/room/world-server.ts';

let server: WorldServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const HOUR = 3_600_000;

const makeServer = async (hours: { human?: number; coo?: number } = {}): Promise<string> => {
  server = new WorldServer({
    dbFile: ':memory:', port: 0, inviteCode: 'inv', allowGuestJoin: true,
    offlineReleaseHours: hours.human ?? 1,
    cooOfflineReleaseHours: hours.coo ?? 1,
  });
  return (await server.listen()).url;
};

const joinHuman = async (url: string, name: string) => {
  const response = await fetch(url + '/v1/player/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-parlor-invite': 'inv' },
    body: JSON.stringify({ name, room: 'hall' }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ token: string; seat: { id: string; name: string } }>;
};

/** 直接塞一个 pet 席位：这条只管离线清理，不用走 Coo 身份头。 */
const seedPetSeat = (id: string, cooId: string, name: string, lastSeenAt: number): void => {
  server!.dbHandle.prepare('INSERT INTO coos(id, kind, display_name, created_at) VALUES (?, ?, ?, ?)')
    .run(cooId, 'pet', name, lastSeenAt);
  server!.dbHandle.prepare(
    `INSERT INTO room_seats(
       room_id, id, coo_id, kind, name, tier, token_hash, joined_at, last_seen_at, visible_from_seq
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run('hall', id, cooId, 'pet', name, 'digest', `token-${id}`, lastSeenAt, lastSeenAt);
};

const releasedAt = (id: string): number | null => (
  server!.dbHandle.prepare('SELECT released_at FROM room_seats WHERE room_id = ? AND id = ?')
    .get('hall', id) as { released_at: number | null }
).released_at;

describe('席位离线释放', () => {
  it('真人超过阈值释放；最近的不动；Coo 席位按自己的阈值等', async () => {
    await makeServer({ human: 1, coo: 6 });
    const url = server!.url;
    const oldHuman = await joinHuman(url, '旧人');
    const recent = await joinHuman(url, '新人');
    const now = Date.now();
    server!.dbHandle.prepare('UPDATE room_seats SET last_seen_at = ? WHERE room_id = ? AND id = ?')
      .run(now - 2 * HOUR, 'hall', oldHuman.seat.id);
    seedPetSeat('s-pet-recent', 'coo-aaaaaaaa', '刚下线的 Coo', now - 2 * HOUR);

    expect(server!.releaseOfflineSeats(now)).toBe(1);
    expect(releasedAt(oldHuman.seat.id)).not.toBeNull();
    expect(releasedAt(recent.seat.id)).toBeNull();
    // 2 小时没上线：对真人是超了，对 Coo 还没到 6 小时。
    expect(releasedAt('s-pet-recent')).toBeNull();

    const event = server!.dbHandle.prepare(
      "SELECT text, data_json FROM events WHERE room_id = 'hall' AND type = 'parlor.left' ORDER BY seq DESC LIMIT 1",
    ).get() as { text: string; data_json: string };
    expect(event.text).toContain('长时间未上线');
    expect(event.data_json).toContain('offline');
  });

  it('Coo 席位离线超过自己的阈值也释放', async () => {
    await makeServer({ human: 1, coo: 6 });
    const now = Date.now();
    seedPetSeat('s-pet-old', 'coo-aaaaaaaa', '老 Coo', now - 7 * HOUR);

    expect(server!.releaseOfflineSeats(now)).toBe(1);
    expect(releasedAt('s-pet-old')).not.toBeNull();
    const event = server!.dbHandle.prepare(
      "SELECT data_json FROM events WHERE room_id = 'hall' AND type = 'parlor.left' ORDER BY seq DESC LIMIT 1",
    ).get() as { data_json: string };
    expect(event.data_json).toContain('"reason":"offline"');
  });

  it('Coo 席位阈值设 0 就完全不释放', async () => {
    await makeServer({ human: 1, coo: 0 });
    const now = Date.now();
    seedPetSeat('s-pet-old', 'coo-aaaaaaaa', '老 Coo', now - 30 * HOUR);

    expect(server!.releaseOfflineSeats(now)).toBe(0);
    expect(releasedAt('s-pet-old')).toBeNull();
  });

  it('还有 SSE 连着的席位不释放', async () => {
    const url = await makeServer();
    const human = await joinHuman(url, '在线的人');
    const now = Date.now();
    server!.dbHandle.prepare('UPDATE room_seats SET last_seen_at = ? WHERE room_id = ? AND id = ?')
      .run(now - 2 * HOUR, 'hall', human.seat.id);

    const stream = http.get(
      `${url}/v1/rooms/hall/stream?token=${encodeURIComponent(human.token)}&since=0`,
    );
    await new Promise<void>((resolve, reject) => {
      stream.on('response', (response) => { response.resume(); resolve(); });
      stream.on('error', reject);
    });

    expect(server!.releaseOfflineSeats(now)).toBe(0);
    stream.destroy();
  });
});
