# ImageShow

ImageShow 是一个面向个人服务器的图片展示、图库管理与随机图 API 服务。它提供公开首页与瀑布流画廊、后台上传管理、本地与 S3 兼容对象存储（多后端并存）、Redis 随机池缓存，以及一键 Docker 部署。

## 功能

- 公开首页与画廊，可按设备、亮度、主题筛选。
- 主题子域名（如 `nature.img.example.com`），以及 `random.*`、`static.*` 两个保留子域名（详见「子域名」）。
- `/random` 随机图 API，支持 `d`/`b`/`t`/`m` 参数；`/img-count` 提供随机池统计。
- 后台图片上传、编辑、删除、回收站、重复 MD5 检查。
- **存储多后端并存**：本地目录与 S3 兼容对象存储可同时使用，每张图片记录自己所在后端，可单张或批量在后端之间迁移。
- WebP 缩略图，数据库 / 存储 / Redis / CORS 自检与存储迁移工具。

## 快速开始（Docker Compose）

需要已安装 Docker。在仓库根目录复制环境变量模板并修改其中的值：

```bash
cp .env.example .env
docker compose up -d --build
```

首次启动必须在 `.env` 中提供：

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me-now
POSTGRES_DB=imageshow
POSTGRES_USER=imageshow
POSTGRES_PASSWORD=change-me-db
```

`ADMIN_USERNAME` / `ADMIN_PASSWORD` 仅在数据库尚无管理员时用于创建首个账号（最终以用户名 + Argon2id 密码哈希保存到数据库），初始化完成后即可从 `.env` 移除。

应用默认监听 `5518` 端口，由反向代理对外提供 HTTPS（见「反向代理与 HTTPS」）。以站点域名访问（下例以 `example.com` 为站点域名）：

- 首页：`https://example.com/home`
- 画廊：`https://example.com/gallery`
- 后台：`https://example.com/admin`
- 随机图：`https://example.com/random`

应用镜像以 UID/GID `1000` 运行。Linux 使用 bind mount 前，先让该用户可写入持久化目录：

```bash
sudo install -d -o 1000 -g 1000 data/config data/storage
```

升级 Redis 镜像后：

```bash
docker compose pull redis
docker compose up -d --build --force-recreate
```

## 配置说明

配置按持久化位置分为三类：

1. **数据库**：管理员账号；S3 的 endpoint/region/bucket/access key/secret key/根目录/public URL 等存储配置。secret key 由数据库持久化，不会返回给前端（管理页只显示「已配置」），请限制数据库与配置目录访问。
2. **配置文件** `/app/config/config.json`：站点名 / 域名 / icon / 根路径跳转、监听端口、PostgreSQL 与 Redis 连接、上传与画廊参数、随机图默认模式等非敏感项。
3. **环境变量**：仅在配置文件**首次生成**时读取；此后修改配置请使用后台设置页，或编辑配置文件后在设置页点击「读取配置文件」热加载（数据库 / Redis / 端口等连接类配置仍需重启容器）。部分进阶项（首页预览延迟、S3 预签名有效期、概览「最近上传」数量）只在配置文件中调整。

首次生成配置文件的常用可选变量（括号内为默认值）：`APP_DOMAIN`(example.com，请改为你的真实域名)、`SITE_NAME`(ImageShow)、`PORT`(5518)、`REDIS_HOST`(redis)、`UPLOAD_MAX_FILE_SIZE_MB`(15)、`GALLERY_DEFAULT_LIMIT`(50)、`RANDOM_DEFAULT_METHOD`(redirect) 等，完整列表见 `.env.example`。

## 单容器 + 外部数据库

也可只运行 ImageShow 容器并连接外部 PostgreSQL/Redis：

```bash
docker run --rm -p 5518:5518 \
  -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD='replace-this-password' \
  -e POSTGRES_HOST=db.example.internal -e POSTGRES_DB=imageshow \
  -e POSTGRES_USER=imageshow -e POSTGRES_PASSWORD='replace-this-db-password' \
  -e REDIS_HOST=redis.example.internal \
  -v /srv/imageshow/config:/app/config -v /srv/imageshow/storage:/app/storage \
  your-user/imageshow:latest
```

配置文件生成后，后续容器只需挂载同一个 `/app/config`。数据库密码会以 `0600` 权限写入配置文件，请限制宿主机目录访问。

## 反向代理与 HTTPS

生产环境务必在可信反向代理终止 TLS，并**覆盖**而不是透传客户端伪造的转发头。把站点域名与其所有子域名（含 `random` / `static` / 主题）都转发到应用的 `5518` 端口：

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

不要把应用 HTTP 端口直接暴露到公网。若 `X-Forwarded-Proto` 缺失或错误，Secure Cookie、同源检查与生成的跳转 URL 都会不正确。本地存储的图片由浏览器同源 PUT 到应用，依赖管理员会话 Cookie 与 `X-CSRF-Token` 鉴权；S3 预签名 URL 由浏览器直连对象存储，不应经过应用反代或其 access log。

## 子域名

应用通过 `Host` 头区分子域名，反向代理只需把 `img.example.com` 与 `*.img.example.com` 都转发到应用即可（无需为子域名编写额外规则），并确保 TLS 证书覆盖通配子域名：

- `<主题>.img.example.com`：对应主题的画廊，例如 `nature.img.example.com`。
- `random.img.example.com`：等价于 `img.example.com/random`，可携带 `d`/`b`/`t`/`m` 查询参数，适合直接作为随机图链接分发。
- `static.img.example.com`：本地存储图片的独立资源域名（与主站 Cookie 隔离、单独缓存策略）。本地图片的公开链接会自动指向该域名；`/media`、`/thumbs` 对象字节仅在该域名提供，主站与主题域名不暴露这些路径。

若站点直接使用二级域名（`site.domain` 配为 `example.com`），上述保留子域名相应变为 `random.example.com`、`static.example.com`、`<主题>.example.com`。`static.*` 需要站点为可解析通配子域名的真实域名（本地存储图片依赖该子域名提供，请勿使用 `localhost`）。`random` / `static` 这两个保留前缀本身也可在配置文件中通过 `site.random_subdomain` / `site.static_subdomain` 改名。

## 存储：本地 / S3，多后端并存

在后台「设置 → 存储」选择存储类型并配置：

- **本地存储**：无需额外配置，图片保存在容器的存储目录。
- **S3 兼容存储**：填写 endpoint、region、bucket、access key、secret key、根目录与公开访问域名（public base URL），可点击「设为默认上传位置」。

两种后端可同时存在：每张图片记录自己所在的后端，读取、缩略图与删除都按该图自身的后端解析。在**图片编辑窗口**可把单张图迁移到另一后端，在**批量编辑窗口**可批量迁移。浏览器直传要求存储桶 CORS 允许站点 Origin、`PUT`/`GET`/`HEAD` 方法及 `Content-Type`、`Content-MD5` 请求头（或使用通配 `*`）；后台检查页可验证 CORS。

S3 直传默认开启上传完整性校验：服务端把图片 MD5 以 `Content-MD5` 头签入预签名 PUT，对象存储据此校验收到的字节，不一致则以 `BadDigest` 拒绝（前端会提示重试）。该校验需要上面的 CORS 允许 `Content-MD5` 头；如某后端无法放行，可在配置文件中将 `upload.verify_content_md5` 设为 `false` 关闭。

## 随机图 API

`GET /random` 从随机池中按各分类的图片数量加权选取一张图片：

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `d` | `pc` / `mb` / `r` | 设备，缺省按 User-Agent 推断，`r` 强制随机 |
| `b` | `dark` / `light` | 亮度，缺省两者皆可 |
| `t` | 逗号分隔主题 | 缺省全部；`t=a,b` 为包含，`t=!a,!b` 为排除，二者不可混用 |
| `m` | `proxy` / `redirect` | 返回方式，缺省取设置页配置的默认值 |

`m=proxy` 直接回源图片字节并附带 `X-Image-Info` 头；`m=redirect` 返回 302 跳转到图片的公开 URL。`GET /img-count` 返回随机池的分组与主题统计（不接受任何查询参数）。随机图也可直接通过 `random.<域名>` 访问（见「子域名」）。

## 安全

- 管理会话存于 Redis，Cookie 为 `HttpOnly` + `SameSite=Lax`，识别为 HTTPS 时附加 `Secure`；所有写操作要求 `X-CSRF-Token` 并校验同源。
- 登录失败限流：每 IP + 用户名 15 分钟 10 次，叠加 60 秒 30 次的全局兜底。
- 全站响应头包含 `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Cross-Origin-Opener-Policy` 与 CSP。

## 许可

见 [LICENSE](LICENSE)。
