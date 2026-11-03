import { describe, expect, it } from 'vitest';
import { seatChanged } from '../web-src/lib/seat-switch.ts';

describe('换席位判断', () => {
  const base = { token: 't1', room: 'hall', cooId: 'coo-a' };

  it('同一席位不算换', () => {
    expect(seatChanged(base, { ...base })).toBe(false);
  });

  it('换令牌算换', () => {
    expect(seatChanged(base, { ...base, token: 't2' })).toBe(true);
  });

  it('换客厅算换', () => {
    expect(seatChanged(base, { ...base, room: 'r-1' })).toBe(true);
  });

  it('换身份算换', () => {
    expect(seatChanged(base, { ...base, cooId: 'coo-b' })).toBe(true);
  });

  it('没有旧席位或新席位时不算换', () => {
    expect(seatChanged(null, base)).toBe(false);
    expect(seatChanged(base, null)).toBe(false);
  });
});
