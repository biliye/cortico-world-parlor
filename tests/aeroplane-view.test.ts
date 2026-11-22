import { expect, it } from 'vitest';
import { AeroplaneTable } from '../src/room/games/aeroplane-table.ts';
import { gameComponent } from './helpers/game-component.ts';

it('飞行棋交棒后标记上一掷并保留行动说明，下一次掷骰更新点数', async () => {
  const die = [3, 6];
  const table = new AeroplaneTable({
    host: { id: 'red', name: '阿红' }, firstSeat: () => 0, rollDie: () => die.shift()!,
  });
  table.join({ id: 'green', name: '阿绿' });
  table.start('red', 1000);

  const game = gameComponent('AeroplaneGame.vue');
  const render = () => game.html({ view: { table: table.public(), priv: null, me: { id: 'spectator' } }, ctx: {} });
  const initial = await render();
  expect(initial).not.toContain('上一掷');
  expect(initial).toContain('aria-label="尚未掷骰"');
  table.act('red', { action: 'roll' }, 1001);
  const waiting = await render();
  expect(waiting.match(/grid-area:pip-/g)).toHaveLength(3);
  expect(waiting).toContain('等待 阿绿 掷骰');
  expect(waiting).toContain('aria-label="上一掷 3 点"');
  expect(waiting).toContain('阿红掷出 3。没有可飞的飞机，换下一位。');

  table.act('green', { action: 'roll' }, 1002);
  const rolled = await render();
  expect(rolled.match(/grid-area:pip-/g)).toHaveLength(6);
  expect(rolled).toContain('aria-label="掷出 6 点"');
  expect(rolled).toContain('阿绿 掷出 6 点，正在选飞机');
  expect(rolled).not.toContain('阿绿掷出 6。');
  expect(rolled).not.toContain('掷出 6 点即可起飞。');
  expect(rolled).not.toContain('上一掷');
  table.act('green', { action: 'move', plane: 1 }, 1003);
  const reroll = await render();
  expect(reroll).toContain('等待 阿绿 掷骰');
  expect(reroll).toContain('aria-label="上一掷 6 点"');
  expect(reroll).toContain('阿绿的 1 号机起飞。再掷一次。');
});

it('只给当手玩家显示认输按钮，认输后清掉棋子并显示实际终局原因', async () => {
  const table = new AeroplaneTable({ host: { id: 'red', name: '阿红' }, firstSeat: () => 0 });
  table.join({ id: 'green', name: '阿绿' });
  table.start('red', 1000);
  const game = gameComponent('AeroplaneGame.vue');
  const render = (id: string) => game.html({ view: { table: table.public(), priv: table.view(id), me: { id } }, ctx: {} });
  expect(await render('red')).toContain('>认输</button>');
  expect(await render('green')).not.toContain('>认输</button>');
  table.act('red', { action: 'resign' }, 1001);
  const ended = await render('green');
  expect(ended).toContain('你赢得本局');
  expect(ended).toContain('其余玩家已认输');
  expect(ended).toContain('>已认输<');
  expect(ended).not.toContain('阿红的 1 号机');
  expect(ended).not.toContain('>认输</button>');
});
