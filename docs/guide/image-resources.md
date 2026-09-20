# 主机与图片资源

应用图片默认由主站 `/images` 提供。本地存储可配置独立公开 URL，由 ImageShow 识别其 Host 并直接读取本地对象。
`/api/images` 提供图片元数据，`/images` 提供图片内容，`/assets` 提供前端 JS、CSS 等构建资源。

| 图片路径 | 职责 |
| --- | --- |
| `/images/full/*` | 完整图片对象 |
| `/images/thumbs/*` | 缩略图对象 |
| `/images/original/<id>` | 仅管理员可访问的外部 HTTPS 原图直连决策或安全代理 |

强烈建议显式设置 `site.domain`，例如 `img.example.com`；应用生成的图片根地址为
`https://img.example.com/images`。主站 Host 提供完整站点，本地图片与静态资源公开 Host 只开放各自的资源，其余 Host 返回不可缓存的 404。
`site.domain` 可带端口，例如 `img.example.com:5518`；生成的图片地址保留该端口，使用 HTTPS。
显式域名需要使用合法 DNS 域名，不接受 IP 或单标签 `localhost`。

未设置域名时使用默认值 `example.com`；域名为空或为 `example.com` 时，应用接受格式合法的
访问 Host，图片地址使用 `/images` 同源路径，随访问地址的协议、Host 和端口解析。此基础回退
不推测根域名、不向配置、共享缓存或队列写入请求域名，可通过 DNS Host、`localhost` 或 IPv4
地址访问，支持端口。基础回退不保证所有代理或特殊主机格式可用。

主站还承担 SPA、公共与管理 API、健康检查，以及唯一随机图入口 `/random`。
图片路由仅注册表中的路径；未匹配请求由通用 HTTP 路由处理。

## 轻量 Referer 防盗链

主站 `/images/full/*`、`/images/thumbs/*` 与本地存储独立公开 URL 的 GET / HEAD
在对象读取、跳转、Range 和条件请求处理前检查 Referer：

- 空 Referer 放行，兼容直接访问和页面现有的 `no-referrer` 图片加载。
- 放行本站 HTTPS origin 及同端口子域，以及 `embed.allowed_origins` 中的精确或通配来源；
  此策略不受 `embed.enabled` 控制。未设置实际站点域名时只隐式允许当前请求同源。
- 其他或格式非法的非空 Referer 返回 `403 image_referer_forbidden`，错误不缓存。

域名由 URL 解析后匹配，通配符要求点分隔的子域边界且不包含根域，不向上推导父域。
响应增加 `Vary: Referer`，成功响应继续使用原有缓存和验证器；本地图片 CORS 预检保持可用，
实际 GET / HEAD 仍执行校验。外部原图继续由管理员会话保护，静态资产不执行此校验。
`/random` 的 proxy 使用独立的[频次规则](random-api.md#请求频次与白名单)。

这里只约束到达 ImageShow 的请求，不配置 S3 / COS 或外部 CDN；对象存储直链不经过应用。
共享缓存须遵守 `Vary: Referer`，忽略此头的 CDN 命中不会执行源站校验，需部署方在边缘
执行对应规则或正确区分缓存。启用规则及收紧白名单后须清理相应既存共享缓存；已下载或
浏览器已缓存的内容不能撤回。允许空 Referer 意味着调用方可以主动省略来源绕过防盗链。

## 图片寻址与外部原图

主站 `full` 与 `thumbs` 按图片当前所属存储寻址；后端未配置公开 URL 时直接返回对象，配置后 302 到公开 URL。
生成给页面和随机 JSON / 跳转的图片链接直接使用后端公开 URL；随机 proxy 继续由主站读取后端对象。
正常图片及回收站的外部原图统一通过 `/images/original/<id>` 读取。GET / HEAD 均先校验
管理员会话，图片管理员与超级管理员均可访问；未登录或会话失效返回不可缓存的 401，
不读取图片记录、不探测或抓取源图。ready cache 未命中时查询 PostgreSQL 的正常图片及
回收站记录；没有记录或独立原图时返回 404。
无 Referer 直连可用时返回 302，否则在同一请求内安全代理，使用图片源站 origin 作为 Referer。
直连及代理成功响应使用 `private, no-cache`，只允许浏览器私有保存且每次访问须重新校验身份；
不继承源站的公开缓存策略。GET / HEAD / 304 继续支持 URL 绑定的条件验证器，响应带
`Vary: Cookie, User-Agent`。错误和失败回退不缓存。
`original` 指另行登记的外部原图，不代表站内保存了上传时的原始文件。
详细随机协议见[随机图 API](./random-api.md)，媒体生命周期见[安全说明](./security.md)。

## 本地存储公开 URL

超级管理员在本地存储编辑弹窗设置 `public_base_url`，完整图与缩略图共用一个 HTTPS 根地址，
可包含路径前缀；留空使用主站图片地址。公开 Host 必须与主站 Host 区分，地址不能包含凭据、查询参数或片段。
例如配置 `https://images.example.com/pictures` 后，生成 `/pictures/full/<对象键>` 与 `/pictures/thumbs/<对象键>`。
请求保留该 Host 和路径到达 ImageShow 即可，无需把回源 Host 改成主站；内部连接可使用 HTTP。

此入口只读取本地正式图片对象，不查询图片当前存储位置，不转读其他后端，也不跳转回公开 URL。
本地对象缺失返回 404；数据库位置已迁出但旧本地对象尚未清理时仍可读取，清理后返回 404。
图片正式入库仍以 PostgreSQL 提交为准。专属 Host 不开放 SPA、业务 API、外部原图、临时文件或目录枚举。

直接读取复用现有图片响应：GET / HEAD、Range / If-Range、ETag / Last-Modified 与 304；成功图片使用
`public, max-age=31536000, immutable`，错误不缓存。ETag 从文件元信息生成，不包含 Host，也不读取整张图片计算哈希；
304 仍打开文件并读取元信息。公开入口提供无凭据 CORS，允许展映读取完整图与缩略图。

保存后应用生成地址和 Host 识别采用新配置，清空后回退主站，不保留旧 Host 别名；已有浏览器 / CDN 缓存不自动清除。
设置持久化在本地存储记录，配置包仍不导出或覆盖 local。修改公开地址不搬文件、不重建 driver；停用 local 只限制写入。
图片入口省略每图 Redis / PostgreSQL 位置查询，仍受现有应用可用性边界约束。

浏览器按主站 Cookie 规则向同源图片请求发送 Cookie；公开资源处理器不读取管理员会话、
不写 Cookie，也不按 Cookie 改变响应或缓存。同源图片无需额外 CORS；外部对象存储或 CDN
的 `thumb_url` 须提供允许主站读取的 CORS 响应头，供 Show 纹理使用，公开无凭据媒体可使用
`Access-Control-Allow-Origin: *`。

## 原图按钮与详情

公开画廊、展映及其嵌入页的详情只向已登录管理员显示原图按钮，后台详情继续保留同一入口。
`/api/images/<id>` 校验随请求携带的管理员会话：访客的 `original_url` 为 `null`，
已登录管理员在存在与展示图不同的合法 HTTPS 原图时取得访问链接。
详情统一使用 `private, no-cache`、`Vary: Cookie` 与内容 ETag；共享数据库行读取后按各请求身份
独立投影，避免管理员链接进入访客结果。前端按图片 ID 与认证身份隔离查询，管理员携带同源凭据，
访客省略凭据，并等待已有认证探针完成；不增加额外请求。
后台图片读取和编辑快照也返回同一可空原图链接。来源链接和展示图保存独立保留。

## 静态资源公开 URL

`site.assets_base_url` 可为前端 JS、CSS、字体与图标指定独立 HTTPS 根地址，支持路径前缀。
该 Host 只开放对应构建资源，不提供页面、API 或图片；登录验证 Worker 仍由主站同源加载。
配置改变资源地址与 Host 准入，资源字节、编码协商与条件请求规则沿用主站 `/assets`。
详细字段与约束见[配置说明](../CONFIG.md)，构建装配见[Web 构建资源边界](project-structure.md#web-构建资源边界)。
