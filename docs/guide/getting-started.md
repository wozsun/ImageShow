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

Docker 镜像已包含 Node.js 26.5.1。只有在宿主机直接运行开发、检查或构建命令时，才需要安装 Node.js `>=26.3.0 <27`；该版本范围覆盖项目使用的原生 UUIDv7、Temporal、Argon2 与 TypeScript 类型擦除。

若使用 `.env`，首次启动必须提供：

```ini
SITE_DOMAIN=img.example.com
ADMIN_USERNAME=admin
ADMIN_PASSWORD=
DATABASE_NAME=imageshow
DATABASE_USER=imageshow
DATABASE_PASSWORD=
REDIS_PASSWORD=
REDIS_MAXMEMORY=500mb
```

`ADMIN_PASSWORD` 与 `DATABASE_PASSWORD` 必须先填入随机强密码，示例文件故意留空以避免可预测默认凭据进入生产。`ADMIN_USERNAME` / `ADMIN_PASSWORD` 仅在数据库尚无 super 管理员时用于创建首个账号（最终以用户名 + Argon2id 密码哈希保存到数据库），初始化完成后即可从 `.env` 移除。已有 super 时启动不会再读取它们覆盖账号或密码。

`DATABASE_*` 与 `REDIS_*` 是部署配置，每次应用进程启动都会读取；其中
数据库连接变量必须持续由 Compose、`.env` 或 Docker Secret 提供。Compose
内置 Redis 使用私有网络内不固定次版本的无密码 `redis:8` 镜像，并启用 AOF；
`REDIS_MAXMEMORY` 默认 `500mb`，本机大图库实验设为 `2gb`，淘汰策略固定为
`noeviction`。应用启动时检查正数 `maxmemory`、该策略以及 `INCREX`、`ARRING` 与
`ARLASTITEMS`；连接外部 Redis 时同样要求具备这些
能力，只有启用了认证时才填写
可选的 `REDIS_PASSWORD`。部署字段不写入
`data/config.json`，也不能从后台高级配置修改。应用在代码中固定监听容器内
`5518`；`HOST_PORT` 只控制映射到该端口的宿主机端口，默认同为 `5518`。

Redis 暂时不可连接或能力不满足时，HTTP 进程仍监听：`/livez` 可用，`/readyz`
保持非就绪，画廊、详情和后台正常图片列表回源 PostgreSQL，普通随机请求返回 503。
Redis 恢复后先重新检查能力、内存策略、revision 与核心完整性，通过后才开放缓存。

Docker 容器硬上限还应高于 Redis `maxmemory`，为 AOF 缓冲、客户端和分配器保留空间。
达到 `maxmemory` 时 Redis 不自行淘汰键；应用先按 LRU 清理组合筛选与统计结果，继续
优先保留画廊核心投影。Redis 请求最长等待 5 秒，连接恢复后会重新校验缓存。核心投影
本身超限时只能停机提高 `REDIS_MAXMEMORY` 及容器硬上限。

应用默认监听 `5518` 端口，由反向代理对外提供 HTTPS（见 [反向代理与部署](./deployment.md)）。以站点域名访问（下例以 `img.example.com` 为站点域名）：

- 首页：`https://img.example.com/home`
- 画廊：`https://img.example.com/gallery`
- 后台：`https://img.example.com/admin`
- 随机图：`https://img.example.com/random`

应用镜像以 UID/GID `1000` 运行。Linux 使用 bind mount 前，先让该用户可写入持久化目录：

```bash
sudo install -d -o 1000 -g 1000 data
```
