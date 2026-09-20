# 公开页面与嵌入安全区

首页、画廊、展映及对应嵌入入口使用浏览器提供的视口，导航、筛选、
详情关闭按钮与底部操作避开屏幕安全区。后台及登录页保留普通视口策略。
这不启用 PWA，也不控制 Safari 工具栏或系统状态栏是否显示。

`SiteHead` 按路由维护唯一 viewport meta：公开页添加 `viewport-fit=cover`，离开后恢复
`width=device-width, initial-scale=1.0`。四边默认使用浏览器 `env(safe-area-inset-*)`，
普通设备的零安全区保留既有间距。公共根变量同时覆盖挂在 body 下的详情与菜单。
展映的页面与操作区、弹窗跟随动态视口高度，底部操作避开手势区域；已打开的公开菜单也在安全区单独
变化时重新定位，不要求浏览器同时触发窗口 resize。关闭菜单后停止观察。
首页使用实色、层级为 0 的固定背景外壳，以 `inset: 0` 覆盖完整视口；
图片与遮罩仍采用大视口高度，图片框扣除导航占用并裁剪淡入时的缩放溢出。
页面自然滚动，背景位置不依赖滚动动画或脚本补偿；图片请求与淡入逻辑保持独立。
触屏画廊的右下角操作保留至少 36px 底部间距，并避开更大的原生或宿主安全区；
由浏览器原生固定定位跟随视口，不通过脚本逐帧移动按钮。
展映页面、画布和操作区使用同一个动态视口，不额外扩大画布或补偿浏览器工具栏高度。
Safari 工具栏后的页面延伸与取色由浏览器决定，不承诺图片透过工具栏或消除浏览器裁切。
导航外壳从顶部安全边界开始，在底部安全区之前结束，以普通溢出裁剪限制滑出的内容；毛玻璃仍采样页面背景，
不改变导航表面颜色和透明度。导航之外的外壳区域不接管点击与拖动。

展映的画布拖动和双指缩放由页面接管，不产生原生页面滚动；因此不能期待它像首页或
画廊一样通过滑动收起浏览器工具栏。工具栏后的背景绘制与工具栏自动隐藏是独立能力，
实际玻璃效果由浏览器决定，也不保证状态栏透出网页。

## iframe 宿主接入

嵌入页独立打开时使用原生安全区。iframe 内默认也使用原生值；由于不同浏览器对嵌套
文档安全区的处理并不一致，宿主可以通过以下可选协议提供实际值，也可订阅子页面的原生安全区。
宿主仍需自行启用全面屏视口，并让自己的导航避开安全区、让 iframe 填满剩余区域。
不要同时给 iframe 外层添加同一份安全区内边距。

协议只传布局尺寸与全屏状态，不传图片、鼠标、会话或个人信息，与[宿主光标协作](embed-cursor.md)独立。
不依赖特定宿主域名、框架或其他项目；嵌入授权沿用配置及服务端 CSP `frame-ancestors`。
只有启用嵌入的 `/embed/home`、`/embed/gallery`、`/embed/show` 在 iframe 中监听。
所有消息含 `channel: "imageshow:embed-safe-area"`、`version: 1`。

### 宿主向 ImageShow 下发安全区

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

### ImageShow 向宿主上报原生安全区

宿主收到并核验 `ready` 后，发送 `{ channel, version: 1, type: "connect", bridgeId }`。
`connect` 只订阅上报，不覆盖 ImageShow 布局；需要下发避让尺寸时仍使用 `insets`。
完成订阅后，ImageShow 向锁定的父窗口精确 origin 发送：

```json
{
  "channel": "imageshow:embed-safe-area",
  "version": 1,
  "type": "native-insets",
  "bridgeId": "从 ready 原样取得",
  "insets": { "top": 0, "right": 0, "bottom": 34, "left": 0 },
  "viewportWidth": 390,
  "viewportHeight": 844,
  "fullscreen": false
}
```

以上数字为合成示例，尺寸均为子页面 CSS px。`insets` 直接读取子文档的四向
`env(safe-area-inset-*)`，不回传宿主下发的值，避免双向同步形成反馈循环。
`fullscreen` 表示子文档自身是否有全屏元素，宿主仍需自行判断父文档的全屏状态。
嵌入文档原生值可能全为 0，这不是父页面物理安全区为 0 的证明；宿主必须继续读取自身
`env()` 并结合 iframe 位置换算，不能把子页面数值直接用作父页面的安全区。

上报在连接时及原生安全区、子视口尺寸、全屏状态变化后发送；同一帧合并更新，相同数据不重复发送。
历史恢复及重复 `connect` 会重新上报当前值。原生安全区尺寸由 ResizeObserver 观察，
没有持续轮询或滚动位置补偿；没有订阅的嵌入页不创建测量节点和观察器。
宿主发送 `disconnect` 时停止上报并恢复子页面原生值，后续可重新连接。
子页面退出嵌入布局或关闭嵌入时向已订阅宿主发送 `disconnect`，然后移除测量节点、监听与待执行帧。

宿主必须同时校验 `event.source === iframe.contentWindow`、ImageShow 精确 origin、协议版本及
当前 `bridgeId`；收到新实例的 `ready` 时丢弃旧实例状态。示例接收方式：

```js
const channel = "imageshow:embed-safe-area";
const imageShowOrigin = new URL(iframe.src).origin;
let bridgeId;
const onMessage = (event) => {
  if (event.source !== iframe.contentWindow || event.origin !== imageShowOrigin) return;
  const message = event.data;
  if (!message || message.channel !== channel || message.version !== 1) return;
  if (message.type === "ready" && typeof message.bridgeId === "string") {
    bridgeId = message.bridgeId;
    iframe.contentWindow.postMessage({ channel, version: 1, type: "connect", bridgeId }, imageShowOrigin);
  } else if (bridgeId && message.bridgeId === bridgeId) {
    if (message.type === "native-insets") onImageShowSafeArea(message);
    else if (message.type === "disconnect") bridgeId = undefined;
  }
};
window.addEventListener("message", onMessage);
iframe.contentWindow.postMessage({ channel, version: 1, type: "hello" }, imageShowOrigin);
// 宿主卸载时先发送 disconnect，再移除 onMessage 监听器。
```

`onImageShowSafeArea` 由宿主实现。宿主不得将上报原生值原封不动地作为下一次 `insets` 回传。

## 验证边界

应覆盖零安全区、竖横屏、上下导航隐藏、详情关闭、窄屏菜单、独立打开、iframe 内部切页、
全屏进入 / 退出、上报订阅 / 断开 / 重连、来源及旧实例拒绝、无反馈循环和资源释放，以及公开页与后台往返。
桌面注入合成安全区只能验证布局和协议，不能
代替真实 iPhone 上 Safari 工具栏、屏幕裁切与视口策略动态切换的验收。

依据：[WebKit 安全区说明](https://webkit.org/blog/7929/designing-websites-for-iphone-x/)、
[CSSWG iframe 安全区讨论](https://github.com/w3c/csswg-drafts/issues/4670)。
