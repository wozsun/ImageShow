# ImageShow

ImageShow 是一个面向个人服务器的图片展示、图库管理与随机图 API 服务。它提供公开首页与瀑布流画廊、后台上传管理、本地 / S3 兼容对象存储 / WebDAV 多后端并存、Redis 随机池缓存，以及一键 Docker 部署。

## 功能

- 公开首页与画廊，可按设备、亮度、主题筛选。
- 主题子域名（如 `nature.img.example.com`），以及 `random.*`、`static.*`、`link.*`、`docs.*` 四个保留子域名。
- `/random` 随机图 API，支持 `d`/`b`/`t`/`m` 参数；`/img-count` 提供随机池统计。
- 后台图片上传、编辑、删除、回收站、重复 MD5 检查。
- 链接导入支持“下载图片”（服务端转码压缩后按普通图片保存）与“代理链接”（仅保存缩略图和外链）两种模式。
- **存储多后端并存**：本地目录、S3 兼容对象存储与 WebDAV 可同时使用，每张图片记录自己所在后端，可单张或批量在后端之间迁移。
- WebP 缩略图，数据库 / 存储 / Redis 自检与存储迁移工具。

## 部署

以 Docker Compose 一键部署，自带 PostgreSQL 与 Redis。应用只监听一个端口（默认 `5518`），主域名及其全部子域名都由它按 `Host` 提供，生产环境在前置反向代理终止 HTTPS。

### 1. 准备

- 安装 Docker 与 Docker Compose。
- 一个域名，把**主域名与其通配子域名**（`random.` / `static.` / `docs.` / `link.` 及各主题子域都走同一应用）解析到服务器。

### 2. 配置环境变量

在仓库根目录复制模板并填写：

```bash
cp .env.example .env
```

首次启动必填（`ADMIN_*` 仅用于创建首个 super 管理员，初始化后可从 `.env` 移除）：

```ini
SITE_DOMAIN=img.example.com
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me-now      # 至少 8 位
ADMIN_FORCE_SYNC=false            # true 时强制同步已有 super 密码
DATABASE_NAME=imageshow
DATABASE_USER=imageshow
DATABASE_PASSWORD=change-me-db
```

已有 super 管理员时，启动默认不会再覆盖密码；只有显式设置 `ADMIN_FORCE_SYNC=true` 才会按环境变量强制同步。其余运行时选项在首次启动时被播种进 `data/config.json`，之后以该文件为准——完整字段与默认值见仓库根的 [`config.example.jsonc`](config.example.jsonc)。

### 3. 启动

```bash
docker compose up -d --build
```

> Linux 用 bind mount 时，先让镜像用户（UID/GID `1000`）可写数据目录：`sudo install -d -o 1000 -g 1000 data`。

启动后（下例以 `example.com` 为站点域名）：首页 `https://example.com/home`、画廊 `/gallery`、后台 `/admin`、随机图 `/random`。

### 4. 反向代理与 HTTPS

生产环境务必在可信反向代理终止 TLS，用**通配证书**覆盖 `*.example.com`，把主域名与所有子域名转发到应用的 `5518` 端口，并**覆盖**（而非透传）客户端伪造的 `X-Forwarded-*` 头：

```nginx
server {
  listen 443 ssl;
  server_name example.com *.example.com;   # 证书需覆盖通配子域名
  location / {
    proxy_pass http://127.0.0.1:5518;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

不要把应用 HTTP 端口直接暴露公网；`X-Forwarded-Proto` 缺失会导致 Secure Cookie、同源检查与跳转 URL 出错。

### 数据与配置

- **持久化**：`./data`（bind mount，含 `config.json`、`storage/` 本地图片、`log/` 日志）＋ `postgresql18_data` / `redis_data` 两个卷。数据库密码以 `0600` 权限写入配置文件，请限制宿主目录访问。
- **改配置**：后台「设置」页，或编辑 `data/config.json` 后在设置页点「读取配置文件」热加载（`database` / `redis` / `port` 等连接项仍需重启容器）。
- 内置 PostgreSQL 默认不对宿主发布端口；需直连时用 `docker exec -it imageshow-postgresql psql`。

更多方式（仅运行应用容器 + 外部数据库、升级 Redis 等）与配置 / 子域名 / 架构细节见 `docs.<域名>` 文档站，或仓库内 [`packages/docs/guide`](packages/docs/guide)。

## 许可

见 [LICENSE](LICENSE)。
