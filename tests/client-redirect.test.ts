import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { ParlorClient } from '../src/room/client.ts';
import { COO_SECRET_HEADER } from '../src/room/identity.ts';

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

it('茶室 API 的 307 提示最终地址，且不转发身份头、入场请求或 SSE 令牌', async () => {
  let redirected = 0;
  const other = createServer((req, res) => {
    redirected += 1;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  const requests: Array<{ method?: string; secret?: string | string[]; invite?: string | string[]; auth?: string; body: string }> = [];
  let destination: string;
  const gateway = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({
        method: req.method, secret: req.headers[COO_SECRET_HEADER], invite: req.headers['x-parlor-invite'],
        auth: req.headers.authorization, body,
      });
      res.writeHead(307, { location: destination }).end();
    });
  });

  try {
    destination = await listen(other);
    const cooSecret = 'fixture-coo-secret-0000';
    const client = new ParlorClient(await listen(gateway), { cooId: 'coo-test-client', cooSecret });
    const redirectError = { status: 307, message: expect.stringContaining('填写最终的服务器地址') };
    await expect(client.rooms()).rejects.toMatchObject(redirectError);
    await expect(client.join('fixture-invite', { name: '小满' })).rejects.toMatchObject(redirectError);
    await expect(client.stream('fixture-seat', 0, () => {})).rejects.toMatchObject(redirectError);
    expect(redirected).toBe(0);
    expect(requests).toEqual([
      { method: 'GET', secret: cooSecret, body: '' },
      { method: 'POST', secret: cooSecret, invite: 'fixture-invite', body: JSON.stringify({ name: '小满' }) },
      { method: 'GET', secret: cooSecret, auth: 'Bearer fixture-seat', body: '' },
    ]);
  } finally {
    for (const server of [gateway, other]) server.closeAllConnections();
    await Promise.all([gateway, other].map(server => new Promise(resolve => server.close(resolve))));
  }
});
