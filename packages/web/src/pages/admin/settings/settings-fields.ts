import {
  builtInSiteIconPath,
  runtimeConfigLimits,
  variantSettingLimits,
  type ApiValidationIssueDto,
  type RuntimeConfig
} from "@imageshow/shared/browser";

export const settingsSections = {
  site: {
    column: "left",
    title: "站点信息",
    description: "保存后影响后续请求；域名和资源地址变更前，请先完成域名接入。"
  },
  home: {
    column: "right",
    title: "首页与页脚",
    description: "页面默认内容保存后，刷新或重新进入页面即可看到。页脚支持安全 Markdown。"
  },
  browsing: {
    column: "left",
    title: "画廊与展映",
    description: "设置页面入口和默认浏览方式；管理员与访客仍可使用各自的浏览偏好。"
  },
  embed: {
    column: "right",
    title: "外部嵌入",
    description: "额外来源同时用于嵌入授权与图片防盗链白名单。"
  },
  random: {
    column: "right",
    title: "随机图片 API",
    description: "设置随机图的默认返回方式、尺寸、单次返回数量上限和零匹配回退顺序。"
  },
  ingestion: {
    column: "wide",
    title: "上传与导入",
    description: "控制原始图片接收、队列和入库；不会重新处理已入库图片。"
  },
  normalize: {
    column: "wide",
    title: "图片处理",
    description: "三档分别生成 WebP，长边与目标体积须满足小图 ≤ 中图 ≤ 大图；降到最低质量后允许超出目标体积。"
  },
  admin: {
    column: "left",
    title: "后台界面",
    description: "应用于后台列表、概览和登录页面。"
  },
  security: {
    column: "right",
    title: "登录与请求限制",
    description: "修改只影响之后签发的会话和之后的请求。随机 API 单次取图不超过“图片额度 ÷ 批量请求次数”（至少 1）张时按张计入图片额度，超过时计 1 次批量请求。"
  },
  altcha: {
    column: "left",
    title: "登录验证",
    description: "工作成本 × 计数上限不能超过 100,000,000，计数下限不能高于上限。"
  },
  log: {
    column: "right",
    title: "运行日志",
    description: "日志等级和轮转设置在保存后生效。"
  }
} as const;

type SettingsGroup = {
  section: keyof typeof settingsSections;
  title?: string;
  singleColumn?: boolean;
  wide?: boolean;
};

const settingsGroups = {
  identity: { section: "site", title: "名称与介绍" },
  addresses: { section: "site", title: "域名与资源", singleColumn: true },
  visibility: { section: "site", title: "展示选项" },
  homeEntry: { section: "home", title: "首页入口" },
  homeBanner: { section: "home", title: "首页 Banner" },
  homeFooter: { section: "home", title: "备案与页脚" },
  gallery: { section: "browsing", title: "画廊" },
  show: { section: "browsing", title: "展映" },
  original: { section: "browsing", title: "原图访问" },
  random: { section: "random" },
  embed: { section: "embed" },
  ingestion: { section: "ingestion", title: "原图与入库" },
  upload: { section: "ingestion", title: "本地上传" },
  import: { section: "ingestion", title: "URL / JSONL 导入" },
  weibo: { section: "ingestion", title: "微博导入" },
  normalize: { section: "normalize", title: "处理策略", wide: true },
  large: { section: "normalize", title: "大图" },
  medium: { section: "normalize", title: "中图" },
  small: { section: "normalize", title: "小图" },
  admin: { section: "admin" },
  session: { section: "security", title: "会话", singleColumn: true },
  login: { section: "security", title: "登录保护" },
  rate: { section: "security", title: "随机图片 API" },
  altcha: { section: "altcha" },
  log: { section: "log" }
} as const satisfies Record<string, SettingsGroup>;

export const settingsGroupEntries = Object.entries(settingsGroups) as [keyof typeof settingsGroups, SettingsGroup][];

type LeafPaths<T> = {
  [K in keyof T & string]: T[K] extends Record<string, unknown>
    ? `${K}.${LeafPaths<T[K]>}`
    : K
}[keyof T & string];

export type SettingsFieldPath = LeafPaths<RuntimeConfig>;
type ValueAtPath<T, P extends string> = P extends `${infer K}.${infer Rest}`
  ? K extends keyof T ? ValueAtPath<T[K], Rest> : never
  : P extends keyof T ? T[P] : never;

type FieldControl<T> = [T] extends [boolean] ? { kind: "toggle"; heading?: "card" | "group" }
  : [T] extends [number] ? { kind: "number"; min: number; max: number; step?: "any"; exclusiveMin?: boolean }
  : [T] extends [string] ? { kind: "text" | "textarea"; maxLength?: number; placeholder?: string }
    | { kind: "select"; options: Readonly<Record<T & string, string>> }
  : [T] extends [[number, number]] ? { kind: "range"; min: number; max: number }
  : [T] extends [string[]] ? { kind: "csv"; placeholder?: string; maxLength?: number }
    | { kind: "lines"; placeholder?: string }
    | { kind: "choices"; options: Readonly<Record<T extends string[] ? T[number] : never, string>> }
  : never;

type FieldDefinition<T> = FieldControl<T> & {
  group: keyof typeof settingsGroups;
  label: string;
  hint?: string;
  wide?: boolean;
};

const orderOptions = { latest: "最新优先", oldest: "最旧优先", random: "随机模式" } as const;
const normalizeFields = (tier: keyof typeof variantSettingLimits, label: string) => ({
  quality: {
    group: tier,
    label: `${label}初始质量`,
    kind: "number",
    min: variantSettingLimits[tier].quality[0],
    max: variantSettingLimits[tier].quality[1]
  },
  min_quality: {
    group: tier,
    label: `${label}最低质量`,
    kind: "number",
    min: variantSettingLimits[tier].min_quality[0],
    max: variantSettingLimits[tier].min_quality[1]
  },
  max_long_edge: {
    group: tier,
    label: `${label}长边上限（px）`,
    kind: "number",
    min: variantSettingLimits[tier].max_long_edge[0],
    max: variantSettingLimits[tier].max_long_edge[1]
  },
  max_size_kb: {
    group: tier,
    label: `${label}目标体积（KiB）`,
    kind: "number",
    min: variantSettingLimits[tier].max_size_kb[0],
    max: variantSettingLimits[tier].max_size_kb[1]
  }
}) as const;
const large = normalizeFields("large", "大图");
const medium = normalizeFields("medium", "中图");
const small = normalizeFields("small", "小图");

// 每个 RuntimeConfig 叶子必须有一个表单控件，漏项由编译期约束发现。
const settingsFields = {
  "site.domain": {
    group: "addresses",
    label: "主站域名",
    kind: "text",
    ...runtimeConfigLimits["site.domain"],
    placeholder: "img.example.com",
    hint: "不含协议和路径，可带端口；设置后只接受主站与附加站点域名，留空或 example.com 时不限制。"
  },
  "site.additional_domains": {
    group: "addresses",
    label: "附加站点域名",
    kind: "lines",
    placeholder: "alternate.example.net\npreview.example.org:8443",
    hint: `每行一个，最多 ${runtimeConfigLimits["site.additional_domains"].maxItems} 项，格式同主站域名。未配置独立公开地址的图片和静态资源随当前访问域名提供；DNS、证书与 Nginx 需自行配置，回源保留访问域名。`
  },
  "site.title": {
    group: "identity",
    label: "网页标题",
    kind: "text"
  },
  "site.description": {
    group: "identity",
    label: "站点描述",
    kind: "textarea",
    ...runtimeConfigLimits["site.description"]
  },
  "site.header_name": {
    group: "identity",
    label: "页头名称",
    kind: "text"
  },
  "site.icon": {
    group: "identity",
    wide: true,
    label: "站点图标",
    kind: "text",
    ...runtimeConfigLimits["site.icon"],
    placeholder: builtInSiteIconPath,
    hint: "留空使用内置图标；可填站内绝对路径或 HTTPS URL，自定义图标放入 data/asset 后填写 /asset/文件名。该目录缓存 1 年，更换图标请用新文件名。"
  },
  "site.version.enabled": {
    group: "visibility",
    label: "显示版本号",
    kind: "toggle"
  },
  "site.version.link_enabled": {
    group: "visibility",
    label: "版本号链接到发布说明",
    kind: "toggle"
  },
  "site.assets_base_url": {
    group: "addresses",
    label: "静态资源公开 URL",
    kind: "text",
    ...runtimeConfigLimits["site.assets_base_url"],
    placeholder: "留空随当前站点域名访问",
    hint: "须使用独立 Host，可带路径前缀。保存后刷新页面生效。"
  },
  "site.script_sources": {
    group: "addresses",
    label: "额外脚本来源",
    kind: "lines",
    placeholder: "https://*.cdn.example.net\nhttps://static.example.org/js/\nhttps://cdn.example.org/lib/widget.js",
    hint: `各页面额外允许的脚本来源，静态资源公开 URL 已自动允许。每行一个 HTTPS 地址，最多 ${runtimeConfigLimits["site.script_sources"].maxItems} 项，不含参数；可用最左侧子域通配符，路径以 / 结尾匹配该目录，否则只匹配该文件。刷新页面后生效。`
  },
  "site.robots_enabled": {
    group: "visibility",
    label: "启用 robots.txt",
    kind: "toggle",
    hint: "提供搜索引擎抓取规则；关闭时不提供该文件。"
  },
  "site.root": {
    group: "homeEntry",
    label: "根路径页面",
    kind: "select",
    options: { home: "首页 /home", show: "展映 /show", gallery: "画廊 /gallery" }
  },
  "site.home.enabled": {
    group: "homeEntry",
    label: "启用首页",
    kind: "toggle",
    heading: "card"
  },
  "site.home.browse_target": {
    group: "homeEntry",
    label: "首页浏览按钮目标",
    kind: "select",
    options: { show: "展映", gallery: "画廊" }
  },
  "site.home.banner_label": {
    group: "homeBanner",
    label: "首页 Banner 上方标识",
    kind: "text",
    ...runtimeConfigLimits["site.home.banner_label"]
  },
  "site.home.banner_title": {
    group: "homeBanner",
    label: "首页 Banner 标题",
    kind: "textarea",
    ...runtimeConfigLimits["site.home.banner_title"]
  },
  "site.home.background": {
    group: "homeBanner",
    label: "首页背景图",
    kind: "text",
    ...runtimeConfigLimits["site.home.background"],
    placeholder: "留空使用随机图片",
    hint: "站内绝对路径或 HTTPS URL。"
  },
  "site.icp": {
    group: "homeFooter",
    label: "ICP备案号",
    kind: "text",
    ...runtimeConfigLimits["site.icp"]
  },
  "site.footer": {
    group: "homeFooter",
    label: "首页页脚",
    kind: "textarea",
    ...runtimeConfigLimits["site.footer"]
  },
  "site.mps": {
    group: "homeFooter",
    label: "公安备案号",
    kind: "text",
    ...runtimeConfigLimits["site.mps"]
  },
  "site.gallery.enabled": {
    group: "gallery",
    label: "启用画廊",
    kind: "toggle",
    heading: "group"
  },
  "site.gallery.order": {
    group: "gallery",
    label: "画廊默认排序",
    kind: "select",
    options: orderOptions
  },
  "site.show.enabled": {
    group: "show",
    label: "启用展映",
    kind: "toggle",
    heading: "group"
  },
  "site.show.autoplay": {
    group: "show",
    label: "展映默认自动播放",
    kind: "toggle"
  },
  "site.show.mode": {
    group: "show",
    label: "展映默认模式",
    kind: "select",
    options: { waterfall: "瀑布", float: "漂浮", cluster: "星群" }
  },
  "site.show.density": {
    group: "show",
    label: "展映默认密度",
    hint: "用于瀑布和漂浮；星群按分类图片数决定密度。",
    kind: "select",
    options: { relaxed: "宽松", balanced: "均衡", dense: "紧凑" }
  },
  "site.show.drift_speed": {
    group: "show",
    label: "展映播放速度",
    hint: "调整瀑布滚动、漂浮移动，以及星群转动与自动播放的速度。",
    kind: "number",
    ...runtimeConfigLimits["site.show.drift_speed"]
  },
  "site.show.order": {
    group: "show",
    label: "展映默认排序",
    kind: "select",
    options: orderOptions
  },
  "site.public_original": {
    group: "original",
    label: "公开原图",
    kind: "toggle",
    hint: "允许访客打开原图；关闭后仅管理员可访问。已有 CDN 缓存不受影响。"
  },
  "site.random_method": {
    group: "random",
    label: "随机图默认模式",
    kind: "select",
    options: { proxy: "代理返回", redirect: "302 跳转" }
  },
  "site.random_size": {
    group: "random",
    label: "随机图默认尺寸",
    kind: "select",
    options: { large: "大图", medium: "中图", small: "小图" }
  },
  "site.random_max_items": {
    group: "random",
    label: "随机图单次返回数量上限",
    kind: "number",
    ...runtimeConfigLimits["site.random_max_items"],
    hint: "JSON 请求的 limit 超过此值时按此值处理；不填 limit 时仍返回 1 张。"
  },
  "site.random_fallback_order": {
    group: "random",
    kind: "csv",
    label: "零匹配回退顺序",
    hint: "用逗号分隔 device、brightness、author、tag、theme，各写一次。请求写 fallback=all 或在列表末尾写 all 时，按此顺序放宽其余维度；写明的维度按请求的书写顺序放宽。",
    wide: true
  },
  "embed.enabled": {
    group: "embed",
    label: "允许外部嵌入",
    kind: "toggle",
    heading: "card"
  },
  "embed.allowed_origins": {
    group: "embed",
    wide: true,
    label: "额外允许来源",
    kind: "lines",
    placeholder: "https://example.org\nhttps://*.example.net",
    hint: `每行一个 HTTPS origin，最多 ${runtimeConfigLimits["embed.allowed_origins"].maxItems} 项；支持最左侧子域通配符，不含路径或参数。`
  },
  "ingestion.max_file_size_mb": {
    group: "ingestion",
    label: "原始图片体积上限（MiB）",
    kind: "number",
    ...runtimeConfigLimits["ingestion.max_file_size_mb"],
    step: "any"
  },
  "ingestion.max_long_edge": {
    group: "ingestion",
    label: "原始图片长边上限（px）",
    kind: "number",
    ...runtimeConfigLimits["ingestion.max_long_edge"]
  },
  "ingestion.list_page_size": {
    group: "ingestion",
    label: "接入队列与批量编辑每页数量",
    kind: "number",
    ...runtimeConfigLimits["ingestion.list_page_size"]
  },
  "ingestion.commit_concurrency": {
    group: "ingestion",
    label: "服务器最终入库并发数",
    kind: "number",
    ...runtimeConfigLimits["ingestion.commit_concurrency"]
  },
  "upload.max_items": {
    group: "upload",
    label: "单次本地上传数量上限",
    kind: "number",
    ...runtimeConfigLimits["upload.max_items"]
  },
  "upload.browser_concurrency": {
    group: "upload",
    label: "单页面上传并发数",
    kind: "number",
    ...runtimeConfigLimits["upload.browser_concurrency"]
  },
  "upload.raw_concurrency": {
    group: "upload",
    label: "服务器原始文件接收并发数",
    kind: "number",
    ...runtimeConfigLimits["upload.raw_concurrency"]
  },
  "import.keep_original_link": {
    group: "import",
    wide: true,
    label: "保留原图链接的导入来源",
    kind: "choices",
    options: { url: "URL", jsonl: "JSONL", weibo: "微博" }
  },
  "import.auto_import": {
    group: "import",
    label: "解析后自动导入",
    kind: "toggle"
  },
  "import.fetch_timeout_seconds": {
    group: "import",
    label: "远程下载超时（秒）",
    kind: "number",
    ...runtimeConfigLimits["import.fetch_timeout_seconds"]
  },
  "import.max_items": {
    group: "import",
    label: "单次 URL / JSONL 导入数量上限",
    kind: "number",
    ...runtimeConfigLimits["import.max_items"]
  },
  "weibo.max_items": {
    group: "weibo",
    label: "单次微博链接数量上限",
    kind: "number",
    ...runtimeConfigLimits["weibo.max_items"]
  },
  "weibo.source_enabled": {
    group: "weibo",
    label: "保留微博来源链接",
    kind: "toggle"
  },
  "weibo.request_delay_seconds": {
    group: "weibo",
    wide: true,
    label: "微博请求间隔（秒）",
    kind: "range",
    ...runtimeConfigLimits["weibo.request_delay_seconds"],
    hint: "在最小值与最大值之间随机等待。"
  },
  "normalize.concurrency": {
    group: "normalize",
    label: "服务器图片处理并发数",
    kind: "number",
    ...runtimeConfigLimits["normalize.concurrency"]
  },
  "normalize.quality_step": {
    group: "normalize",
    label: "超体积质量递减步长",
    kind: "number",
    ...runtimeConfigLimits["normalize.quality_step"]
  },
  "normalize.large.quality": large.quality,
  "normalize.large.min_quality": large.min_quality,
  "normalize.large.max_long_edge": large.max_long_edge,
  "normalize.large.max_size_kb": large.max_size_kb,
  "normalize.medium.quality": medium.quality,
  "normalize.medium.min_quality": medium.min_quality,
  "normalize.medium.max_long_edge": medium.max_long_edge,
  "normalize.medium.max_size_kb": medium.max_size_kb,
  "normalize.small.quality": small.quality,
  "normalize.small.min_quality": small.min_quality,
  "normalize.small.max_long_edge": small.max_long_edge,
  "normalize.small.max_size_kb": small.max_size_kb,
  "admin.login_background": {
    group: "admin",
    wide: true,
    label: "登录页背景图",
    kind: "text",
    ...runtimeConfigLimits["admin.login_background"],
    placeholder: "留空使用随机图片",
    hint: "站内绝对路径或 HTTPS URL。"
  },
  "admin.image_page_size": {
    group: "admin",
    label: "图片管理每页数量",
    kind: "number",
    ...runtimeConfigLimits["admin.image_page_size"]
  },
  "admin.recent_uploads": {
    group: "admin",
    label: "概览最近上传展示数量",
    kind: "number",
    ...runtimeConfigLimits["admin.recent_uploads"]
  },
  "security.session_ttl_seconds": {
    group: "session",
    label: "登录会话有效期（秒）",
    kind: "number",
    ...runtimeConfigLimits["security.session_ttl_seconds"]
  },
  "security.login_failure_window_seconds": {
    group: "login",
    label: "单 IP 登录失败统计窗口（秒）",
    kind: "number",
    ...runtimeConfigLimits["security.login_failure_window_seconds"]
  },
  "security.login_max_failures": {
    group: "login",
    label: "单 IP 登录失败次数上限",
    kind: "number",
    ...runtimeConfigLimits["security.login_max_failures"]
  },
  "security.login_global_window_seconds": {
    group: "login",
    label: "全局登录尝试统计窗口（秒）",
    kind: "number",
    ...runtimeConfigLimits["security.login_global_window_seconds"]
  },
  "security.login_global_max_attempts": {
    group: "login",
    label: "全局登录尝试次数上限",
    kind: "number",
    ...runtimeConfigLimits["security.login_global_max_attempts"]
  },
  "security.random_window_seconds": {
    group: "rate",
    label: "随机 API 限流窗口（秒）",
    kind: "number",
    ...runtimeConfigLimits["security.random_window_seconds"]
  },
  "security.random_max_requests": {
    group: "rate",
    label: "单 IP 随机图片额度（张）",
    kind: "number",
    ...runtimeConfigLimits["security.random_max_requests"]
  },
  "security.random_limit_max_requests": {
    group: "rate",
    label: "单 IP 批量请求次数上限",
    kind: "number",
    ...runtimeConfigLimits["security.random_limit_max_requests"]
  },
  "altcha.enabled": {
    group: "altcha",
    label: "启用登录验证",
    kind: "toggle",
    heading: "card"
  },
  "altcha.ttl_seconds": {
    group: "altcha",
    label: "验证挑战有效期（秒）",
    kind: "number",
    ...runtimeConfigLimits["altcha.ttl_seconds"]
  },
  "altcha.cost": {
    group: "altcha",
    label: "验证工作成本",
    kind: "number",
    ...runtimeConfigLimits["altcha.cost"]
  },
  "altcha.counter_range": {
    group: "altcha",
    wide: true,
    label: "验证计数范围",
    kind: "range",
    ...runtimeConfigLimits["altcha.counter_range"]
  },
  "log.level": {
    group: "log",
    label: "日志等级",
    kind: "select",
    options: { DEBUG: "DEBUG", INFO: "INFO", WARN: "WARN", ERROR: "ERROR", OFF: "OFF" }
  },
  "log.max_size_mb": {
    group: "log",
    label: "单个日志文件上限（MiB）",
    kind: "number",
    ...runtimeConfigLimits["log.max_size_mb"],
    step: "any"
  },
  "log.max_files": {
    group: "log",
    label: "日志文件保留数量",
    kind: "number",
    ...runtimeConfigLimits["log.max_files"]
  }
} satisfies { [P in SettingsFieldPath]: FieldDefinition<ValueAtPath<RuntimeConfig, P>> };

export type SettingsField = FieldDefinition<string> | FieldDefinition<number>
  | FieldDefinition<boolean> | FieldDefinition<[number, number]> | FieldDefinition<string[]>;

export const settingsFieldEntries = Object.entries(settingsFields) as [SettingsFieldPath, SettingsField][];

export type SettingsValidationFailure = {
  fieldErrors: ReadonlyMap<SettingsFieldPath, string>;
  message: string;
};

// 服务端问题路径可能带数组下标（如多行来源的某一行），按最长前缀对应到表单字段。
function settingsFieldForIssuePath(issuePath: string) {
  let match: SettingsField | null = null;
  let matchPath: SettingsFieldPath | null = null;
  for (const [path, field] of settingsFieldEntries) {
    if (
      (issuePath === path || issuePath.startsWith(`${path}.`)) &&
      (!matchPath || path.length > matchPath.length)
    ) {
      match = field;
      matchPath = path;
    }
  }
  return matchPath && match ? { path: matchPath, field: match } : null;
}

/**
 * 把保存配置时的校验问题对应到表单字段：每个字段取第一条问题用于标出对应输入框；页面反馈在只有
 * 一处问题时写明字段与问题，多处时列出字段名，对应不上字段的问题原样列出。
 */
export function settingsValidationFailure(
  issues: readonly ApiValidationIssueDto[]
): SettingsValidationFailure | null {
  const fieldErrors = new Map<SettingsFieldPath, string>();
  const summaries: string[] = [];
  const unmatched: string[] = [];
  for (const { field, message } of issues) {
    const match = settingsFieldForIssuePath(field);
    if (!match) {
      unmatched.push(message);
      continue;
    }
    if (fieldErrors.has(match.path)) continue;
    fieldErrors.set(match.path, message);
    summaries.push(match.field.label);
  }
  const total = fieldErrors.size + unmatched.length;
  if (total === 0) return null;
  const [onlyPath] = fieldErrors.keys();
  const message = total === 1
    ? onlyPath
      ? `${summaries[0]}：${fieldErrors.get(onlyPath)}`
      : unmatched[0]
    : `${total} 项配置有误：${[...summaries, ...unmatched].join("、")}`;
  return { fieldErrors, message };
}

/**
 * Why a field cannot change in this draft, shown in place of its hint. Any
 * open public page falls back to the gallery, so the gallery closes after the
 * home and show pages and opens before them; the server enforces the same rule.
 */
export function settingsFieldLockReason(config: RuntimeConfig, path: SettingsFieldPath) {
  const { home, show, gallery } = config.site;
  if (path === "site.gallery.enabled" && gallery.enabled && (home.enabled || show.enabled)) {
    return "首页与展映都关闭后才能关闭";
  }
  if ((path === "site.home.enabled" || path === "site.show.enabled") && !gallery.enabled) {
    return "需先启用画廊";
  }
  return null;
}

export function settingsFieldValue(config: RuntimeConfig, path: SettingsFieldPath): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], config);
}

export function replaceSettingsField(config: RuntimeConfig, path: SettingsFieldPath, value: unknown) {
  const next = structuredClone(config);
  const keys = path.split(".");
  let owner = next as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) owner = owner[key] as Record<string, unknown>;
  owner[keys.at(-1)!] = value;
  return next;
}
