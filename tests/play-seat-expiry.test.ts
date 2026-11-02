import { describe, expect, it } from 'vitest';
import { decideExpiredSeat, seatTokenFrom } from '../web-src/lib/seat-errors.ts';

describe('换厅期间迟到的席位失效响应', () => {
  it('本页已换到新令牌时，旧 401 不清凭证、不重载旧地址', () => {
    expect(decideExpiredSeat('old', 'new', 'new')).toBe('ignore');
  });

  it('另一个标签页更新令牌时，旧标签页仍重新读取新席位', () => {
    expect(decideExpiredSeat('old', 'new', 'old')).toBe('reload');
  });

  it('当前令牌确实失效时仍回到加入页', () => {
    expect(decideExpiredSeat('old', 'old', 'old')).toBe('clear');
  });

  it('加入页本来就没有席位时什么都不做', () => {
    expect(decideExpiredSeat('old', null, null)).toBe('ignore');
  });

  it('失败回包携带发起请求时的令牌，而非回包时的新令牌', () => {
    const headers = new Headers({ authorization: 'Bearer old' });
    expect(seatTokenFrom(headers)).toBe('old');
  });
});
