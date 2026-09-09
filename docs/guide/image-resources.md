# 主机与图片资源

应用图片统一由主站 `/images` 提供，只需主站的 DNS 与 TLS 证书。
`/api/images` 提供图片元数据，`/images` 提供图片内容，`/assets` 提供前端 JS、CSS 等构建资源。

| 图片路径 | 职责 |
| --- | --- |
| `/images/full/*` | 完整图片对象 |
| `/images/thumbs/*` | 缩略图对象 |
| `/images/original/<id>` | 始终公开、可缓存的外部 HTTPS 原图直连决策或安全代理 |

强烈建议显式设置 `site.domain`，例如 `img.example.com`；应用生成的图片根地址为
`https://img.example.com/images`，只接受该站点 Host，其他 Host 返回不可缓存的 404。
`site.domain` 可带端口，例如 `img.example.com:5518`；生成的图片地址保留该端口，使用 HTTPS。
显式域名需要使用合法 DNS 域名，不接受 IP 或单标签 `localhost`。

未设置域名时使用默认值 `example.com`；域名为空或为 `example.com` 时，应用接受格式合法的
访问 Host，图片地址使用 `/images` 同源路径，随访问地址的协议、Host 和端口解析。此基础回退
不推测根域名、不向配置、共享缓存或队列写入请求域名，可通过 DNS Host、`localhost` 或 IPv4
地址访问，支持端口。基础回退不保证所有代理或特殊主机格式可用。

主站还承担 SPA、公共与管理 API、健康检查，以及唯一随机图入口 `/random`。
图片路由仅注册表中的路径；未匹配请求由通用 HTTP 路由处理。

`full` 与 `thumbs` 提供 local 或没有公开 URL 的存储对象；S3 配置 `public_base_url` 时使用存储直链。
正常图片、后台及回收站的外部原图统一通过 `/images/original/<id>` 读取，不区分访问者身份。
此出口不读取会话或按钮开关；知道有效图片 ID 时可以直接拼接访问。ready cache 未命中时查询
PostgreSQL 的正常图片及回收站记录；没有记录或独立原图时返回 404。
无 Referer 直连可用时返回公开短缓存的 302，否则在同一请求内安全代理，使用图片源站 origin
作为 Referer。代理继承已校验的源站缓存策略，缺省使用站内 CDN fallback；GET / HEAD / 304
继续支持 URL 绑定的条件验证器，响应带 `Vary: User-Agent` 以区分直连决策。错误和失败回退不缓存。
`original` 指另行登记的外部原图，不代表站内保存了上传时的原始文件。
详细随机协议见[随机图 API](./random-api.md)，媒体生命周期见[安全说明](./security.md)。

浏览器按主站 Cookie 规则向同源图片请求发送 Cookie；公开资源处理器不读取管理员会话、
不写 Cookie，也不按 Cookie 改变响应或缓存。同源图片无需额外 CORS；外部对象存储或 CDN
的 `thumb_url` 须提供允许主站读取的 CORS 响应头，供 Show 纹理使用，公开无凭据媒体可使用
`Access-Control-Allow-Origin: *`。

`site.gallery.public_original_button` 只控制详情链接显示。关闭时，`/api/images/<id>` 校验
随请求携带的管理员会话：访客的 `original_url` 为 `null`，已登录管理员取得公开原图链接，
详情使用 `private, no-cache`。开启时不读取会话，访客同样取得链接，详情使用
`public, max-age=30, s-maxage=60`。缺少独立原图时始终返回 `null`。
详情始终带 `Vary: Cookie` 与内容 ETag，共享数据库行查询后再独立投影链接显示状态。
前端按当前认证身份隔离详情查询，只根据服务端非空链接显示按钮；资源缓存不随按钮开关失效。
