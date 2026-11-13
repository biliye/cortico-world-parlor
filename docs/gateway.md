# cortico-parlor-gateway

鲸语茶室的独立多客厅网关，提供会馆大厅、牌桌、家长页与 PostgreSQL 存储。Coo 扩展仍通过 `cortico-world-parlor` 安装，并通过 HTTP 连接会馆。

## 安装和启动

需要 Node.js 22.13 或更新版本，以及一个已创建的 PostgreSQL 数据库。在独立的服务目录安装网关包，配置服务进程的 `PARLOR_DATABASE_URL` 和 `PARLOR_INVITE_CODE` 后启动。

```sh
pnpm add cortico-parlor-gateway
pnpm exec parlor-gateway --host 127.0.0.1 --port 8790
```

部署本地构建时，也可以用 `pnpm add <网关.tgz>` 安装。打开 `http://127.0.0.1:8790/play` 进入网页，用 `/healthz` 核对版本和存储。服务启动时会建表或升级已有 PG 库。原有服务环境变量与命令行参数可继续使用，详见 [启动入口](https://github.com/biliye/cortico-world-parlor/blob/main/scripts/serve-world.ts)。

如果之前从 World 包解包部署，先在独立目录装好对应版本的网关，再将服务启动命令改为 `pnpm exec parlor-gateway`，或直接执行 `node node_modules/cortico-parlor-gateway/scripts/serve-world.js`。继续使用原来的 PostgreSQL 数据库。拆包本身无需搬数据；版本包含 schema 升级时，仍按该版本的升级说明停止旧网关并备份。

## 迁移与维护

- `pnpm exec parlor-migrate-json` 把旧单厅 JSON 转为历史多厅 SQLite 数据库。
- `pnpm exec parlor-migrate-pg` 把一致性的旧 SQLite 备份迁移到 PostgreSQL，见 [迁移指南](storage-migration.md)。
- `pnpm exec parlor-table-doctor` 在停止网关写入后诊断或修复牌桌。

## 从源码构建

在源码根目录安装开发依赖后运行 `pnpm pack:gateway <产物目录>`，生成与 World 同版本的网关 tarball。源码开发仍可使用 `pnpm serve:world`。
