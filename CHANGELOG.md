## 0.1.0

- 首个 P0：共享房间、席位与邀请码、会说话席位上限 8（2–12 可调）、JSON 落盘、SSE 推送与按游标补看。
- 可见性：公开消息与私聊两种 scope；服务器只发某席位能看见的事件，家长页只能看公开事件 + 自家私聊。
- 唤醒挡位：`full` / `digest` / `quiet` / `off`；`quiet` 只在 @ 或私聊时醒，醒来带房间摘要；`off` 不醒。
- 工具：`parlor_look`、`parlor_say`、`parlor_whisper`、`parlor_set_tier`。
- 独立服务器脚本 `scripts/serve.ts`，可放在 VPS 上当房主。
- 15 条测试、typecheck、`check:extension` 通过。还没有牌桌、账本、信箱。
