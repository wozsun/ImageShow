# 子域名

应用通过 `Host` 头区分子域名，反向代理只需把 `img.example.com` 与 `*.img.example.com` 都转发到应用即可（无需为子域名编写额外规则），并确保 TLS 证书覆盖通配子域名：

- `random.img.example.com`：根路径 `/` 提供随机图，可携带 `d`/`b`/`t`/`tag`/`a`/`id`/`m`/`n` 查询参数，支持代理、跳转或 JSON 元数据返回，适合直接作为随机图链接分发；完整契约见[随机图 API](./random-api.md)。
- `static.img.example.com`：本地存储图片的独立资源域名（与主站 Cookie 隔离、单独缓存策略）。本地图片的公开链接会自动指向该域名；`/media`、`/thumbs` 对象字节仅在该域名提供，主站不暴露这些路径。
- `link.img.example.com`：外部原图安全代理域名。只开放 `/original/<id>`，用于详情页 `original` 字段指向且不同于展示图的 HTTPS URL，通常只在该 URL 无法无 Referer 直连时作为回退。若 `original` 为空或等于展示 URL，则没有原图入口；`/media/*` 与 `/thumbs/*` 均返回 404。代理请求以图片自身域名作 Referer 绕过防盗链，成功响应优先继承源站 `Cache-Control` / `Expires`，源站未声明时使用站内 CDN fallback（浏览器 1 天、共享缓存 1 年、回源失败可用旧副本 30 天）。

若站点直接使用二级域名（`site.domain` 配为 `example.com`），上述保留子域名相应变为 `random.example.com`、`static.example.com`、`link.example.com`。`static.*` 与 `link.*` 需要站点为可解析通配子域名的真实域名（本地存储图片和外部原图代理分别依赖这两个子域名提供，请勿使用 `localhost`）。`random` / `static` / `link` 这三个保留前缀本身也可在配置文件中通过 `site.random_subdomain` / `site.static_subdomain` / `site.link_subdomain` 改名；除主域名与这三个配置前缀外，其余子域名由应用直接返回不可缓存的 404。
