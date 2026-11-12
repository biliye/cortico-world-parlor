export const PLANES_PER_SEAT = 4;
export const MAX_SEATS = 4;
export const HANGAR = -1;
export const TRACK_LENGTH = 52;
// 离开环道前经过自己的入场口；起飞口前一格留给经过的其他颜色。
export const HOME_START = TRACK_LENGTH - 1;
export const FINISH = HOME_START + 5;

export const COLOURS = ['珊瑚红', '海天蓝', '松叶绿', '琥珀黄'] as const;

export const AEROPLANE_RULES = [
  '2–4 人，每人四架飞机。掷出 6 才能从机库起飞，走完后可以再掷一次。',
  '沿环道前进，落在同色格时向前跳四格。进入专属航道前的最后几格不跳。',
  '最后落点上的其他颜色飞机全部返回机库，同色飞机可以叠放。',
  '沿专属航道飞抵终点。点数超过终点时折返，先让四架飞机全部抵达的人获胜。',
  '掷骰或选飞机超时后，服务器会代走。',
];

export function colourFor(seatIndex: number, seats: number): number {
  return seats === 2 ? seatIndex * 2 : seatIndex;
}

export function trackIndex(colour: number, progress: number): number {
  return (colour * (TRACK_LENGTH / MAX_SEATS) + progress) % TRACK_LENGTH;
}

export function destination(progress: number, die: number, colour: number): { to: number; jumped: boolean } | null {
  if (progress === FINISH) return null;
  if (progress === HANGAR) return die === 6 ? { to: 0, jumped: false } : null;
  const landed = progress + die;
  const jumped = landed + 4 < HOME_START && trackIndex(colour, landed) % MAX_SEATS === colour;
  const to = landed > FINISH ? 2 * FINISH - landed : landed + (jumped ? 4 : 0);
  return { to, jumped };
}

export interface AeroplaneMove {
  /** 玩家从 1 开始数，网页和通用游戏动作使用同一个编号。 */
  plane: number;
  from: number;
  to: number;
  jumped: boolean;
  captures: number;
}

export interface AeroplaneSeat {
  id: string;
  name: string;
  planes: number[];
}

export function legalMoves(seats: readonly AeroplaneSeat[], current: number, die: number): AeroplaneMove[] {
  const colour = colourFor(current, seats.length);
  const moves: AeroplaneMove[] = [];
  seats[current].planes.forEach((from, index) => {
    const move = destination(from, die, colour);
    if (!move) return;
    let captures = 0;
    visitCollisions(seats, current, move.to, () => { captures += 1; });
    moves.push({ plane: index + 1, from, ...move, captures });
  });
  return moves;
}

export function visitCollisions(
  seats: readonly AeroplaneSeat[], current: number, to: number, visit: (seat: AeroplaneSeat, plane: number) => void,
): void {
  if (to >= HOME_START) return;
  const cell = trackIndex(colourFor(current, seats.length), to);
  seats.forEach((seat, index) => {
    if (index === current) return;
    const colour = colourFor(index, seats.length);
    seat.planes.forEach((progress, plane) => {
      if (progress >= 0 && progress < HOME_START && trackIndex(colour, progress) === cell) visit(seat, plane);
    });
  });
}

export function positionText(progress: number): string {
  if (progress === HANGAR) return '机库';
  if (progress === FINISH) return '终点';
  if (progress >= HOME_START) return `专属航道第 ${progress - HOME_START + 1} 格`;
  return progress === 0 ? '起飞格' : `环道第 ${progress + 1} 格`;
}
