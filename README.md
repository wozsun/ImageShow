# ImageShow

[![Publish Release](https://github.com/wozsun/ImageShow/actions/workflows/publish-release.yml/badge.svg)](https://github.com/wozsun/ImageShow/actions/workflows/publish-release.yml)

ImageShow 是一个面向个人服务器的图片展示、图库管理与随机图 API 服务。它提供公开首页与瀑布流画廊、后台上传管理、本地 / S3 兼容对象存储 / WebDAV 多后端并存、Redis 随机池缓存，以及一键 Docker 部署。

## 功能

- 公开首页与画廊，可按设备、亮度、主题、标签、作者筛选，并支持最新 / 随机排序。
- 主题子域名（如 `nature.img.example.com`），以及 `random.*`、`static.*`、`link.*`、`docs.*` 四个保留子域名。
- `/random` 随机图 API，支持 `d`/`b`/`t`/`tag`/`a`/`m` 参数；`/img-count` 提供随机池统计，`random.*` 子域根路径可直接作为随机图链接。
- 后台图片上传 / 链接导入、JSONL 清单导入、公开微博导入、编辑、删除、回收站、最终 MD5 判重、日志查看与运行时设置；上传与下载队列使用单项前瞻的有界流水线，在不增加图片处理并发的前提下重叠素材传输与处理。
- URL、JSONL 与微博链接统一由服务端安全下载，经过标准化后按普通图片保存；JSONL 可为每张图指定展示时间、来源、作者、标签和其他元数据。
- 微博导入可批量输入多条公开微博，自动提取发布时间、原图链接和用户 ID，以各自微博链接作为来源、发布年份作为标签，并按配置的用户 ID → 作者 slug 映射填写作者。
- **存储多后端并存**：本地目录、S3 兼容对象存储与 WebDAV 可同时使用，每张图片记录自己所在后端，可单张或批量在后端之间迁移。
- WebP 缩略图，数据库 / 存储 / Redis 自检与存储迁移工具。

## 部署

以 Docker Compose 一键部署，自带 PostgreSQL 与 Redis。应用只监听一个端口（默认 `5518`），主域名及其全部子域名都由它按 `Host` 提供，生产环境在前置反向代理终止 HTTPS。

### 1. 准备

- 安装 Docker 与 Docker Compose。
- 仅在宿主机直接开发或构建时需要 Node.js `>=26.3.0 <27`；Docker 部署已内置 Node.js。
- 一个域名，把**主域名与其通配子域名**（`random.` / `static.` / `docs.` / `link.` 及各主题子域都走同一应用）解析到服务器。

### 2. 配置部署参数

`compose.yaml` 已为站点域名、端口、时区、数据库和 Redis 连接提供默认值，
无需创建 `.env` 也能展开完整配置。若直接编辑 Compose 文件，全新安装至少应在
`services.imageshow.environment` 中设置首次管理员用户名和密码，并在文件顶部
`x-database-settings` 中修改数据库用户名和密码；正式使用前还要把
`SITE_DOMAIN` 的默认值换成实际主域名。`TZ` 默认使用 `UTC`。

也可以复制环境变量模板覆盖这些默认值：

```bash
cp .env.example .env
```

首次启动必填（`ADMIN_*` 仅用于创建首个 super 管理员，初始化后可从 `.env` 移除）：

```ini
SITE_DOMAIN=img.example.com
ADMIN_USERNAME=admin
ADMIN_PASSWORD=                   # 必填，至少 8 位且同时包含字母和数字
DATABASE_NAME=imageshow
DATABASE_USER=imageshow
DATABASE_PASSWORD=                # 必填，请使用随机强密码
REDIS_PASSWORD=                   # 仅连接带密码的外部 Redis 时填写
```

已有 super 管理员时，启动不会再读取环境变量覆盖账号或密码；请在后台账户页面修改。
`DATABASE_*` 与 `REDIS_*` 是每次启动都读取的部署配置，必须持续由
Compose、`.env` 或 Secret 提供。内置 Redis 位于 Compose 私有网络且不设置密码；
只有连接启用了认证的外部 Redis 时才填写 `REDIS_PASSWORD`。
其余应用选项只在首次启动时播种进
`data/config.json`，之后以该文件为准——完整字段与默认值见仓库根的
[`config.example.jsonc`](config.example.jsonc)。

无法登录后台时，可在宿主机通过交互式终端重置任意管理员密码：

```bash
docker exec -it imageshow imageshow reset-password admin
```

密码只通过隐藏输入读取，不得作为命令参数传入。密码更新仅依赖
PostgreSQL；Redis 可用时会清除所有管理员登录会话，Redis 故障时密码仍会
更新并输出会话未清理警告。修改 `.env` 中的 `ADMIN_PASSWORD` 或重启容器
不会重置已有账号。源码环境可执行
`npm run admin:reset-password -- admin`。

### 3. 启动

```bash
docker compose pull
docker compose up -d
```

> Linux 用 bind mount 时，先让镜像用户（UID/GID `1000`）可写数据目录：`sudo install -d -o 1000 -g 1000 data`。

启动后（下例以 `img.example.com` 为站点域名）：首页 `https://img.example.com/home`、画廊 `/gallery`、后台 `/admin`、随机图 `/random`。

### 4. 反向代理与 HTTPS

生产环境务必在可信反向代理终止 TLS，用**通配证书**覆盖 `*.img.example.com`，把主域名与所有子域名转发到应用的 `5518` 端口，并**覆盖**（而非透传）客户端伪造的 `X-Forwarded-*` 头：

```nginx
server {
  listen 443 ssl;
  http2 on;
  server_name img.example.com *.img.example.com;   # 证书需覆盖通配子域名

  client_max_body_size 256m;

  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;

  location / {
    proxy_pass http://127.0.0.1:5518;
  }
}
```

Nginx 必须覆盖 `X-Real-IP` 和 `X-Forwarded-For`，不要使用会拼接客户端自带值的
`$proxy_add_x_forwarded_for`。前置 CDN 场景应先通过 Nginx `real_ip` 模块和受信任
节点网段恢复 `$remote_addr`，或用 CDN 保证覆盖且无法由访客伪造的来源 IP 头同时
设置这两个转发头。

反向代理的请求体上限不能低于应用内任一对应设置；当前 JSONL 解析上限为 128 MiB，批量导入会话创建上限为 256 MiB，示例使用 `client_max_body_size 256m`，若图片上传上限更高还需同步提高。否则请求会在到达应用鉴权和校验逻辑前被代理返回 413。不要把应用 HTTP 端口直接暴露公网；`X-Forwarded-Proto` 缺失会导致 Secure Cookie、同源检查与跳转 URL 出错。示例面向当前 stable Nginx 1.30.3；文档站提供可直接复制的[最少配置与推荐配置](packages/docs/guide/deployment.md#反向代理与-https)，推荐配置只增加上传流式转发和长任务超时，不在 Nginx 重复实现 Hono 的缓存策略。

### 数据与配置

- **持久化**：`./data`（bind mount，含 `config.json`、`storage/` 本地图片、`log/` 日志）＋ `postgresql18_data` / `redis_data` 两个卷。数据库与 Redis 连接只保存在部署环境或 Secret 中。
- **改配置**：应用策略可在后台「设置」页修改，或编辑 `data/config.json` 后点「读取配置文件」热加载；数据库 / Redis 连接修改 `.env` 或 Compose 后重建容器。容器内固定监听 `5518`，宿主机映射端口由 `HOST_PORT` 控制。
- 内置 PostgreSQL 默认不对宿主发布端口；需直连时用 `docker exec -it imageshow-postgresql psql`。

更多方式（仅运行应用容器 + 外部数据库、升级 Redis 等）与配置 / 子域名 / 架构细节见 `docs.<域名>` 文档站，或仓库内 [`packages/docs/guide`](packages/docs/guide)。

## 许可

见 [LICENSE](LICENSE)。
