# 公开页面与嵌入安全区

首页、画廊、展映及对应嵌入入口在浏览器允许的区域内铺满背景和画面，导航、筛选、
详情关闭按钮与底部操作避开屏幕安全区。后台及登录页保留普通视口策略。
这不启用 PWA，也不控制 Safari 工具栏或系统状态栏是否显示。

`SiteHead` 按路由维护唯一 viewport meta：公开页添加 `viewport-fit=cover`，离开后恢复
`width=device-width, initial-scale=1.0`。四边默认使用浏览器 `env(safe-area-inset-*)`，
普通设备的零安全区保留既有间距。公共根变量同时覆盖挂在 body 下的详情与菜单。
展映与弹窗跟随动态视口高度，底部操作避开手势区域；已打开的公开菜单也在安全区单独
变化时重新定位，不要求浏览器同时触发窗口 resize。关闭菜单后停止观察。
首页用于 Safari 取色的背景外壳保持原有结构。

## iframe 宿主接入

嵌入页独立打开时使用原生安全区。iframe 内默认也使用原生值；由于不同浏览器对嵌套
文档安全区的处理并不一致，宿主可以通过以下可选协议提供实际值。
宿主仍需自行启用全面屏视口，并让自己的导航避开安全区、让 iframe 填满剩余区域。
不要同时给 iframe 外层添加同一份安全区内边距。

协议只传布局尺寸，不传图片、鼠标、会话或个人信息，与[宿主光标协作](embed-cursor.md)独立。
只有启用嵌入的 `/embed/home`、`/embed/gallery`、`/embed/show` 在 iframe 中监听。
所有消息含 `channel: "imageshow:embed-safe-area"`、`version: 1`。

1. 子页面向直接父窗口发送 `type: "ready"` 及本次挂载生成的 `bridgeId`。
   首次发现允许 `targetOrigin: "*"`，消息不含页面或用户数据。
2. 宿主也可向 iframe 的准确 origin 发送 `type: "hello"`，子页面向发送方的 origin
   回复 `ready`；用于 iframe 加载、宿主重新挂载与历史恢复。
3. 宿主验证 `event.source === iframe.contentWindow` 和准确的 `event.origin`，然后回复：

```json
{
  "channel": "imageshow:embed-safe-area",
  "version": 1,
  "type": "insets",
  "bridgeId": "从 ready 原样取得",
  "insets": { "top": 0, "right": 48, "bottom": 34, "left": 48 }
}
```

尺寸单位是子页面 CSS px，示例数字仅为合成值。四项必填，必须是有限非负数，各边不超过
子视口对应宽 / 高的一半。子页面只接受直接父窗口、非 opaque origin、正确协议版本与
本次 `bridgeId`；首次有效更新后固定该父来源。非法消息不改变布局。

宿主应读取自身四向 `env()`，结合 `iframe.getBoundingClientRect()` 计算它们与 iframe
的重叠区域，再按 iframe 实际 CSS 尺寸换算；例如已被宿主导航避开的顶部应传 `0`。
四项值整体替换原生值，不与原生值相加。iframe 必须无边框 / 内边距；若存在 CSS 缩放，
换算为子页面 CSS px。只在握手、iframe / 安全区尺寸变化、滚动、全屏或历史恢复时更新，
可用 ResizeObserver 与单帧合并，不需要持续轮询或每帧测量。

子文档进入 Fullscreen API 全屏时暂时恢复浏览器原生安全区，退出时恢复宿主值；
独立 iframe 全屏时宿主也应重新测量。宿主卸载前可发送同 `bridgeId` 的
`type: "disconnect"` 恢复原生值。离开嵌入路由或关闭嵌入时，子页面移除变量和监听器。

## 验证边界

应覆盖零安全区、竖横屏、上下导航隐藏、详情关闭、窄屏菜单、独立打开、iframe 内部切页、
全屏进入 / 退出，以及公开页与后台往返。桌面注入合成安全区只能验证布局和协议，不能
代替真实 iPhone 上 Safari 工具栏、屏幕裁切与视口策略动态切换的验收。

依据：[WebKit 安全区说明](https://webkit.org/blog/7929/designing-websites-for-iphone-x/)、
[CSSWG iframe 安全区讨论](https://github.com/w3c/csswg-drafts/issues/4670)。
