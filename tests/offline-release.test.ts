import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WorldServer } from '../src/room/world-server.ts';

let server: WorldServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const HOUR = 3_600_000;

const makeServer = async (): Promise<string> => {
  server = new WorldServer({
    dbFile: ':memory:', port: 0, inviteCode: 'inv', allowGuestJoin: true, offlineReleaseHours: 1,
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

describe('真人席位离线释放', () => {
  it('离线超过阈值的释放；最近的不动；Coo 的 pet 席位不动', async () => {
    const url = await makeServer();
    const oldHuman = await joinHuman(url, '旧人');
    const recent = await joinHuman(url, '新人');
    const now = Date.now();
    server!.dbHandle.prepare('UPDATE room_seats SET last_seen_at = ? WHERE room_id = ? AND id = ?')
      .run(now - 2 * HOUR, 'hall', oldHuman.seat.id);

    server!.dbHandle.prepare('INSERT INTO coos(id, kind, display_name, created_at) VALUES (?, ?, ?, ?)')
      .run('coo-aaaaaaaa', 'pet', '老 Coo', now);
    server!.dbHandle.prepare(
      `INSERT INTO room_seats(
         room_id, id, coo_id, kind, name, tier, token_hash, joined_at, last_seen_at, visible_from_seq
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run('hall', 's-pet-old', 'coo-aaaaaaaa', 'pet', '老 Coo', 'digest', 'token-pet-old',
      now - 3 * HOUR, now - 3 * HOUR);

    const released = server!.releaseOfflineSeats(now);
    expect(released).toBe(1);

    const releasedAt = (id: string) => (
      server!.dbHandle.prepare('SELECT released_at FROM room_seats WHERE room_id = ? AND id = ?')
        .get('hall', id) as { released_at: number | null }
    ).released_at;
    expect(releasedAt(oldHuman.seat.id)).not.toBeNull();
    expect(releasedAt(recent.seat.id)).toBeNull();
    expect(releasedAt('s-pet-old')).toBeNull();

    const event = server!.dbHandle.prepare(
      "SELECT text, data_json FROM events WHERE room_id = 'hall' AND type = 'parlor.left' ORDER BY seq DESC LIMIT 1",
    ).get() as { text: string; data_json: string };
    expect(event.text).toContain('长时间未上线');
    expect(event.data_json).toContain('offline');
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
