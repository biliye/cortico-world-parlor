import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { ParlorClient } from '../src/room/client.ts';
import { COO_SECRET_HEADER } from '../src/room/identity.ts';
import { GLOBAL_HEADER } from '../src/room/identity-protocol.ts';

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

it('未入座时凭身份票查公告和说书厅、提交反馈，说书操作需要席位令牌', async () => {
  const gateway = 'https://parlor.test';
  const authority = 'https://identity.test';
  const cooId = 'coo-test-story';
  const identityTicket = 'fixture-identity-ticket';
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.href === `${gateway}/healthz`) {
      return Response.json({ protocol: 2, globalIdentity: { authority, audience: gateway } });
    }
    if (url.href === `${authority}/v1/identity/session`) {
      return Response.json({ token: identityTicket, expiresAt: Date.now() + 120_000,
        person: { cooId, handle: 'xiaoman', name: '小满', kind: 'pet' } });
    }
    return Response.json({});
  });

  try {
    const client = new ParlorClient(gateway, { cooId, cooSecret: 'fixture-coo-secret-0000' });
    await client.initializeIdentity(authority, 'fixture-invite', '小满');
    fetchMock.mockClear();
    await client.storyLive('');
    await client.support('', 'announcements');
    await client.support('', 'feedback', { text: '入厅提示', requestId: 'fixture-feedback' });
    const gatewayRequests = fetchMock.mock.calls.filter(([input]) => new URL(String(input)).origin === gateway);
    expect(gatewayRequests.map(([input, request]) => [request?.method, new URL(String(input)).pathname])).toEqual([
      ['GET', '/v1/story/live'],
      ['GET', '/v1/support/announcements'],
      ['POST', '/v1/support/feedback'],
    ]);
    for (const [, request] of gatewayRequests) {
      const headers = new Headers(request?.headers);
      expect(headers.get(GLOBAL_HEADER)).toBe(identityTicket);
      expect(headers.has('authorization')).toBe(false);
    }

    fetchMock.mockClear();
    const needsSeat = { status: 401, message: expect.stringContaining('请先入座') };
    await expect(client.storyAction('', { action: 'queue' })).rejects.toMatchObject(needsSeat);
    await expect(client.storyAction('', { action: 'start' })).rejects.toMatchObject(needsSeat);
    expect(fetchMock).not.toHaveBeenCalled();

    await client.storyAction('fixture-seat', { action: 'queue' });
    const [actionUrl, actionRequest] = fetchMock.mock.lastCall!;
    const actionHeaders = new Headers(actionRequest?.headers);
    expect(String(actionUrl)).toBe(`${gateway}/v1/story/action`);
    expect(actionRequest?.method).toBe('POST');
    expect(actionHeaders.get('authorization')).toBe('Bearer fixture-seat');
    expect(actionHeaders.has(GLOBAL_HEADER)).toBe(false);
  } finally {
    fetchMock.mockRestore();
  }
});
