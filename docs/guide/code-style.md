# 代码可读性与命名

代码排版以结构和阅读顺序为准，不因某段代码能放进一行就合并已有的合理换行。
格式工具只辅助缩进和基本语法排版，不能代替对职责、条件和调用步骤的判断。

## 换行

- 简单赋值、简短同类参数和直接返回可以保留一行。
- 参数具有不同职责，或包含回调、嵌套调用和复杂类型时，按参数展开。
- 多个判断条件按逻辑层次分行，嵌套条件保留明确缩进；三元表达式的判断与分支分开。
- 链式操作按处理步骤分行，对象与 JSX 属性按字段职责展开。
- 保留表达完整的长字符串、URL、正则和模板内容，不为排版修改 SQL、Lua 或 JSX 可见空白。
- 只整理受影响代码，不为统一行宽反复展开或压缩全仓。

```ts
const canRead = cacheIsReady
  && !readsAreBlocked
  && requestIsAuthorized;

return importStorageBackends(
  importedBackends,
  persistCandidateConfig,
  recordTransactionId,
  signal
);
```

## 命名

- 文件和目录表达稳定职责；函数表达执行的动作或返回的事实，避免把 slug 称为显示名。
- 组件名区分内容本身与布局、交互容器；通用 Hook 不沿用某个首个调用方的专属名称。
- 同一概念沿用同一术语，不同概念明确区分。存储后端记录使用 Backend，执行 I/O 的实现使用 Driver。
- 时间间隔、时间戳和尺寸在容易混淆时标明单位，例如 `delayMs`、`updatedAtMs`、`heightPixels`。
- 局部的 `id`、`value`、`index` 和组件内 `Props` 等名称，语境明确时不必扩写。
- 更名同步模块导入、调用方、测试与文档，不保留没有调用方的旧路径转发层。
- 内部命名整理不顺带变更 HTTP、JSON、数据库、配置文件、缓存 key 或日志事件等外部契约。

目录职责和依赖方向见[项目结构说明](project-structure.md)。结构调整应核对静态导入、类型导入和
可静态解析的动态导入，并通过现有依赖方向及循环引用检查。
