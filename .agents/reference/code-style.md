# 代码可读性与命名

代码排版以结构和阅读顺序为准，已有的合理换行即使能并成一行也予以保留。格式工具只辅助缩进和基本语法排版，职责、条件和调用步骤的呈现由作者判断。

## 换行

- 简单赋值、简短同类参数和直接返回可以保留一行。
- 参数具有不同职责，或包含回调、嵌套调用和复杂类型时，按参数展开。
- 多个判断条件按逻辑层次分行，嵌套条件保留明确缩进；三元表达式的判断与分支分开。
- 链式操作按处理步骤分行，对象与 JSX 属性按字段职责展开。
- 保留表达完整的长字符串、URL、正则和模板内容，SQL、Lua 与 JSX 的可见空白保持原样。
- 只整理受影响代码，其余代码保持现有排版。

```ts
const canRead = cacheIsReady
  && !readsAreBlocked
  && requestIsAuthorized;

return api<RuntimeConfigResponseDto>(
  `${adminApiBasePath}/settings`,
  {
    method: "POST",
    signal,
    body: JSON.stringify(config)
  }
);
```

## 命名

- 文件和目录表达稳定职责；函数表达执行的动作或返回的事实，避免把 slug 称为显示名。
- 组件名区分内容本身与布局、交互容器；通用 Hook 按通用职责命名。
- 同一概念沿用同一术语，不同概念明确区分。存储后端记录使用 Backend，执行 I/O 的实现使用 Driver。
- 时间间隔、时间戳和尺寸在容易混淆时标明单位，例如 `delayMs`、`updatedAtMs`、`heightPixels`。
- 局部的 `id`、`value`、`index` 和组件内 `Props` 等名称，语境明确时保持简短。
- 更名同步模块导入、调用方、测试与文档，旧路径随之删除。
- 内部命名整理保持 HTTP、JSON、数据库、配置文件、缓存 key 与日志事件等外部契约不变。

目录职责和依赖方向见[结构指南](../spec/project-structure.md)。结构调整应核对静态导入、类型导入和可静态解析的动态导入，并通过现有依赖方向及循环引用检查。
