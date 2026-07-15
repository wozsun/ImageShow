# 快速开始（Docker Compose）

需要已安装 Docker。在仓库根目录复制环境变量模板并修改其中的值：

```bash
cp .env.example .env
docker compose up -d --build
```

Docker 镜像已包含 Node.js 26.5.0。只有在宿主机直接运行开发、检查或构建命令时，才需要安装 Node.js `>=26.3.0 <27`；该最低小版本已覆盖项目使用的原生 UUIDv7、Temporal、Argon2 与 TypeScript 类型擦除，项目不提供旧 Node 兼容分支。

首次启动必须在 `.env` 中提供：

```ini
SITE_DOMAIN=img.example.com
ADMIN_USERNAME=admin
ADMIN_PASSWORD=
DATABASE_NAME=imageshow
DATABASE_USER=imageshow
DATABASE_PASSWORD=
```

`ADMIN_PASSWORD` 与 `DATABASE_PASSWORD` 必须先填入随机强密码，示例文件故意留空以避免可预测默认凭据进入生产。`ADMIN_USERNAME` / `ADMIN_PASSWORD` 仅在数据库尚无 super 管理员时用于创建首个账号（最终以用户名 + Argon2id 密码哈希保存到数据库），初始化完成后即可从 `.env` 移除。已有 super 时启动不会再读取它们覆盖账号或密码。

v3.3.0 不支持从 v3.2.x 原地升级数据库。首次部署 v3.3.0 必须使用
全新 PostgreSQL 数据库并重新导入图片；正式发布后，后续数据库变化将
通过新的顺序迁移文件升级，不再要求清库。

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
