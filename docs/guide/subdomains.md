# 主机与资源子域

应用通过 `Host` 头只接受主站域名和一个静态资源子域。反向代理与 TLS 证书只需覆盖
`img.example.com` 及 `static.img.example.com`；静态前缀可由
`site.static_subdomain` 修改：

- `img.example.com`：SPA、公共与管理 API、健康检查，以及唯一的随机图入口
  `/random`。随机查询参数和返回方式见[随机图 API](./random-api.md)。
- `static.img.example.com`：与主站 Cookie 隔离的资源域。`/media/*` 与
  `/thumbs/*` 提供本地或无公开 URL 存储的图片字节；`/link/original/<id>` 为详情页中
  不同于展示图的 HTTPS 原图提供安全代理回退。代理请求使用图片源站 origin 作为
  Referer，成功响应优先继承源站 `Cache-Control` / `Expires`，源站未声明时使用站内
  CDN fallback（浏览器 1 天、共享缓存 1 年、回源失败可用旧副本 30 天）。

静态资源域只开放上述精确路径和可选的 `/robots.txt`，不会提供 SPA、API 或随机图。
随机、外链和主题均没有专用子域；除主站与配置的静态资源子域外，其他 Host 全部返回
不可缓存的 404。若 `site.domain` 直接配置为 `example.com`，资源域就是
`static.example.com`；需要使用可解析的真实 DNS 域名，不应使用 `localhost`。
