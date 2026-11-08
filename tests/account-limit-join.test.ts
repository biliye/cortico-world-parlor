import { afterEach, describe, expect, it } from 'vitest';
import { pgServerStorage } from './helpers/pg.ts';
import { WorldServer } from '../src/room/world-server.ts';

/**
 * 2026-11-08 线上事故的回归：家长账户表撞到上限后，新 Coo 全部进不来。
 *
 * 老顺序是「先落座、后建账户」：建账户抛错时席位已经写库，客户端拿不到 token，
 * World 退避重连再走一遍，于是每失败一次就多一排僵尸席位。这里把三件事钉住：
 * 满了回 503 而不是 500、报错是人话、失败不留席位。
 */

const A = 'coo-aaaaaaaa';
const B = 'coo-bbbbbbbb';
const secretFor = (cooId: string): string => `secret-${cooId}-0123456789`;

let server: WorldServer | undefined;

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
});

const start = async (accountLimit: number): Promise<WorldServer> => {
  server = await WorldServer.create({
    ...(await pgServerStorage(':memory:')),
    port: 0,
    inviteCode: 'inv',
    accountLimit,
  });
  await server.listen();
  return server;
};

const join = async (app: WorldServer, cooId: string, name: string) => {
  const response = await fetch(`${app.url}/v1/join`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-parlor-coo': cooId,
      'x-parlor-coo-secret': secretFor(cooId),
      'x-parlor-invite': 'inv',
    },
    body: JSON.stringify({ name }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const seatsOf = async (app: WorldServer, cooId: string): Promise<number> => {
  const row = await app.dbHandle.prepare('SELECT COUNT(*) AS n FROM room_seats WHERE coo_id = ?').get(cooId) as { n: number };
  return Number(row.n);
};

describe('家长账户满了：拒绝但不要伤人', () => {
  it('回 503 + 人话，且失败那次不留下任何席位', async () => {
    const app = await start(1);

    const first = await join(app, A, '阿岚');
    expect(first.status).toBe(200);
    expect(await seatsOf(app, A)).toBe(1);

    // 账户名取的是席位名：先建账户也没丢「<孩子名>的家长」这个默认名。
    const account = await app.dbHandle.prepare('SELECT display_name FROM accounts WHERE coo_id = ?')
      .get(A) as { display_name: string };
    expect(account.display_name).toBe('阿岚的家长');

    // 名额已满：第二个身份进不来，但要说清楚是容量问题，不是「服务端出错」。
    const second = await join(app, B, '小满');
    expect(second.status).toBe(503);
    const message = String(second.body.error);
    expect(message).toContain('家长账户已满');
    expect(message).not.toContain('表满');

    // 关键回归：失败这一次没有偷偷坐进大厅（老实现会留一个没人认领的席位）。
    expect(await seatsOf(app, B)).toBe(0);
    const accountsOfB = await app.dbHandle.prepare('SELECT COUNT(*) AS n FROM accounts WHERE coo_id = ?')
      .get(B) as { n: number };
    expect(Number(accountsOfB.n)).toBe(0);
  });

  it('名额没满时照常入座，席位名与账户名都对得上', async () => {
    const app = await start(2);

    const first = await join(app, A, '阿岚');
    const second = await join(app, B, '小满');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await seatsOf(app, A)).toBe(1);
    expect(await seatsOf(app, B)).toBe(1);
  });
});
