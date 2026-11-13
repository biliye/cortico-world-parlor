# 从 SQLite 迁移到 PostgreSQL

安装 `cortico-parlor-gateway` 后运行 `pnpm exec parlor-migrate-pg`，从源码运行则用 `pnpm migrate:pg`。迁移工具以只读方式打开来源库，导入当前迁移表清单中的数据，包括旧 `monopoly_*` 与历史 `migration_runs`。导入后逐行核验内容，校准 `mail.seq`、`ledger_entries.ord`、`ledger_transfers.id` 三个自增序列，并在目标库留下来源哈希、表级行数、工具版本与起止时刻。脚本见 [migrate-sqlite-to-pg.ts](https://github.com/biliye/cortico-world-parlor/blob/main/scripts/migrate-sqlite-to-pg.ts)。

```bash
# 1. 先审计（不连目标、不写任何东西）
pnpm exec parlor-migrate-pg --source ./parlor-backup.db --dry-run

# 2. 搬到空库；拷贝 + 序列校准 + 核验在同一个事务里，核验不过整笔回滚
pnpm exec parlor-migrate-pg --source ./parlor-backup.db --target 'postgres://用户:密码@主机:5432/parlor'
```

- **来源必须是一致性备份**：停写之后用 SQLite 的 Backup API，或完全关闭连接后的状态。直接复制
  正在写的 `.db` + WAL 不算；工具看到旁边还有非空 `-wal` 会直接拒绝。
- 结构对不上、外键坏、JSON 解析不出、整数超出安全范围、同一个人两个活跃席位、进行中却没有
  存档的牌局——任何一条都中止，不跳过、不修成空值。
- 目标必须是**空库**，非空默认拒绝。`--force` 只允许清理同一失败批次的审计记录；已完成迁移或已有业务数据的目标禁止覆盖。迁移目标也可通过 `PARLOR_DATABASE_URL` 配置，避免把口令放进命令行。
- 核验两层：逐表逐行摘要（JSON 按键排序后比结构）+ 语义对照（余额、局数胜场、未读、活跃席位、
  房间 seq、事件与受众、回执、短号、票据、未结束牌局、账本条目按种类）。
- 工具不碰部署、不改配置；正式切换由运营者按下面的顺序做。

**切换顺序**（默认先停桌再迁库；带进行中的牌局迁移要先专项演练恢复补偿与时钟边界）：

1. 核对源码/静态文件哈希、库结构与所有未结束的桌，确认代码版本与本地备份基线。
2. 隔离环境完整演练一遍（导入 + 核验 + 用新库起服务跑通身份/目录/牌局/SSE）。
3. 进维护窗口，停掉所有旧写入者：HTTP、SSE 的 `last_seen`、时钟、心跳、清理与运维脚本。
   只拦新开桌或 POST 不算停写。
4. 做一致性 SQLite 最终备份，留存旧源码/静态文件/启动配置与摘要。
5. 导入空 PG 目标并核验、备份；新服务保持维护状态，只对隔离测试身份验收。
6. 切换连接配置与服务版本，起**唯一一个**写入进程；确认 health/readiness、身份、目录、权限、
   网页、素材、SSE 与授权动作都正常。
7. 放行前留检查点。放行后记录「PG 开始接收正式写入」的时刻与迁移批次，旧 SQLite 封存不删。

**回退边界**：

| 时点 | 允许的恢复路线 |
|---|---|
| PG 还没接收正式新写入 | 停新服务，恢复已核验的旧代码/配置与最终 SQLite 状态，确认只有旧服务在写，再放行 |
| PG 已接收正式新写入 | 优先回退到**能读当前 PG schema 的上一份应用版本**，继续用 PG；或修好再起 |
| 已写入 PG 后想回 SQLite | 必须先停写、做反向迁移与全量差异核验并演练；本期不默认提供，直接导回旧 SQLite 会丢切换后的数据 |

备份不再是一个 `.db` 文件：切换前写好 `pg_dump` / `pg_restore` 的方案，并真的恢复到一个独立
目标验证过；角色、权限、配置与素材另外列进恢复清单。
