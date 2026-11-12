import { expect, it } from 'vitest';
import { AeroplaneTable } from '../src/room/games/aeroplane-table.ts';
import { gameComponent } from './helpers/game-component.ts';

it('飞行棋交棒后清空骰面，下一位实际掷骰后才显示新点数', async () => {
  const die = [3, 6];
  const table = new AeroplaneTable({
    host: { id: 'red', name: '阿红' }, firstSeat: () => 0, rollDie: () => die.shift()!,
  });
  table.join({ id: 'green', name: '阿绿' });
  table.start('red', 1000);

  const game = gameComponent('AeroplaneGame.vue');
  const render = () => game.html({ view: { table: table.public(), priv: null, me: { id: 'spectator' } }, ctx: {} });
  table.act('red', { action: 'roll' }, 1001);
  const waiting = await render();
  expect(waiting.match(/class="flight-dice"[^>]*>([^<]*)/)?.[1]).toBe('–');
  expect(waiting).toContain('等待 阿绿 掷骰');
  expect(waiting).toContain('阿红掷出 3。');

  table.act('green', { action: 'roll' }, 1002);
  const rolled = await render();
  expect(rolled.match(/class="flight-dice rolling"[^>]*>([^<]*)/)?.[1]).toBe('⚅');
  expect(rolled).toContain('阿绿 掷出 6 点');
});
