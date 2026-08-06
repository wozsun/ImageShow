# 本地快速体验（Docker Compose）

需要已安装 Docker。`compose.yaml` 已提供完整默认连接参数；不创建 `.env` 时，
在 `services.imageshow.environment` 中设置首次管理员用户名和密码，并在文件顶部
的 `x-database-settings` 中修改数据库用户名和密码即可启动。正式访问前还应把
`SITE_DOMAIN` 默认值改为实际主域名。`TZ` 默认使用 `UTC`。

这套全内置 Compose 只用于本地体验、开发和全新安装验证，不作为当前正式生产部署。
生产环境固定为一台主机上的一个 ImageShow 应用容器；PostgreSQL 与 Redis 在另一套
基础设施 Compose 中各运行一个单机单容器。升级先停止对应当前容器，更新后原位启动。
正式部署细节见[反向代理与部署](./deployment.md)。

也可以复制环境变量模板覆盖 Compose 默认值，然后拉取并启动发布镜像：

```bash
cp .env.example .env
docker compose pull
docker compose up -d
```

Docker 镜像已包含 Node.js 26.7.0。只有在宿主机直接运行开发、检查或构建命令时，才需要安装 Node.js `>=26.3.0 <27`；该版本范围覆盖项目使用的原生 UUIDv7、Temporal、Argon2 与 TypeScript 类型擦除。

若使用 `.env`，首次启动必须提供：

```ini
SITE_DOMAIN=img.example.com
ADMIN_USERNAME=admin
ADMIN_PASSWORD=
DATABASE_NAME=imageshow
DATABASE_USER=imageshow
DATABASE_PASSWORD=
REDIS_PASSWORD=
```

`ADMIN_PASSWORD` 与 `DATABASE_PASSWORD` 必须先填入随机强密码，示例文件故意留空以避免可预测默认凭据进入生产。`ADMIN_USERNAME` / `ADMIN_PASSWORD` 仅在数据库尚无 super 管理员时用于创建首个账号（最终以用户名 + Argon2id 密码哈希保存到数据库），初始化完成后即可从 `.env` 移除。已有 super 时启动不会再读取它们覆盖账号或密码。

`DATABASE_*` 与 `REDIS_*` 是部署配置，每次应用进程启动都会读取；其中
数据库连接变量必须持续由 Compose、`.env` 或 Docker Secret 提供。Compose
内置 Redis 使用私有网络内不固定次版本的无密码 `redis:8` 镜像，并启用 AOF；
Compose 与应用都不设置或推断 Redis 内存上限、淘汰策略和容器硬限制。应用只读取
`INFO MEMORY` 供运维观测，启动时在自有 5 秒 TTL 探针键上实际执行 `INCREX`、`ARRING`
与 `ARLASTITEMS`；只返回命令元数据但 ACL 拒绝执行仍不能通过；
连接外部 Redis 时同样要求具备这些能力，只有启用了认证时才填写
可选的 `REDIS_PASSWORD`。部署字段不写入
`data/config.json`，也不能从后台高级配置修改。应用在代码中固定监听容器内
`5518`；`HOST_PORT` 只控制映射到该端口的宿主机端口，默认同为 `5518`。

Redis 暂时不可连接或能力不满足时，HTTP 进程仍监听。当前进程首次通过连接及三项命令
校验前只开放 `/livez` 与非就绪的 `/readyz`，全部业务返回 503，worker 也不启动；首次
成功后该冷启动门不再关闭。此后的运行期故障仍让 `/readyz` 非就绪并使后台统一返回
`503 redis_unavailable`，但公开画廊、详情、facets、统计、图片 / 缩略图和定向及普通
随机通过有界 PostgreSQL fallback 保持可用，只有准入队列或执行上限饱和时才返回
`429/503` 与 `Retry-After`。
应用进程冷启动和每个新 Redis 连接周期都会重新检查连接 epoch 与命令能力；图片协调器
另行清理正式派生结果，并校验图片 schema、revision、meta、最后内容更新时间与核心
完整性，通过后才开放 Redis-first 公开读取。后台只要求 Redis 会话能力可用，每次认证再
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
