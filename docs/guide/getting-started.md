# 本地快速体验（Docker Compose）

需要已安装 Docker。`compose.yaml` 不提供数据库密码或首次管理员密码；首次启动前必须创建
`.env` 并为 `DATABASE_PASSWORD`、`ADMIN_PASSWORD` 设置非空值，缺失或空值会在 Compose
展开阶段直接失败。`.env` 只供 Compose 插值，不会作为 `env_file` 整份注入；未被
`services.imageshow.environment` 显式引用的变量不会进入容器。站点域名在首次启动后通过
`data/config.json` / 高级配置修改；若要在空目录生成时播种，则需另行显式映射
`SITE_DOMAIN`。未映射 `TZ` 时 Server 使用 `UTC`。

这套全内置 Compose 只用于本地体验、开发和全新安装验证，不作为当前正式生产部署。
生产环境固定为一台主机上的一个 ImageShow 应用容器；PostgreSQL 与 Redis 在另一套
基础设施 Compose 中各运行一个单机单容器。升级先停止对应当前容器，更新后原位启动。
正式部署细节见[反向代理与部署](./deployment.md)。

复制环境变量模板，填写两个密码后拉取并启动发布镜像：

```bash
cp .env.example .env
docker compose pull
docker compose up -d
```

Docker 镜像已包含 Node.js 26.7.0。只有在宿主机直接运行开发、检查或构建命令时，才需要安装
Node.js `>=26.3.0 <27`；该版本范围覆盖项目使用的原生 UUIDv7、Temporal、Argon2 与
TypeScript 类型擦除。

默认后台登录用户名为 `admin`。默认 Compose 的五个必要值为：

```ini
DATABASE_NAME=imageshow
DATABASE_USER=imageshow
DATABASE_PASSWORD=
ADMIN_USERNAME=admin
ADMIN_PASSWORD=
```

两个密码都没有默认值，必须使用不同的随机强密码；管理员密码为 8–128 位且同时包含字母和
数字。`ADMIN_USERNAME` / `ADMIN_PASSWORD` 仅在数据库尚无 super 管理员时用于创建首个账号
（最终以用户名 + Argon2id 密码哈希保存到数据库），已有 super 时应用不会用它们覆盖账号或
密码。默认 `compose.yaml` 每次展开仍要求两个密码非空。

默认 Compose 向 ImageShow 注入数据库三项和首次管理员两项；ImageShow 与 PostgreSQL 在各自
`environment` 中直接插值同一组数据库值，不使用顶层 `x-*` 设置。内置拓扑的数据库 host / port
与 Redis host / port / db / password 使用 Server 代码默认值，不进入默认
`imageshow.environment`。连接外部 PostgreSQL / Redis 时，
必须在 Compose override 或其他部署清单中逐项映射相应可选变量。Compose
内置 Redis 使用私有网络内不固定次版本的无密码 `redis:8` 镜像，直接采用镜像默认启动命令
并保留 `/data` volume，但不强制 AOF。该 volume 只提供尽力而为的重启保留；会话、限流、
缓存和未完全入库内容仍允许丢失，正式图片只以 PostgreSQL 为准。
Compose 与应用都不设置或推断 Redis 内存上限、淘汰策略和容器硬限制。应用只读取
`INFO MEMORY` 供运维观测，启动时在自有 5 秒 TTL 隔离探针键上实际执行 `INCREX`、
`ARRING`、`ARLASTITEMS`、`SET ... IFEQ ... KEEPTTL` 与 `DELEX ... IFEQ`，并验证条件失败、
缺失和 TTL 保留；只返回命令元数据但 ACL 拒绝执行仍不能通过；
连接外部 Redis 时同样要求具备这些能力，只有启用了认证时才填写
可选的 `REDIS_PASSWORD`。部署字段不写入
`data/config.json`，也不能从后台高级配置修改。应用在代码中固定监听容器内
`5518`；默认 Compose 固定使用 `127.0.0.1:5518:5518`。需要其他宿主机端口或绑定地址时，
使用 `compose.override.yaml`、其他部署清单或 `docker run -p [host-ip:]<host-port>:5518`，
不要增加应用环境变量。

`.env.example` 还列出所有 RuntimeConfig 首次播种变量，默认 Compose 不注入其中任何一项。
这些变量只有在部署者逐项扩展 `services.imageshow.environment` 后才会进入容器；完整映射、
默认值和严格 JSON 写法见
[配置说明](./configuration.md#runtimeconfig-参数目录)。

Redis 暂时不可连接或能力不满足时，HTTP 进程仍监听。当前进程首次通过连接及五项能力
校验前只开放 `/livez` 与非就绪的 `/readyz`，全部业务返回 503，worker 也不启动；首次
成功后该冷启动门不再关闭。此后的运行期故障仍让 `/readyz` 非就绪并使后台统一返回
`503 redis_unavailable`，但公开画廊、详情、facets、统计、图片 / 缩略图和定向及普通
随机通过有界 PostgreSQL fallback 保持可用，只有准入队列或执行上限饱和时才返回
`429/503` 与 `Retry-After`。
应用进程冷启动和每个新 Redis 连接周期都会重新检查当前连接与命令能力；图片协调器以
`unavailable` / `rebuilding` / `ready` / `stopped` 四态和一个活动任务清理正式派生结果，
并校验图片 schema、PostgreSQL / Redis revision、meta、最后内容更新时间与核心完整性，
通过后才开放 Redis-first 公开读取。后台只要求 Redis 会话能力可用，每次认证再
按用户名查询一次 PostgreSQL `admin_account`，数据库异常返回 503 且保留会话。图片投影
单独 rebuilding 或
degraded 不影响 `/readyz` 或后台会话，公开读取与管理员 ready 列表暂时回源。Redis 请求
最长等待 5 秒；派生图片缓存共用 LRU registry，
只按 6 小时滑动 TTL、256 个结果、
128 个活跃签名、单结果与总成员数、单统计结果大小和构建并发约束结构规模，不根据
Redis 全局字节使用量阻止写入或触发全局清理。派生结果错误不会关闭核心图片读门。

应用默认监听 `5518` 端口，由反向代理对外提供 HTTPS（见 [反向代理与部署](./deployment.md)）。以站点域名访问（下例以 `img.example.com` 为站点域名）：

- 首页：`https://img.example.com/home`
- 画廊：`https://img.example.com/gallery`
- 后台：`https://img.example.com/admin`
- 随机图：`https://img.example.com/random`

应用镜像以 UID/GID `1000` 运行。Linux 使用 bind mount 前，先让该用户可写入持久化目录：

```bash
sudo install -d -o 1000 -g 1000 data
```
