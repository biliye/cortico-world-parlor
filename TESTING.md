# 茶室日常测试

在包源码目录运行。测试入口会在启动 Vitest **之前**把 TEMP/TMP/TMPDIR、PG和Vite临时文件固定到本包 `.task-tmp/test-runs/run-*`，不会改系统环境变量或回退到系统TEMP。

| 命令 | 范围 | 何时用 |
|---|---|---|
| `pnpm test` | 固定的无PG快测：游戏规则、界面状态、本机档案、旧协议等 | 日常改动后的基础检查；不是完整发布门禁 |
| `pnpm test tests/doudizhu.test.ts` | 指定快测文件 | 只修改对应规则时 |
| `pnpm test:pg` | 真实PG核心五文件：schema升级、生命周期/账户、牌桌事务、账本与资源回收 | 改服务端/存储时日常检查 |
| `pnpm test:pg tests/ledger-db.test.ts` | 只跑指定PG文件 | 改账本时，不顺带全量 |
| `pnpm test tests/room-host.test.ts` | 识别显式PG文件后使用受管PG入口 | 同上，省去切命令 |
| `pnpm test:all` | 所有测试文件，单进程、一轮隔离PG | 发布前或涉及广泛存储/协议变更时显式执行 |
| `pnpm test:pg --plan` | 只显示模式和文件清单，不创建目录或PG | 让审查工具先确认范围 |

仍应跑与改动直接相关、未纳入五文件核心集的权限、信箱、迁移、身份或重连用例。**快测通过、核心PG通过都不能写成全量通过。** 新增测试默认只进入完整回归，确认无PG后再加入 `scripts/test-profiles.mjs` 的快测清单。

## 发布包装载检查

从源码目录用 pnpm 生成两份候选包。World 打包时会去掉源码开发命令，只保留 `serve`。两份 tarball 使用同一版本，在同一批发布中用 `npm publish <已验证的 tarball>` 分别上传。

```sh
version=$(node -p "require('./package.json').version")
mkdir -p .task-tmp
check_dir=$(mktemp -d .task-tmp/release-check-XXXXXX)
mkdir -p "$check_dir/world" "$check_dir/gateway"
pnpm pack --pack-destination "$check_dir"
pnpm pack:gateway "$check_dir"
tar -xzf "$check_dir/cortico-world-parlor-$version.tgz" -C "$check_dir/world"
tar -xzf "$check_dir/cortico-parlor-gateway-$version.tgz" -C "$check_dir/gateway"
pnpm check:release "$check_dir/world/package"
pnpm check:release "$check_dir/gateway/package"
node scripts/check-webui.mjs "$check_dir/world/package"
```

World 检查依赖清单、扩展入口和单厅脚本引用的文件、客户端版本与 `/play` 资源。网关检查 JavaScript 模块、四个 CLI 实际装载，以及 `/play` 和 `/parent` 的资源。对解开的 World 继续跑 Cortico 的 `check:extension`。发布前在隔离目录安装两份 tarball，验证 World 生产依赖没有 `pg`，验证本机入场与家长观战，再用临时 PostgreSQL 验证独立网关的启动和 `/healthz`。

`play.html` 和 `parent.html` 中指向 `/play/assets/` 或 `/parent/assets/` 的 `src`、`href` 引用都应带一个与包版本相同的 `v`。兼容样式 `/play/assets/play.css` 沿用无版本链接，按静态资源的 300 秒缓存有效期更新。

涉及服务端或存储时，按日常范围跑核心 PG，再按改动补定向 PG。例如飞行棋 HTTP 协议改动跑 `pnpm test:pg tests/aeroplane-gateway.test.ts`，说书厅入场和归档权限改动跑 `pnpm test:pg tests/storyteller.test.ts`。

## 磁盘与清理

- 每次调用只启动一个嵌入式PG集群；worker不再自行启动PG。默认一个测试进程，连接上限50。不同调用独占临时目录，自动选本机空闲端口。
- 临时库名含本轮随机ID；每个测试结束后回收已关闭连接的临时库，不删仍有连接的库；文件语义夹具保留至本轮结束。PG停止后父进程删除整轮目录，包括SSR缓存，不扫描外部服务器的数据库前缀。
- 启动前检查目标盘：快测至少256MiB、核心/指定PG至少1GiB、全量至少4GiB。这是最低余量检查，不是严格磁盘配额；空间不足立即失败，不自动重试全量。
- 启动时探测创建/重命名/单文件及小目录递归删除。小探针通过**不保证**宿主允许批量删除几千个文件；WorkBuddy的批量删除守卫与Windows ACL是不同层。保留宿主环境及守卫，不分批删除绕过阈值、不改系统ACL、不转到C盘。
- `testExitCode`记录Vitest结果，`cleanupExitCode`记录资源清理结果。两者都成功才整体退出0；**测试通过而清理未完成退出2**，末行明确说明；测试失败则保留测试失败码，即使同时清理失败也不会误报为代码通过。
- `.task-tmp/test-results/*.json`保留上述两类状态、兼容的整体`exitCode`、`cleaned`、起止时间和目录。发现上轮失败回执对应的自有目录仍存在时，本轮在建目录/起PG前退出2，输出`testExitCode:null`，不重复堆积。`--plan`仍可用；预检阻塞不等于跑过测试。
- 清理失败或宿主要求审批时，先按宿主授权流程处理已有目录。没有授权不会换工具/拆分操作绕过保护；本轮不会自动删除这些残留。强杀进程/断电也可能留下没有完整回执的目录，仍需按 `owner.json` / `pg-state.json` 确认进程和PG已停止后处理。
- `PARLOR_TEST_TMP` 只允许本包 `.task-tmp` 的子目录，并核对链接实际目标；不接受工位外目录。入口拒绝外部 `PARLOR_TEST_PG_URL`，不把正式PG拿来跑测试。

不要绕过入口直接 `vitest --config vitest.pg.config.ts`：进程启动后才设置TEMP，无法保证宿主先建的缓存位置；新版PG setup也会拒绝缺少本轮所有权标记的调用。旧 `tests/helpers/pg-global.ts` 不再被默认配置引用，保留给既有未提交工作的所有者处理。

IDE测试按钮直接调用Vitest不受支持，请在IDE终端使用上表命令。完整回归仍为单进程，可能明显长于核心集；不同宿主的同一旧核心集曾分别实测约31秒与141秒，不能按文件数线性推断全量耗时，也不把未实测的45–60分钟当作门禁预期。

本轮没有删测试、把PG改mock/SQLite，或放宽超时；只是缩小日常范围并改善资源生命周期。云端运行配置、业务数据库、本机Coo和已存档消息均未改动。
