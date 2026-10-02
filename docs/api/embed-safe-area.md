# 嵌入安全区协议

在手机全面屏上，嵌入页需要避开刘海、圆角和底部手势区。这个可选协议有两种用法：由你的网站告诉嵌入页需要避开的边距，或者读取嵌入页自己检测到的安全区。不接入时，嵌入页使用浏览器提供的安全区。嵌入的基本用法见[嵌入页面](embed.md)。

## 什么时候需要

不同浏览器对 iframe 内安全区的处理并不一致：iframe 中读到的安全区可能全为 0，也可能与你页面已经避开的区域重复。需要精确控制时，由你的网站计算 iframe 实际需要避开的边距，再下发给嵌入页。

你的网站仍需自行开启全面屏视口（`viewport-fit=cover`），让自己的导航栏避开安全区，并让 iframe 填满剩余区域。不要再给 iframe 外层加同样的安全区内边距。

协议只传布局尺寸和全屏状态，不传图片、鼠标、会话或个人信息，与[宿主光标协议](embed-cursor.md)互不影响。站点开启嵌入并允许你的网站后（见[开启嵌入](embed.md#开启嵌入)），iframe 中的 `/embed/home`、`/embed/gallery`、`/embed/show` 会自动启用这个协议；直接打开这些页面时不受影响。

## 消息与握手

所有消息都包含 `channel: "imageshow:embed-safe-area"` 和 `version: 1`。

| 方向 | `type` | 其他字段 | 含义 |
| --- | --- | --- | --- |
| 嵌入页 → 宿主 | `ready` | `bridgeId` | 嵌入页已就绪 |
| 宿主 → 嵌入页 | `hello` | 无 | 请求嵌入页重新发送 `ready` |
| 宿主 → 嵌入页 | `insets` | `bridgeId`、`insets` | 下发需要避开的边距，见[下发安全区](#下发安全区) |
| 宿主 → 嵌入页 | `connect` | `bridgeId` | 订阅嵌入页检测到的安全区，见[读取嵌入页的安全区](#读取嵌入页的安全区) |
| 嵌入页 → 宿主 | `native-insets` | `bridgeId`、`insets`、`viewportWidth`、`viewportHeight`、`fullscreen` | 嵌入页检测到的安全区 |
| 宿主 → 嵌入页 | `disconnect` | `bridgeId` | 停止上报，并撤销已下发的边距 |
| 嵌入页 → 宿主 | `disconnect` | `bridgeId` | 嵌入页即将退出，只发给已订阅的网站 |

- 嵌入页加载后向直接父页面发送 `ready`，附带本次加载的 `bridgeId`；在嵌入的首页、画廊和展映之间切换时 `bridgeId` 保持不变。为了让父页面发现它，这条消息使用 `targetOrigin: "*"` 发出，其中只有协议字段和 `bridgeId`。
- iframe 加载、你的组件重新挂载或从浏览器历史返回时，可以发送 `hello`，嵌入页会向你的网站再发送一次 `ready`。从历史返回时，嵌入页也会主动重新发送。
- 处理消息前，必须同时核对：`event.source` 是这个 iframe 的 `contentWindow`，`event.origin` 是嵌入页的准确 origin，协议版本和 `bridgeId` 与当前连接一致。收到新的 `bridgeId` 时，丢弃旧实例的状态。你的网站发送消息时，始终把 `targetOrigin` 设为嵌入页的准确 origin。
- 嵌入页只接受直接父页面发来的消息，不接受 origin 为 `null` 的页面；除 `hello` 外，`bridgeId` 必须与本次加载一致。收到第一条有效的 `connect` 或 `insets` 后，只接受这个父页面 origin 的消息。不合法的消息不会改变布局。

## 下发安全区

收到并核对 `ready` 后，发送 `insets`：

```json
{
  "channel": "imageshow:embed-safe-area",
  "version": 1,
  "type": "insets",
  "bridgeId": "收到的 bridgeId",
  "insets": { "top": 0, "right": 48, "bottom": 34, "left": 48 }
}
```

- 四个边都必须提供，单位为嵌入页的 CSS px，取值为有限的非负数；上下不超过 iframe 视口高度的一半，左右不超过宽度的一半。
- 这四个值整体替换嵌入页的浏览器安全区，不与之相加。已经由你的导航栏避开的一侧传 `0`。
- 计算方法：读取你页面四个方向的 `env(safe-area-inset-*)`，结合 `iframe.getBoundingClientRect()` 算出安全区与 iframe 重叠的部分，再按 iframe 的实际 CSS 尺寸换算。iframe 不能有边框和内边距；有 CSS 缩放时，换算为嵌入页的 CSS px。
- 只在握手、iframe 或安全区尺寸变化、滚动、全屏切换和从历史返回时重新下发，不需要轮询或每帧测量。可以用 `ResizeObserver` 监听尺寸变化，并把同一帧内的多次变化合并为一次。
- 嵌入页内有元素全屏时，暂时改用浏览器安全区，退出全屏后恢复你下发的值。iframe 本身全屏时，你的网站也应重新测量并下发。
- 发送 `disconnect` 可以撤销下发的值，恢复浏览器安全区。

## 读取嵌入页的安全区

收到并核对 `ready` 后发送 `connect`，嵌入页开始向你的网站上报它从浏览器读到的安全区。`connect` 只订阅上报，不改变嵌入页的布局；需要调整布局时仍使用 `insets`。

```json
{
  "channel": "imageshow:embed-safe-area",
  "version": 1,
  "type": "native-insets",
  "bridgeId": "收到的 bridgeId",
  "insets": { "top": 0, "right": 0, "bottom": 34, "left": 0 },
  "viewportWidth": 390,
  "viewportHeight": 844,
  "fullscreen": false
}
```

| 字段 | 说明 |
| --- | --- |
| `insets` | 嵌入页从浏览器读到的四向安全区，单位为嵌入页的 CSS px；不包含你下发的值 |
| `viewportWidth` / `viewportHeight` | 嵌入页视口的宽和高，单位同上 |
| `fullscreen` | 嵌入页内是否有元素处于全屏；你页面自身的全屏状态需要自己判断 |

- 连接时上报一次，之后在安全区、视口尺寸或全屏状态变化时上报。同一帧内的变化合并为一条，数据没有变化时不重复发送；重复发送 `connect` 或从历史返回时，会重新上报当前值。
- 上报值全为 0 不代表你页面的安全区为 0。你的网站仍需读取自己的 `env()` 并按 iframe 位置换算，不能把上报值直接当作你页面的安全区，也不要把上报值原样作为 `insets` 发回。
- 使用上报数据前，核对四个边都是有限的非负数，视口宽高是有限的正数，`fullscreen` 是布尔值。
- 发送 `disconnect` 停止上报，之后可以重新 `connect`。嵌入页离开嵌入页面或站点关闭嵌入时，会先向已订阅的网站发送 `disconnect`。

## 接入示例

下面的代码订阅嵌入页的安全区。`iframe` 是已设置嵌入地址的元素，`onEmbedSafeArea` 由你的网站实现。

```js
const channel = "imageshow:embed-safe-area";
const embedOrigin = new URL(iframe.src).origin;
let bridgeId;
const hello = () => iframe.contentWindow?.postMessage(
  { channel, version: 1, type: "hello" }, embedOrigin
);
const onMessage = (event) => {
  if (event.source !== iframe.contentWindow || event.origin !== embedOrigin) return;
  const message = event.data;
  if (!message || message.channel !== channel || message.version !== 1) return;
  if (message.type === "ready" && typeof message.bridgeId === "string") {
    bridgeId = message.bridgeId;
    iframe.contentWindow.postMessage({ channel, version: 1, type: "connect", bridgeId }, embedOrigin);
  } else if (bridgeId && message.bridgeId === bridgeId) {
    if (message.type === "native-insets") onEmbedSafeArea(message);
    else if (message.type === "disconnect") bridgeId = undefined;
  }
};
window.addEventListener("message", onMessage);
iframe.addEventListener("load", hello);
hello();

// 卸载时：
// iframe.contentWindow?.postMessage({ channel, version: 1, type: "disconnect", bridgeId }, embedOrigin);
// window.removeEventListener("message", onMessage);
// iframe.removeEventListener("load", hello);
```
