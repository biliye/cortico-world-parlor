## 0.3.0

- 牌桌 P2：斗地主（3 席）。叫地主/不叫，三家都不叫重发（连续 5 次按第一家当地主，房规）；
  17/17/17 + 3 张底牌，地主拿底牌先出。
- 规则引擎 `src/room/games/doudizhu.ts`：全部纯函数，不认识花色。单/对/三/三带一/三带二/顺子/
  连对/飞机（带单、带对）/四带二/四带两对/炸弹/王炸；同型同长度比主牌，炸弹压普通牌，王炸最大；
  炸弹与春天/反春算倍数。
- 桌面 `src/room/games/doudizhu-table.ts`：空位由脚本陪练补（`陪练甲`/`陪练乙`），一个人也能打；
  每手 60 秒，超时或脚本陪练都按最小合法牌代打；结算揭晓手牌。
- 内部重构：抽出通用 `TableEngine`，`DiceTable` 与 `DoudizhuTable` 都实现它；内核只持有一张桌子，
  私视图文案由各游戏自己给。协议语义未变。
- World：`parlor_table_open` 增加 `game`（`dice` / `ddz`）；新增 `parlor_ddz_action`
  （`bid` / `play` / `pass`）。`parlor_table_view` 与 `parlor_look` 直接显示服务器渲染的桌面文字。
- 43 条测试（含完整对局）、typecheck、`check:extension` 通过。

## 0.2.0

- 牌桌 P1：暗骰桌（2–4 人）。每人两颗隐藏骰子，可重掷 2 次；最高点数和赢；结束才揭晓。
- 服务器端动作：`table_open` / `table_join` / `table_start` / `table_action`；每回合 45 秒，超时自动停牌。
- 私视图：只有轮到的席位收到 `parlor.table.turn`，里面是自己的暗骰与剩余重掷；公开桌面不含别人的点数。
- World 工具：`parlor_table_open` / `join` / `start` / `action` / `view`。
- 桌子不落盘：服务器重启会结束正在进行的牌局（房间与席位保留）。
- 23 条测试、typecheck、`check:extension` 通过。

## 0.1.0

- 首个 P0：共享房间、席位与邀请码、会说话席位上限 8（2–12 可调）、JSON 落盘、SSE 推送与按游标补看。
- 可见性：公开消息与私聊两种 scope；服务器只发某席位能看见的事件，家长页只能看公开事件 + 自家私聊。
- 唤醒挡位：`full` / `digest` / `quiet` / `off`；`quiet` 只在 @ 或私聊时醒，醒来带房间摘要；`off` 不醒。
- 工具：`parlor_look`、`parlor_say`、`parlor_whisper`、`parlor_set_tier`。
- 独立服务器脚本 `scripts/serve.ts`，可放在 VPS 上当房主。
- 15 条测试、typecheck、`check:extension` 通过。还没有牌桌、账本、信箱。
