# 快速开始（Docker Compose）

需要已安装 Docker。在仓库根目录复制环境变量模板并修改其中的值：

```bash
cp .env.example .env
docker compose up -d --build
```

首次启动必须在 `.env` 中提供：

```ini
SITE_DOMAIN=img.example.com
TZ=UTC
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me-now
ADMIN_FORCE_SYNC=false
DATABASE_NAME=imageshow
DATABASE_USER=imageshow
DATABASE_PASSWORD=change-me-db
```

`ADMIN_USERNAME` / `ADMIN_PASSWORD` 仅在数据库尚无 super 管理员时用于创建首个账号（最终以用户名 + Argon2id 密码哈希保存到数据库），初始化完成后即可从 `.env` 移除。已有 super 时启动默认不会覆盖密码；只有 `ADMIN_FORCE_SYNC=true` 才会强制同步。

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
docker compose up -d --build --force-recreate
```
