# 安装与维护

本页写给负责服务器的人：安装、配置域名、日常维护、备份和排错。

## 准备工作

- 一台装有 Docker 和 Docker Compose 的服务器，不需要安装 Node.js。
- 对外开放时：一个域名，以及 Nginx 等反向代理和 HTTPS 证书。
- 足够的磁盘空间存放图片，另备一个备份位置。

ImageShow 由三个容器组成：应用本身、PostgreSQL 数据库和 Redis 缓存，Compose 会一起启动它们。

## 首次安装

1. 新建一个部署目录，放入仓库中的 [compose.yaml](../compose.yaml) 和 [.env.example](../.env.example)，然后复制出 `.env`：

   ```bash
   cp .env.example .env
   ```

2. 编辑 `.env`，填写两个不同的强密码和你的域名（不带 `https://` 和路径）：

   ```ini
   DATABASE_PASSWORD=
   ADMIN_USERNAME=admin
   ADMIN_PASSWORD=
   SITE_DOMAIN=img.example.com
   ```

   管理员密码 8–128 位，需同时包含字母和数字。这个账号只在第一次启动时创建，之后修改 `.env` 不会改变它。

3. 启动：

   ```bash
   docker compose pull
   docker compose up -d
   ```

   应用只监听本机的 `127.0.0.1:5518`，需要通过反向代理对外提供服务。

4. 把域名解析到服务器，按[配置域名与 HTTPS](#配置域名与-https)设置反向代理。
5. 打开 `https://img.example.com/admin`，用管理员账号登录并添加图片。

> [!TIP]
> **先在本机试用**
>
> 把 `SITE_DOMAIN` 留空，启动后直接访问 `http://127.0.0.1:5518/admin`。以后要绑定域名时，在后台「站点配置」中修改。

## 配置域名与 HTTPS

反向代理把所有请求原样转发给应用即可。以 Nginx 为例：

```nginx
server {
  listen 80;
  server_name img.example.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  http2 on;
  server_name img.example.com;

  ssl_certificate /etc/nginx/cert/fullchain.pem;
  ssl_certificate_key /etc/nginx/cert/privkey.pem;
  client_max_body_size 256m;

  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 300s;
  proxy_send_timeout 300s;

  location / {
    proxy_pass http://127.0.0.1:5518;
  }
}
```

几点说明：

- `client_max_body_size` 要大于站点允许的上传大小。示例的 256m 足够最大设置（单张图片 200 MiB、清单 128 MiB）。
- 访客 IP 用于登录和随机图的频率限制。示例用 `$remote_addr` 覆盖这两个请求头，不要直接透传访客发来的值。
- 示例使用标准 HTTPS 端口 443。使用其他端口时，主站域名设置和转发的 Host 都必须包含实际端口，并相应调整监听及跳转地址。
- Nginx 也运行在同一 Compose 网络中时，上游可以写成 `http://imageshow:5518`。
- 想让大文件上传边传边处理，可以为 `/api/admin/ingestion/` 单独加一个 location，设置 `proxy_request_buffering off`，其余配置相同。

需要独立图片域名或 CDN 时，见[进阶部署](#进阶部署)。

## 日常维护

### 常用命令

在部署目录执行：

```bash
docker compose ps                         # 查看状态
docker compose logs --tail 100 imageshow  # 查看最近日志
docker compose stop imageshow             # 停止应用
docker compose up -d imageshow            # 启动应用
```

修改 `.env` 后，执行 `docker compose up -d` 重新创建容器才会生效。注意站点设置只在第一次启动时从环境变量生成，之后以配置文件 `data/config.json` 为准；直接修改这个文件后，在后台「站点配置」点击「读取配置文件」或重启应用。

> [!CAUTION]
> **不要删除数据卷**
>
> 不要用 `docker compose down -v` 停止服务，也不要用 `docker system prune` 之类的命令清理；它们可能删除数据。普通停机用 `stop` 即可。

### 升级

1. 阅读新版本的 [Release 说明](https://github.com/wozsun/ImageShow/releases)，确认是否需要手动处理数据库。
2. [备份](#备份与恢复)。
3. 拉取新镜像并重启：

   ```bash
   docker compose pull
   docker compose up -d
   ```

4. 确认容器状态为 `healthy`，登录后台，抽查图片能否打开。

应用启动时只检查已有数据库结构，不会自动修改；检查不通过时应用不会就绪，原因见日志。

### 定期检查

- 站点能打开，图片能显示，管理员能登录。
- 服务器剩余磁盘空间。
- 后台「检查」页没有异常。
- 备份按计划完成，并定期试着恢复一次。

## 备份与恢复

### 数据存在哪里

| 部署目录下 | 内容 |
| --- | --- |
| `data/` | 配置文件、本地存储的图片、自定义静态资源、日志、临时文件 |
| `postgres/` | 数据库：图片信息、分类、账号、存储设置 |
| `redis/` | 缓存、登录状态、未完成的上传和导入任务 |

使用云端存储时，那部分图片在服务商处，需要单独备份。只备份图片文件不够：分类、账号和设置都在数据库里。

### 备份步骤

1. 提前通知使用者，让管理员完成正在进行的上传和导入。
2. 停止应用：`docker compose stop imageshow`。
3. 备份数据库（可用 `pg_dump`，或停止数据库容器后复制 `postgres/` 目录）、`data/` 目录和云端存储中的图片；`redis/` 可一并备份。
4. 启动应用，确认一切正常。

### 恢复

- 数据库、配置和图片要来自**同一时间点**的备份，混用会导致图片和记录对不上。
- 最好先在另一个环境恢复，核对图片数量（包括回收站）和图片能否打开，再替换正式环境。
- 永久删除的图片文件，只恢复数据库是找不回来的，必须同时恢复图片文件。
- 手动修改过数据库中的存储设置后，需要重启应用。

Redis 只保存派生和临时数据。即使它的数据丢失，已入库的图片和设置也不受影响，只是管理员需要重新登录，未完成的上传和导入需要重新添加。

## 常见问题

先记下页面提示和发生时间，然后查看状态和日志：

```bash
docker compose ps
docker compose logs --tail 100 imageshow
```

| 现象 | 可能原因与处理 |
| --- | --- |
| 容器不是 `healthy` | 看日志中的错误。镜像给启动留出 30 秒宽限；机器较慢时，在 `compose.yaml` 的 `imageshow` 服务下添加 `healthcheck`，只设置更长的 `start_period`（如 `120s`），其余参数沿用镜像设置 |
| 网页打不开，返回 502 | 应用未启动或代理上游地址写错；确认应用容器在运行、代理指向 `127.0.0.1:5518` |
| 用域名访问返回 404 | 访问的域名与 `SITE_DOMAIN` 或后台设置的主站域名不一致 |
| 提示 `redis_unavailable` | Redis 未运行或连不上。应用刚启动、尚未完成 Redis 校验时，业务请求返回 503；成功启动后 Redis 短暂中断，部分公开浏览仍可用，后台和需要限流的随机图请求需等它恢复。应用会自动重连 |
| 图片显示不出来 | 到后台「检查」页查看存储状态；使用云端存储时确认网络和密钥 |
| 上传大文件失败 | 代理的 `client_max_body_size` 或超时设置太小 |

服务恢复后，再到「检查」页确认数据是否完整。发现文件缺失时，先不要做清理操作，核对备份后再处理。

## 忘记管理员密码

能登录时，在后台「账户」页修改。无法登录时，在服务器上执行：

```bash
docker exec -it imageshow imageshow reset-password <用户名>
```

按提示输入新密码。成功后会清除所有管理员的登录会话。如果提示 Redis 会话清理失败，目标账号的旧会话仍会失效，但其他管理员的会话尚未清除；等 Redis 恢复后重新执行命令。

## 进阶部署

### 使用外部数据库或 Redis

支持 PostgreSQL 18 和 Redis 8。一个数据库只能对应一个应用实例。示例：

```bash
docker run -d --name imageshow --restart unless-stopped \
  -p 127.0.0.1:5518:5518 \
  -e SITE_DOMAIN=img.example.com -e TZ=UTC \
  -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD="${ADMIN_PASSWORD:?}" \
  -e DATABASE_HOST=db.example.internal -e DATABASE_NAME=imageshow \
  -e DATABASE_USER=imageshow -e DATABASE_PASSWORD="${DATABASE_PASSWORD:?}" \
  -e REDIS_HOST=redis.example.internal \
  -v /srv/imageshow/data:/app/data \
  wozsun/imageshow:latest
```

- 全部环境变量见[配置参考](CONFIG.md#环境变量)。使用 Compose 时，`.env` 中新增的变量还要在 `compose.yaml` 的 `environment` 中写上才会生效。
- Redis 请给 ImageShow 单独使用一个逻辑库（`REDIS_DB`），不要与其他程序共用。
- 外部 Redis 需要密码时使用 `REDIS_PASSWORD`。
- 数据库账号需要对应用使用的表有 `SELECT`、`INSERT`、`UPDATE`、`DELETE` 权限，初始化空数据库时还需要建表权限。外部 PostgreSQL 需要支持 `client_connection_check_interval`。
- 空数据库会在一个事务中自动初始化。已有数据的数据库只做只读检查，结构调整按 Release 说明处理。额外的表、列和索引会被忽略。

### 独立图片与静态资源域名

- 本地存储的图片可以使用独立域名，在「存储管理」中编辑本地存储的「公开 URL」。这个域名只提供三档图片，不提供页面、API 或原图；修改地址不会移动文件。
- 前端静态文件可以使用独立域名，见配置项 [site.assets_base_url](CONFIG.md#静态资源地址)。

这些域名同样需要证书和反向代理，代理到 ImageShow 并保留 Host、完整路径和路径前缀。

### 使用 CDN

CDN 可以加速图片和静态文件，但需要遵守以下规则，否则可能泄露原图或让防盗链失效：

- 保留完整的查询参数，遵守应用返回的缓存头，不要强制缓存或改写内容。
- 应用自己负责压缩：保留 `Accept-Encoding`，原样传递编码、长度和缓存相关的响应头。
- 页面 HTML 由应用动态生成，不能交给 CDN 或代理当静态文件托管。
- `/random` 不能缓存。
- 保留应用的 `Access-Control-Allow-Origin` 和 `Access-Control-Expose-Headers`，并允许 `OPTIONS` 预检到达应用；不要重复添加冲突的 CORS 头。随机图和三档公开图片允许匿名跨站读取，具体用法见[随机图 API](api/random.md#跨站读取)。
- 登录和 `/random` 的频率限制按访客 IP 计算。CDN 回源时 `$remote_addr` 是 CDN 节点地址，需要先用 Nginx 的 `set_real_ip_from`（填 CDN 回源地址段）和 `real_ip_header`（填 CDN 提供的访客 IP 请求头）恢复访客 IP，再覆盖 `X-Real-IP` 和 `X-Forwarded-For`。不要让所有访客共用 CDN 节点的 IP，也不要透传访客自己发来的 IP 头。
- 原图 `/images/original/*` 只允许管理员访问：必须透传登录 Cookie，遵守 `private, no-cache`。
- 图片防盗链按 Referer 判断：必须透传 Referer，并按 `Vary: Referer` 区分缓存；不支持的 CDN 需要在边缘实现相同规则。

修改站点设置、收紧防盗链或原图访问后，CDN 不会自动更新，需要手动清理对应缓存（原图相关的还包括 `/api/images/*`）。另外要注意：

- 已经被下载或缓存在浏览器中的内容无法收回。
- 直接访问 CDN 或云存储源站的请求不经过应用检查。
- 云端存储或独立 CDN 的 small 图片需要允许主站匿名跨域读取，展映页才能正常加载；向其他网站提供三档图片的跨站 fetch 时，对应档位也需要 CORS。公开图片可使用 `Access-Control-Allow-Origin: *`，仍需单独设置该服务的防盗链规则。

### 更换数据目录

先停止应用和数据库，完整复制原目录并保留一份副本，再修改挂载路径。数据库目录只能在数据库停止时复制。不要把空目录挂到已有实例上。

### 清空 Redis

一般不需要。确实要清空时：先停止应用并备份，确认可以丢弃登录状态和未完成的上传、导入任务，核对 Redis 地址和 `REDIS_DB` 后，只对该逻辑库执行 `FLUSHDB`。不要在应用运行时清空或删除部分数据。

### 容器安全选项

镜像会先整理数据目录权限，再以普通用户 `node` 运行应用。如果希望进一步禁止进程提权，可以在 Compose 中为应用加上 `security_opt: ["no-new-privileges:true"]`，说明见 [Docker 文档](https://docs.docker.com/reference/cli/docker/container/run/#optional-security-options---security-opt)。
