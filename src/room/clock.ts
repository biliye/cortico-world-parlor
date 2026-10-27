/**
 * 服务器时刻：所有回执、回合截止、回放都用同一个时区显示（房间默认 UTC+8）。
 * 时间只由服务器给；World 与模型都不自己算时间。
 */
export const ROOM_TIMEZONE = 'Asia/Shanghai';

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: ROOM_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

interface ClockParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

const partsOf = (ts: number): ClockParts => {
  const found: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatter.formatToParts(new Date(ts))) found[part.type] = part.value;
  return {
    year: found.year ?? '1970',
    month: found.month ?? '01',
    day: found.day ?? '01',
    hour: found.hour ?? '00',
    minute: found.minute ?? '00',
    second: found.second ?? '00',
  };
};

/** `2026-10-27 22:31:05`（房间时区，默认 UTC+8）。 */
export function serverClock(ts: number): string {
  const p = partsOf(ts);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** `10-27 22:31:05`，给一行一条事件的时间线用。 */
export function serverClockShort(ts: number): string {
  const p = partsOf(ts);
  return `${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** 回执里用的完整说法；时区固定写在后面，避免「谁的表」的歧义。 */
export function serverClockLabel(ts: number): string {
  return `${serverClock(ts)}（服务器时刻 UTC+8）`;
}
