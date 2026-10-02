# 宿主光标协议

接入后，嵌入页把鼠标位置和按键状态发给你的网站，由你的网站绘制自定义光标、跟随动画或点击效果。不接入时，嵌入页使用普通光标，不需要任何操作。嵌入的基本用法见[嵌入页面](embed.md)。

## 工作方式

1. 嵌入页加载后向父页面发送 `ready`，附带本次加载的 `bridgeId`。
2. 你的网站准备好绘制后，回复 `connect`。
3. 嵌入页回复 `state`。`active` 为 `true` 时，嵌入页隐藏自己的光标，开始发送鼠标消息。
4. 停止绘制或卸载前，你的网站发送 `disconnect`，嵌入页恢复普通光标。

协议版本为 `1`。只要站点允许你的网站嵌入（见[开启嵌入](embed.md#开启嵌入)），嵌入页在 iframe 中就会自动启用这个协议，站点不需要额外设置。

## 安全要求

- 嵌入页只发送鼠标坐标和按键状态，不发送图片、页面内容、输入内容、账号、Cookie 或键盘事件。光标素材、动画、拖尾和点击效果都由你的网站负责。
- 处理消息前，必须同时核对：`event.origin` 是嵌入页的准确 origin，`event.source` 是这个 iframe 的 `contentWindow`，协议名、版本和 `bridgeId` 都与当前连接一致。`bridgeId` 只用来区分新旧实例，不是身份凭据，不能代替来源核对。
- 你的网站发送消息时，始终把 `targetOrigin` 设为嵌入页的准确 origin。
- 嵌入页只接受直接父页面发来的消息，不接受 origin 为 `null` 的页面（如未设置 `allow-same-origin` 的沙箱 iframe）。收到第一条 `connect` 或 `disconnect` 后，只接受这个父页面 origin 的消息。
- 为了让父页面发现它，嵌入页的第一条 `ready` 使用 `targetOrigin: "*"` 发出，其中只有协议字段和随机生成的 `bridgeId`。之后的状态和鼠标消息只发往已连接父页面的准确 origin。
- 光标层设置 `pointer-events: none`，不要挡住图片、筛选、拖动、滚轮和详情等操作。嵌入页只读取鼠标事件，不阻止浏览器默认行为，也不会代为触发点击。

## 消息

所有消息都是普通对象，包含以下公共字段：

```json
{ "channel": "imageshow:embed-cursor", "version": 1, "type": "hello" }
```

| 方向 | `type` | 其他字段 | 含义 |
| --- | --- | --- | --- |
| 宿主 → 嵌入页 | `hello` | 无 | 请求嵌入页重新发送 `ready`，可在 iframe `load` 或你的监听器就绪后发送 |
| 嵌入页 → 宿主 | `ready` | `bridgeId` | 嵌入页已就绪 |
| 宿主 → 嵌入页 | `connect` | `bridgeId` | 你的网站已准备好绘制，请求接管光标 |
| 宿主 → 嵌入页 | `disconnect` | `bridgeId` | 停止接管，恢复普通光标 |
| 嵌入页 → 宿主 | `state` | `bridgeId`、`connected`、`active` | 连接状态，`active` 表示此刻是否实际接管 |
| 嵌入页 → 宿主 | `pointer` | `bridgeId`、`phase` 及鼠标字段 | 鼠标状态，见[鼠标消息](#鼠标消息) |

嵌入页每次加载都会生成新的 `bridgeId`；在嵌入的首页、画廊和展映之间切换时保持不变。收到 `ready` 后，用其中的 `bridgeId` 发送 `connect`：

```json
{
  "channel": "imageshow:embed-cursor",
  "version": 1,
  "type": "connect",
  "bridgeId": "收到的 bridgeId"
}
```

### 连接状态

- `ready` 本身不会隐藏光标。只有收到 `active: true` 的 `state` 后，嵌入页才隐藏自己的光标。
- 以下情况 `active` 会变为 `false`：页面隐藏、切到后台或即将离开；嵌入页内有元素进入全屏；设备的主要指针不是精确指针（如触屏设备）。条件恢复后会自动重新接管，光标位置等下一次鼠标进入或移动时再给出。
- 收到 `active: false` 时，隐藏光标并清除按压和拖尾。收到 `active: true` 只表示可以接收鼠标消息，在收到有效坐标之前不要显示光标。
- 收到新的 `bridgeId` 时（例如嵌入页刷新），先隐藏旧光标、清除按压状态，再向新实例发送 `connect`，并忽略旧实例之后的消息。
- 嵌入页离开嵌入页面或站点关闭嵌入时，会恢复普通光标，并发送 `connected: false` 的 `state`。
- 你的网站进入全屏等使光标层不可见的状态，或停止绘制时，必须发送 `disconnect`，恢复后再发送 `connect`。协议没有心跳，嵌入页无法发现你的网站已停止绘制。

### 鼠标消息

`phase` 为 `enter`、`move`、`down` 或 `up` 时，消息包含坐标和按键：

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

| 字段 | 说明 |
| --- | --- |
| `x` / `y` | 鼠标在 iframe 视口中的位置，即 `clientX` / `clientY`，单位为 CSS px；不含 iframe 内的滚动距离，也不乘设备像素比 |
| `viewportWidth` / `viewportHeight` | iframe 视口的宽和高，单位同上 |
| `button` | 本次发生变化的按键，含义同 PointerEvent 的 `button` |
| `buttons` | 当前按下的按键位掩码，含义同 PointerEvent 的 `buttons` |

| `phase` | 何时发送 | 处理方式 |
| --- | --- | --- |
| `enter` | 鼠标进入后的第一个有效位置 | 直接把光标放到这里，不要从上一次的位置移过来 |
| `move` | 鼠标移动，每帧最多一条 | 更新光标位置；拖动时可用 `buttons` 同步按压外观 |
| `down` / `up` | 按下或松开时立即发送，尚未发出的移动会先发送 | 触发按下和松开效果；只用这两种消息触发 |
| `leave` / `cancel` | 鼠标离开 iframe、操作被取消、窗口失去焦点或接管结束 | 隐藏光标，停止拖尾，清除按压状态；这两种消息没有坐标和按键字段 |

只转发主鼠标指针，触控和触控笔操作不会转发。

## 坐标换算

iframe 设置 `border: 0; padding: 0` 且没有旋转或倾斜时，可以用下面的公式换算为你页面上 `position: fixed` 光标层的坐标。平移和等比缩放都适用：

```js
const rect = iframe.getBoundingClientRect();
const hostX = rect.left + message.x * rect.width / message.viewportWidth;
const hostY = rect.top + message.y * rect.height / message.viewportHeight;
```

- 使用前核对坐标和尺寸都是有限数值，视口宽高为正数，坐标位于视口范围内。
- iframe 有边框、内边距、旋转或倾斜时，按 iframe 实际的内容区域和变换矩阵换算，不能使用上面的公式。
- 你的页面滚动或 iframe 的位置、大小变化时，用最新的位置重新计算最后一个坐标，或者先隐藏光标，等下一次移动再显示。

## 接入示例

下面的代码完成握手并处理鼠标消息。`cursor` 代表你自己的光标组件，需要提供 `reset()`（隐藏光标并清除按压和拖尾）和 `update()`（接收换算后的事件）。建议先注册监听器再把 iframe 放进页面，并在每次 iframe `load` 时调用 `hello()`；如果 iframe 已经在页面中，最后一行的 `hello()` 会主动取得当前实例。`iframe.src` 应已设置为嵌入地址。

```js
const embedOrigin = new URL(iframe.src).origin;
const envelope = { channel: "imageshow:embed-cursor", version: 1 };
let bridgeId = null;
let active = false;
const send = (message) => iframe.contentWindow?.postMessage(
  { ...envelope, ...message }, embedOrigin
);
const hello = () => send({ type: "hello" });
const onMessage = (event) => {
  if (event.origin !== embedOrigin || event.source !== iframe.contentWindow) return;
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
hello(); // 监听器就绪后主动请求握手。

// 卸载光标或嵌入组件时：
// send({ type: "disconnect", bridgeId });
// window.removeEventListener("message", onMessage);
// iframe.removeEventListener("load", hello);
// cursor.reset();
```
