# 单容器与反向代理

## 单容器 + 外部数据库

也可只运行 ImageShow 容器并连接外部 PostgreSQL/Redis：

```bash
docker run --rm -p 5518:5518 \
  -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD='replace-this-password' \
  -e POSTGRES_HOST=db.example.internal -e POSTGRES_DB=imageshow \
  -e POSTGRES_USER=imageshow -e POSTGRES_PASSWORD='replace-this-db-password' \
  -e REDIS_HOST=redis.example.internal \
  -v /srv/imageshow/data:/app/data \
  your-user/imageshow:latest
```

应用数据统一落在 `/app/data` 下（`config.json` 配置文件、`storage/` 本地图片、`log/` 日志），因此只需挂载这一个目录。数据库密码会以 `0600` 权限写入配置文件，请限制宿主机目录访问。

## 反向代理与 HTTPS

生产环境务必在可信反向代理终止 TLS，并**覆盖**而不是透传客户端伪造的转发头。把站点域名与其所有子域名（含 `random` / `static` / `docs` / `link` / 主题）都转发到应用的 `5518` 端口：

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

不要把应用 HTTP 端口直接暴露到公网。若 `X-Forwarded-Proto` 缺失或错误，Secure Cookie、同源检查与生成的跳转 URL 都会不正确。上传的图片一律由浏览器同源 PUT 到应用（再由应用流式写入本地或 S3），依赖管理员会话 Cookie 与 `X-CSRF-Token` 鉴权；浏览器不直连对象存储上传，因此存储桶无需配置 CORS。
