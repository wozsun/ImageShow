# 嵌入页与宿主光标协作

ImageShow 的 `/embed/home`、`/embed/show` 和 `/embed/gallery` 可以把鼠标事件传给直接父页面，
由宿主绘制自己的光标、跟随动画或点击效果。只在 iframe 内提供此能力；普通页面和独立打开的
嵌入地址保持原有光标。协议版本为 `1`，桥接随 `embed.enabled` 默认开启，不设额外配置开关或
启用参数。宿主完成连接握手后自动转发鼠标并接管光标；未连接时保留原生光标。

## 接入条件与职责

- 启用 `embed.enabled`，并按[配置说明](../CONFIG.md#embed)允许宿主来源。
  服务端 CSP `frame-ancestors` 是嵌入授权边界，不新增 CORS、会话权限或浏览器白名单副本。
- ImageShow 只提供鼠标坐标及按键状态，不传图片、DOM、输入框内容、账号、Cookie 或键盘事件。
  蝴蝶等素材、动画、拖尾和点击效果均由宿主维护。
- 宿主监听器必须同时校验 `event.origin === imageShowOrigin`、
  `event.source === iframe.contentWindow`、协议名、版本与当前 `bridgeId`。
  ImageShow 只接受直接父窗口的消息，首次连接后锁定该父窗口的精确 origin；不接受 opaque origin。
- 宿主动画层使用 `pointer-events: none`，避免挡住图片、筛选、拖动、滚轮及详情操作。
  ImageShow 只被动观察原生鼠标事件，不阻止默认行为、不捕获指针、不合成业务点击。

## 消息协议

消息都是普通对象，公共字段为：

```json
{ "channel": "imageshow:embed-cursor", "version": 1, "type": "hello" }
```

| 方向 | `type` | 其他字段 | 含义 |
| --- | --- | --- | --- |
| 宿主 → ImageShow | `hello` | 无 | 请求当前桥接实例的就绪消息，可在 iframe `load` 或宿主监听器就绪后发送 |
| ImageShow → 宿主 | `ready` | `bridgeId: string` | 当前实例已就绪；每次重新挂载生成新的 ID |
| 宿主 → ImageShow | `connect` | `bridgeId: string` | 宿主确认绘制能力已就绪，连接后自动接管 |
| 宿主 → ImageShow | `disconnect` | `bridgeId: string` | 宿主停止绘制前断开连接，恢复原生光标 |
| ImageShow → 宿主 | `state` | `bridgeId`、`connected: boolean`、`active: boolean` | 连接回执；`active` 表示此刻实际接管 |
| ImageShow → 宿主 | `pointer` | `bridgeId`、`phase` 与下列坐标字段 | 当前鼠标状态 |

ImageShow 挂载时会用 `targetOrigin: "*"` 向直接父窗口发送一次 `ready`，其中只有协议元数据和
随机实例 ID，没有鼠标或页面数据，用于兼容宿主不发送 Referer 的场景。响应 `hello`、连接回执及
所有鼠标数据均使用已经核对的父窗口精确 origin；宿主发送消息时始终指定 ImageShow 的精确 origin。
`bridgeId` 用于隔离旧实例消息，不是身份凭据；来源和窗口核验不能省略。

宿主收到 `ready` 后，在自己的动画层和事件处理器就绪时发送：

```json
{
  "channel": "imageshow:embed-cursor",
  "version": 1,
  "type": "connect",
  "bridgeId": "收到的 bridgeId"
}
```

ImageShow 回应 `state`；只有 `active: true` 时内部原生光标才被隐藏。`ready` 本身不会隐藏光标。
宿主收到新的 `bridgeId` 时先隐藏旧光标、清空按压状态，再为新实例重新连接；忽略旧实例后续消息。
宿主停止自定义光标或卸载嵌入组件时，应发送 `{ channel, version: 1, type: "disconnect", bridgeId }`。

### 鼠标事件

`phase` 为 `enter`、`move`、`down` 或 `up` 时，消息包含：

```json
{
  "channel": "imageshow:embed-cursor",
  "version": 1,
  "type": "pointer",
  "bridgeId": "收到的 bridgeId",
  "phase": "move",
  "x": 120,
  "y": 80,
  "button": -1,
  "buttons": 0,
  "viewportWidth": 1280,
  "viewportHeight": 720
}
```

- `x`、`y` 是 iframe 内视口的 `clientX`、`clientY`，单位为 CSS px；视口宽高采用相同单位。
  不叠加 iframe 内滚动距离，也不乘设备像素比。
- `button`、`buttons` 沿用原生 PointerEvent：`button` 表示本次变化的按键，
  `buttons` 是当前按键位掩码。只有 `down` / `up` 应被用于触发对应按下 / 松开效果，
  `enter` / `move` 的 `buttons` 可用于同步跨边界拖动中的按压外观。
- 仅转发主鼠标指针。触控和笔操作不转发；系统主指针为粗指针时不接管。
- 连续移动按动画帧合并，进入、按下和松开立即发送；按下 / 松开之前先发送尚未提交的移动。
  首次有效坐标先发 `enter`，宿主应据此直接定位，避免从旧坐标飞入。
- `phase: "leave"` 或 `"cancel"` 没有坐标与按键字段。宿主应隐藏嵌入区域光标、停止拖尾，
  并清除按压状态。离开视口、取消、窗口失焦、断开和页面退出会清理待发移动，避免迟到移动重新显示光标。

### 坐标换算与生命周期

建议 iframe 使用 `border: 0; padding: 0`。没有旋转或倾斜时，宿主可将坐标换算给
`position: fixed` 的光标层，兼容平移和正比例 CSS 缩放：

```js
const rect = iframe.getBoundingClientRect();
const hostX = rect.left + message.x * rect.width / message.viewportWidth;
const hostY = rect.top + message.y * rect.height / message.viewportHeight;
```

宿主在使用消息前校验有限数值、正视口尺寸和坐标范围。若 iframe 有边框、内边距、旋转或倾斜，
由宿主按实际内容视口和变换矩阵换算，不使用上面的简式。宿主滚动或调整 iframe 布局时，
应使用最新矩形重算最后的有效坐标，或先隐藏光标、等下次移动定位。

ImageShow 内部在嵌入首页、画廊和展映之间进行 SPA 导航时复用同一个桥接实例；离开嵌入路由、
禁用嵌入或卸载时恢复原生光标并发送断开状态。整页刷新或实例重新挂载需要重新握手。
页面隐藏、`pagehide`、内部元素进入全屏或主指针变粗时，`active` 变为 `false`；恢复后会重新
按连接状态恢复接管，光标位置等待下次鼠标进入或移动。

宿主收到 `active: false` 时必须隐藏动画、清空按压与拖尾；收到 `active: true` 只表示可以接收事件，
不要在尚无有效坐标时显示。宿主自身进入使动画层不可见的全屏或停止绘制时，必须发送
`disconnect`，恢复绘制后再 `connect`。协议不自动探测宿主渲染故障或维持后台心跳。

## 宿主握手示例

以下代码展示协议接入点；`cursor` 表示宿主现有的光标绘制组件，需自行实现
`reset()`（隐藏并清理按压 / 拖尾）和 `update()`（消费已换算的事件）。
建议先安装监听器再将 iframe 挂载到页面，并在每次 iframe `load` 时调用 `hello()`。
若 iframe 已存在，下面的 `hello()` 会主动获取当前实例；`iframe.src` 应已设置为目标嵌入地址。

```js
const imageShowOrigin = new URL(iframe.src).origin;
const envelope = { channel: "imageshow:embed-cursor", version: 1 };
let bridgeId = null;
let active = false;
const send = (message) => iframe.contentWindow?.postMessage(
  { ...envelope, ...message }, imageShowOrigin
);
const hello = () => send({ type: "hello" });
const onMessage = (event) => {
  if (event.origin !== imageShowOrigin || event.source !== iframe.contentWindow) return;
  const message = event.data;
  if (!message || message.channel !== envelope.channel || message.version !== 1) return;
  if (message.type === "ready" && typeof message.bridgeId === "string") {
    cursor.reset();
    active = false;
    bridgeId = message.bridgeId;
    send({ type: "connect", bridgeId });
    return;
  }
  if (!bridgeId || message.bridgeId !== bridgeId) return;
  if (message.type === "state") {
    active = message.active === true;
    if (!active) cursor.reset();
    return;
  }
  if (message.type !== "pointer" || !active) return;
  if (message.phase === "leave" || message.phase === "cancel") {
    cursor.reset();
    return;
  }
  if (!["enter", "move", "down", "up"].includes(message.phase)) return;
  const { x, y, viewportWidth: width, viewportHeight: height, button, buttons } = message;
  if (![x, y, width, height, button, buttons].every(Number.isFinite)
    || width <= 0 || height <= 0 || x < 0 || y < 0 || x >= width || y >= height) return;
  const rect = iframe.getBoundingClientRect();
  cursor.update({
    phase: message.phase, button, buttons,
    x: rect.left + x * rect.width / width,
    y: rect.top + y * rect.height / height
  });
};
window.addEventListener("message", onMessage);
iframe.addEventListener("load", hello);
hello(); // 兼容 iframe 已加载、宿主稍后挂载的情况。

// 卸载宿主光标 / 嵌入组件时：
// send({ type: "disconnect", bridgeId });
// window.removeEventListener("message", onMessage);
// iframe.removeEventListener("load", hello);
// cursor.reset();
```
