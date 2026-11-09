/** 已经迁到 Vue 的桌面组件；没列进来的（骰子、旧大富翁）仍走 legacy-games.ts 的旧挂载。 */
import { defineAsyncComponent, defineComponent, h, type Component } from 'vue';
import DdzGame from '../components/games/DdzGame.vue';
import WerewolfGame from '../components/games/WerewolfGame.vue';

/**
 * 分包加载失败时的兜底。
 *
 * 构建按内容哈希命名分包（`chunk-<hash>.js`），发版就换名字：升级前一直开着的标签页，
 * 第一次进五子棋或快局大富翁时请求的还是旧文件名，干净安装下就是 404。旧页时代整页
 * 是一个脚本，没这个问题；换成 Vue 之后必须自己接住，否则牌桌区域会空着、也没有入口。
 * 不自动整页重载——牌已经发在桌上，让用户自己决定什么时候刷。
 */
export const ChunkLoadFailed = defineComponent({
  name: 'ChunkLoadFailed',
  setup() {
    return () => h('div', { class: 'chunk-fallback' }, [
      h('strong', '这一桌的界面没载入成功'),
      h('p', '页面可能还是升级前的版本，刷新一下就能跟上这次更新；桌上的进度在服务器上，不会丢。'),
      h('button', { class: 'btn', type: 'button', onClick: () => location.reload() }, '刷新页面'),
    ]);
  },
});

/**
 * 真正进桌才拉的棋盘分包：先自动重试一次（跨境链路上的偶发失败能自愈），
 * 仍失败就交给 ChunkLoadFailed 提示刷新。
 */
function lazyGame(loader: () => Promise<Component>): Component {
  return defineAsyncComponent({
    loader,
    delay: 200,
    timeout: 20_000,
    errorComponent: ChunkLoadFailed,
    onError(_error, retry, fail, attempts) {
      if (attempts <= 2) retry();
      else fail();
    },
  });
}

/**
 * 快局大富翁的棋盘与素材只在真正进桌时才请求：入口只留一个异步壳，
 * 冷进桌的额外传输量按这个 chunk 加美术算（预算 500 KB）。
 */
const Monopoly2dGame = lazyGame(() => import('../components/games/Monopoly2dGame.vue'));

const COMPONENTS: Record<string, Component> = {
  ddz: DdzGame,
  werewolf: WerewolfGame,
  monopoly2d: Monopoly2dGame,
  gomoku: lazyGame(() => import('../components/games/GomokuGame.vue')),
};

export function componentFor(game: string): Component | null {
  return COMPONENTS[game] || null;
}
