# 单容器与反向代理

## 单容器 + 外部数据库

也可只运行 ImageShow 容器并连接外部 PostgreSQL/Redis：

```bash
docker run --rm -p 5518:5518 \
  -e SITE_DOMAIN=img.example.com -e TZ=UTC \
  -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD="${ADMIN_PASSWORD:?set ADMIN_PASSWORD first}" \
  -e DATABASE_HOST=db.example.internal -e DATABASE_NAME=imageshow \
  -e DATABASE_USER=imageshow -e DATABASE_PASSWORD="${DATABASE_PASSWORD:?set DATABASE_PASSWORD first}" \
  -e REDIS_HOST=redis.example.internal \
  -v /srv/imageshow/data:/app/data \
  wozsun/imageshow:latest
```

应用数据统一落在 `/app/data` 下（`config.json` 应用配置、`storage/` 本地图片、
`log/` 日志），因此只需挂载这一个目录。PostgreSQL / Redis 连接只从容器环境或
Secret 读取，不会写入 `config.json`。
外部 Redis 需要密码时额外传入 `REDIS_PASSWORD`；留空或省略表示使用无密码连接。

## 管理员密码恢复

首次安装时，`ADMIN_USERNAME` / `ADMIN_PASSWORD` 只在数据库没有 super
管理员时创建首个账号。正常情况下应登录后台修改自己的密码；修改
`.env` 或重启容器不会覆盖数据库中的已有密码。

无法登录后台时，在宿主机执行：

```bash
docker exec -it imageshow imageshow reset-password <username>
```

命令会在交互式终端中隐藏读取并二次确认新密码，不接受明文密码参数。
密码更新只依赖 PostgreSQL；Redis 可用时会清除全部管理员会话，旧密码
立即失效，所有管理员需要重新登录。源码环境可使用：

```bash
npm run admin:reset-password -- <username>
```

命令使用与主服务相同的 `DATABASE_*` / `REDIS_*` 部署环境。Redis 故障
不会阻止密码更新，命令会输出警告；由于旧会话可能在 Redis 恢复后继续
有效，应在 Redis 恢复后清空 `imageshow:session:*`，或使用相同新密码
重新运行密码重置命令。用户不存在、密码不符合规则或 PostgreSQL 更新
失败时会返回非零退出码。

## 反向代理与 HTTPS

生产环境务必在可信反向代理终止 TLS，并**覆盖**而不是透传客户端伪造的转发头。把站点域名与其所有子域名（含 `random` / `static` / `docs` / `link` / 主题）都转发到应用的 `5518` 端口。

ImageShow 已由 Hono 处理 Redis 数据缓存、HTTP 缓存头、压缩、静态预压缩、ETag、304 和图片 Range；Nginx 无需再配置 `proxy_cache`。如果以后接入 CDN，让 CDN 直接遵循 Hono 返回的 `Cache-Control` 和 `Vary` 即可。

### 最少配置

以下示例面向当前 stable Nginx 1.30.3，直接使用其默认 HTTP/1.1 与上游 keepalive。最少配置保留 TLS、HTTP/2、上传大小和必要的转发头；Nginx 使用默认缓冲与超时。

```nginx
server {
  listen 80;
  server_name img.example.com *.img.example.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  http2 on;
  server_name img.example.com *.img.example.com;

  ssl_certificate /etc/nginx/cert/fullchain.pem;
  ssl_certificate_key /etc/nginx/cert/privkey.pem;

  # 覆盖部分请求体的 256 MiB 应用上限
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

### 推荐配置

推荐长期使用。它只在最少配置上为上传流、导入处理、SSE 和存储检查调整缓冲或超时，不接管 Hono 的缓存策略。

```nginx
server {
  listen 80;
  server_name img.example.com *.img.example.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  http2 on;
  server_name img.example.com *.img.example.com;

  ssl_certificate /etc/nginx/cert/fullchain.pem;
  ssl_certificate_key /etc/nginx/cert/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;

  # 覆盖 batch-create 的 256 MiB 应用上限；JSONL 上限为 128 MiB。
  client_max_body_size 256m;

  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;

  location /api/admin/imports/ {
    proxy_pass http://127.0.0.1:5518;
    proxy_request_buffering off;
    proxy_read_timeout 300s;
  }

  location /api/admin/check/ {
    proxy_pass http://127.0.0.1:5518;
    proxy_read_timeout 300s;
  }

  location / {
    proxy_pass http://127.0.0.1:5518;
  }
}
```

不要把应用 HTTP 端口直接暴露到公网。应用依次读取 Nginx 覆盖后的
`X-Real-IP`、`X-Forwarded-For` 首项，并在两者都缺失时使用 `unknown`；这些头只在
反向代理完整覆盖时可信。示例故意把两个来源头都设置为 `$remote_addr`，不要使用
会把访客自带值拼入链路的 `$proxy_add_x_forwarded_for`。前置 CDN 场景应通过
Nginx `real_ip_header` 与受信任 CDN 节点的 `set_real_ip_from` 恢复真实
`$remote_addr`；也可以使用 CDN 保证删除访客同名头后重新写入的来源 IP 头，但必须
同时覆盖传给应用的 `X-Real-IP` 和 `X-Forwarded-For`。

若 `X-Forwarded-Proto` 缺失或错误，Secure Cookie、同源检查与生成的跳转 URL 都会
不正确。Docker Compose 部署时，把示例中的 `127.0.0.1:5518` 改为 Compose 服务名，
例如 `imageshow:5518`。反向代理的请求体上限不能低于应用内任一对应设置，否则
请求会在到达应用鉴权和校验逻辑前被代理返回 413；修改
`upload.max_file_size_mb` 或其他请求体上限时，应同步调整
`client_max_body_size`。当前 JSONL 固定应用边界为 128 MiB，`batch-create` 为
256 MiB；最大值仍是 256 MiB，因此示例取 256m。若把单文件上传上限调得更高，
代理值也必须随之提高。

当前支持单应用实例的停机部署，不支持多个应用实例滚动写入。Redis 中的随机池和业务缓存具备分布式锁 / revision 保护，但 storage backend 注册表与 driver 使用进程内 TTL 缓存，没有跨实例失效协议；更新部署时先停止运行中的实例，再启动新实例。

浏览器同源 PUT 的原始图片先写入容器 `data/tmp`，服务端 prepare 完成后才向选定后端写入候选文件；请求依赖管理员会话 Cookie 与 `X-CSRF-Token`，浏览器不直连对象存储，因此存储桶无需配置 CORS。
