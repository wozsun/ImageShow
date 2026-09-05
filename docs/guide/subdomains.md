# 主机与资源出口

`site.static_subdomain` 默认是空字符串，资源使用主站 `/static` 子路径，只需主站的 DNS 与 TLS 证书。
填写非空的小写 DNS label（例如 `static` 或 `assets`）则使用独立资源子域。两种模式互斥：

| 配置示例 | 资源根地址 | 公开资源路径 |
| --- | --- | --- |
| `site.domain: "img.example.com"`，`static_subdomain: ""`（默认） | `https://img.example.com/static` | `/static/full/*`、`/static/thumbs/*`、`/static/link/<id>` |
| `site.domain: "img.example.com"`，`static_subdomain: "static"` | `https://static.img.example.com` | `/full/*`、`/thumbs/*`、`/link/<id>` |

主站承担 SPA、公共与管理 API、健康检查，以及唯一随机图入口 `/random`。
独立资源子域仅开放表中的资源路径和可选 `/robots.txt`，不提供 SPA、API 或随机图。
主站根级 `/full/*`、`/thumbs/*`、`/link/*` 不开放；`/static` 也不会转入 SPA 或管理 API。
子路径模式只接受主站 Host，非空子域模式关闭主站 `/static/*`，其余 Host 一律返回不可缓存的 404。

`full` 与 `thumbs` 提供 local 或没有公开 URL 的存储对象；已有 S3 `public_base_url` 的直链保持不变。
外部原图通过当前资源根下的 `/link/<id>` 入口读取：一次图片解析后，无 Referer 直连可用时
返回不可缓存的 302，否则在同一请求内安全代理。代理使用图片源站 origin 作为 Referer，继承已校验
源站缓存策略或使用站内 CDN fallback；回收站的外部原图仍只允许鉴权后的管理入口读取。
详细随机协议见[随机图 API](./random-api.md)，媒体生命周期见[安全说明](./security.md)。

同源 `/static` 模式下，浏览器会按主站 Cookie 规则发送 Cookie，不具备独立资源域的浏览器隔离。
公开资源处理器不读取管理员会话、不写 Cookie，也不按 Cookie 改变响应或缓存；不增加 Cookie
改写或另一套认证。独立资源子域与外部 CDN 的 `thumb_url` 仍须提供允许主站读取的 CORS 响应头，
供 Show 纹理使用；公开无凭据媒体可使用 `Access-Control-Allow-Origin: *`。同源资源不需要额外 CORS。

可在高级配置编辑器中设置 `site.static_subdomain`；首次启动也可用 `SITE_STATIC_SUBDOMAIN`。
环境变量显式空值会原样播种。启动与手动重载沿用当前配置归一化：缺失字段补为空值，合法的已配置
子域原样保留；不按版本判断或迁移。热加载后新请求及新生成 URL 使用当前模式，不保留另一模式的
转发入口。`site.domain` 可带端口，例如 `img.example.com:5518`；资源地址保留该端口，仍使用 HTTPS。
需要使用合法 DNS 域名，不接受 IP 或单标签 `localhost`。
