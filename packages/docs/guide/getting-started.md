# 快速开始（Docker Compose）

需要已安装 Docker。`compose.yaml` 已提供完整默认连接参数；不创建 `.env` 时，
在 `services.imageshow.environment` 中设置首次管理员用户名和密码，并在文件顶部
的 `x-database-settings` 中修改数据库用户名和密码即可启动。正式访问前还应把
`SITE_DOMAIN` 默认值改为实际主域名。`TZ` 默认使用 `UTC`。

也可以复制环境变量模板覆盖 Compose 默认值，然后拉取并启动发布镜像：

```bash
cp .env.example .env
docker compose pull
docker compose up -d
```

Docker 镜像已包含 Node.js 26.5.0。只有在宿主机直接运行开发、检查或构建命令时，才需要安装 Node.js `>=26.3.0 <27`；该版本范围覆盖项目使用的原生 UUIDv7、Temporal、Argon2 与 TypeScript 类型擦除。

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
内置 Redis 固定使用私有网络内的无密码连接；只有连接启用了认证的外部 Redis
时才填写可选的 `REDIS_PASSWORD`。部署字段不写入
`data/config.json`，也不能从后台高级配置修改。应用在代码中固定监听容器内
`5518`；`HOST_PORT` 只控制映射到该端口的宿主机端口，默认同为 `5518`。

应用默认监听 `5518` 端口，由反向代理对外提供 HTTPS（见 [反向代理与部署](./deployment)）。以站点域名访问（下例以 `img.example.com` 为站点域名）：

- 首页：`https://img.example.com/home`
- 画廊：`https://img.example.com/gallery`
- 后台：`https://img.example.com/admin`
- 随机图：`https://img.example.com/random`

应用镜像以 UID/GID `1000` 运行。Linux 使用 bind mount 前，先让该用户可写入持久化目录：

```bash
sudo install -d -o 1000 -g 1000 data
```

升级 Redis 镜像后：

```bash
docker compose pull redis
docker compose up -d --force-recreate
```
