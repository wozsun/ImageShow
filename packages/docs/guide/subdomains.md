# 子域名

应用通过 `Host` 头区分子域名，反向代理只需把 `img.example.com` 与 `*.img.example.com` 都转发到应用即可（无需为子域名编写额外规则），并确保 TLS 证书覆盖通配子域名：

- `<主题>.img.example.com`：对应主题的画廊，例如 `nature.img.example.com`。
- `random.img.example.com`：等价于 `img.example.com/random`，可携带 `d`/`b`/`t`/`tag`/`a`/`m` 查询参数，适合直接作为随机图链接分发。
- `static.img.example.com`：本地存储图片的独立资源域名（与主站 Cookie 隔离、单独缓存策略）。本地图片的公开链接会自动指向该域名；`/media`、`/thumbs` 对象字节仅在该域名提供，主站与主题域名不暴露这些路径。
- `link.img.example.com`：外链资源专用域名。`/thumbs/<设备-明暗>/<主题>/<id>.webp` 提供代理链接模式生成并存储的略缩图；`/media/<id>.<ext>` 代理 link 图展示用的外部原图；`/original/<id>` 只代理详情页 `original` 字段指向且不同于展示图的外部 URL，通常只在该 URL 无法无 Referer 直连时作为回退。若 `original` 为空或等于展示 URL，则没有原图入口。代理请求以图片自身域名作 Referer 绕过防盗链，公共代理成功响应优先继承源站 `Cache-Control` / `Expires`，源站未声明时使用站内 CDN fallback（浏览器 1 天、共享缓存 1 年、回源失败可用旧副本 30 天）；`/media` 回源失败时会退回已生成的 link 略缩图，兜底响应缓存 1 周；独立 `/thumbs` 略缩图仍走长效 `immutable` 缓存。
- `docs.img.example.com`：文档站点。由 `packages/docs`（VitePress）构建，随应用一起打包发布，该域名只提供文档静态页面，不暴露 API / 主站 / 对象字节。可通过配置 `site.docs_enabled: false` 关闭——关闭后该域名一律返回 404，但 `docs` 前缀仍被保留（主题不可占用）。

若站点直接使用二级域名（`site.domain` 配为 `example.com`），上述保留子域名相应变为 `random.example.com`、`static.example.com`、`link.example.com`、`docs.example.com`、`<主题>.example.com`。`static.*` 与 `link.*` 需要站点为可解析通配子域名的真实域名（本地存储图片、外链图片分别依赖这两个子域名提供，请勿使用 `localhost`）。`random` / `static` / `docs` / `link` 这四个保留前缀本身也可在配置文件中通过 `site.random_subdomain` / `site.static_subdomain` / `site.docs_subdomain` / `site.link_subdomain` 改名。
