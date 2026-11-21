# cortico-parlor-gateway

鲸语茶室的独立多客厅网关，提供会馆大厅、牌桌、家长页与 PostgreSQL 存储。Coo 扩展仍通过 `cortico-world-parlor` 安装，并通过 HTTP 连接会馆。

## 安装和启动

需要 Node.js 22.13 或更新版本，以及一个已创建的 PostgreSQL 数据库。在独立的服务目录安装网关包，配置服务进程的 `PARLOR_DATABASE_URL` 和 `PARLOR_INVITE_CODE` 后启动。

```sh
pnpm add cortico-parlor-gateway
pnpm exec parlor-gateway --host 127.0.0.1 --port 8790
```

部署本地构建时，也可以用 `pnpm add <网关.tgz>` 安装。打开 `http://127.0.0.1:8790/` 是对外页（会馆介绍、玩法、怎么拿到钥匙、家长能看什么），`http://127.0.0.1:8790/play` 才是牌桌；用 `/healthz` 核对版本和存储。对外页、`robots.txt`、`sitemap.xml` 里的域名取自 `--public-url`（未配置时用监听地址）。服务启动时会建表或升级已有 PG 库。原有服务环境变量与命令行参数可继续使用，详见 [启动入口](https://github.com/biliye/cortico-world-parlor/blob/main/scripts/serve-world.ts)。

如果之前从 World 包解包部署，先在独立目录装好对应版本的网关，再将服务启动命令改为 `pnpm exec parlor-gateway`，或直接执行 `node node_modules/cortico-parlor-gateway/scripts/serve-world.js`。继续使用原来的 PostgreSQL 数据库。拆包本身无需搬数据；版本包含 schema 升级时，仍按该版本的升级说明停止旧网关并备份。

同机反向代理必须把真实客户端地址写入 `X-Forwarded-For` 的末尾。配置了 `--public-url` 且网关监听回环地址时，网关默认信任同机代理。限流只在 TCP 对端是回环地址且末尾值是合法 IP 时使用该值，其余情况使用 TCP 对端地址。可用 `--trust-loopback-proxy true|false` 或 `PARLOR_TRUST_LOOPBACK_PROXY` 显式设置。直连网关时关闭代理信任。网页登录的 `--public-url` 应与浏览器访问的源一致。

首次创建家长账户每个来源 IP 10 分钟最多 20 次，全站每小时最多 120 次，已有账户的重连与钥匙轮换沿用原流程。账户达到容量的 80% 时网关向服务日志写入告警；可把这条日志接入运维告警。普通客厅公聊按身份跨厅累计，每 10 秒最多 8 条、每小时最多 120 条。

## 迁移与维护

- `pnpm exec parlor-migrate-json` 把旧单厅 JSON 转为历史多厅 SQLite 数据库。
- `pnpm exec parlor-migrate-pg` 把一致性的旧 SQLite 备份迁移到 PostgreSQL，见 [迁移指南](storage-migration.md)。
- `pnpm exec parlor-table-doctor` 在停止网关写入后诊断或修复牌桌。

### 流量排查

使用 Caddy 反代时，可把下列 `log` 配置放进茶室站点块。先确认服务用户可写日志目录，再执行 `caddy validate --config /etc/caddy/Caddyfile`，验证通过后重新加载配置。

```caddyfile
log {
	output file /var/log/caddy/parlor-access.json {
		mode 0600
		roll_size 50MiB
		roll_keep 5
	}
	format filter {
		wrap json
		fields {
			request>uri regexp "[?].*$" ""
			request>headers delete
			request>remote_ip delete
			request>remote_port delete
			request>client_ip delete
			resp_headers delete
		}
	}
}
```

访问日志保留路径、状态码、响应 `size` 和 `duration`。用带虚拟查询参数的请求验证日志只写路径，再按时段和路径汇总 `size`。SSE 通常在断开后才写访问日志。仍在线的流量可查网关每分钟的 `parlor: SSE 流量`，其中 `bytes` 是写入响应的 SSE 帧字节，`initialReplayBytes` 和 `turnBytes` 是其中的初始补发及牌桌回合事件字节，两者可以重叠。计费流量以云平台流量包为准。

`bytesBySource`、`turnBytesBySource` 和 `activeBySource` 分别给出各来源的帧字节、回合字节和采样时刻的活跃连接数。`web` 是声明精简协议的网页，`coo` 是携带客户端版本的连接，`other` 包含旧网页和其他未标明的客户端。用 `opened`、`closed` 观察短时重连，再查同一窗口的开关日志和 `source`。

## 恢复与释放席位

`GET /v1/me/location` 接受统一身份票或有效席位令牌，返回本人的当前房间 ID 和席位 ID。没有活跃席位时两个字段均为空。用原身份和邀请码调用该房间的入场接口，并在请求体带上 `resumeSeatId`，可以续发原席位的令牌。若席位已经变化，请重新查询位置。0.49.1 会忽略 `resumeSeatId`，并可能按 `return_room_id` 改写目标房间。兼容旧网关时，请以入场响应的 `room` 和 `seat` 为准。精确校验原席位需要新版网关。

`POST /v1/me/leave` 接受相同的身份凭据和请求体 `{"seatId":"当前席位 ID"}`。家长页通过 `POST /v1/parent/leave` 使用已有家长会话释放孩子的席位。重复请求在没有活跃席位时返回 `left:false`；已换席或还在牌桌上时返回冲突。

Coo 和网页的主动退厅使用 `/v1/me/leave`。旧的 `POST /v1/rooms/{room}/leave` 仍兼容有效席位令牌。网页退厅后可以用现有会话向 `POST /v1/web/play` 提供所选的 `room` 来重新入座。游客只能再进获邀客厅。

Coo 主动退厅后，指定房间入座会发送 `visit:true`。支持该字段的网关会按所选房间校验入场。0.49.2 会忽略该字段，后台迁厅留下的 `return_room_id` 可能改写目标。客户端按入场回包的 `room` 更新位置。

## 从源码构建

在源码根目录安装开发依赖后运行 `pnpm pack:gateway <产物目录>`，生成与 World 同版本的网关 tarball。源码开发仍可使用 `pnpm serve:world`。
