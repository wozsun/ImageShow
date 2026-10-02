# 嵌入页面

可以用 iframe 把站点的首页、画廊或展映放进你的网站。嵌入的页面以访客身份显示，没有管理功能。下文用 `img.example.com` 代表站点地址。

| 页面 | 地址 |
| --- | --- |
| 首页 | `https://img.example.com/embed/home` |
| 画廊 | `https://img.example.com/embed/gallery` |
| 展映 | `https://img.example.com/embed/show` |

## 开启嵌入

嵌入需要站点管理员配合：

1. 在后台「站点配置 → 外部嵌入」中开启嵌入，并确认对应的首页、画廊或展映处于开启状态。
2. 把你的网站地址（如 `https://blog.example.com`）加入允许列表。也可以用 `https://*.example.com` 允许某个域名下的所有子域名。

除站点自身及其默认信任的来源外，没有加入允许列表的网站会被浏览器拒绝显示 iframe，来源匹配规则见[外部嵌入配置](../CONFIG.md#外部嵌入)。浏览器携带允许来源的 Referer 时，随机图请求可免除频率限制，三档图片也能通过来源检查，见[随机图 API](random.md#来源检查与频率限制)。

只需用 JavaScript 获取随机图 JSON 或图片时，不必开启 iframe 嵌入，见[跨站读取](random.md#跨站读取)。

## 嵌入代码

```html
<iframe
  src="https://img.example.com/embed/show"
  style="width: 100%; height: 600px; border: 0;"
  allow="fullscreen"
  title="图片展映"
></iframe>
```

嵌入地址后面可以带上筛选和排序参数，与站点页面链接中的参数相同。最简单的做法是在站点上设置好筛选条件，点击「分享」复制页面链接，再把路径中的 `/gallery` 或 `/show` 改为 `/embed/gallery` 或 `/embed/show`。

## 进阶：与宿主页面配合

以下两个可选协议通过 `postMessage` 与嵌入页通信，不接入也能正常使用：

- [宿主光标协议](embed-cursor.md)：接收鼠标位置，由你的网站绘制自定义光标。
- [嵌入安全区协议](embed-safe-area.md)：在手机全面屏上告诉嵌入页需要避开的边距，或读取嵌入页的安全区。
