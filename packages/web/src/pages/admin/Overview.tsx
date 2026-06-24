import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../lib/api.js";
import { Icon } from "../../components/Icon.js";
import { ThumbImage } from "../../components/ThumbImage.js";
import { adminApiBasePath, adminBasePath } from "../../lib/constants.js";
import { storageBackendShortLabel } from "../../lib/select-options.js";

type RecentImage = { id: string; title: string; thumb_url: string; created_at: string | null };
type ThemeCount = { theme: string; count: number };
type OverviewStats = {
  gallery: number;
  unset: number;
  trash: number;
  total: number;
  local: number;
  s3: number;
  theme_count: number;
  default_backend: string;
  pc: number;
  mb: number;
  dark: number;
  light: number;
  pending_tasks: number;
  top_themes: ThemeCount[];
  recent: RecentImage[];
};

type Card = { label: string; value?: number | string; hint?: string };

function Cards({ items }: { items: Card[] }) {
  return (
    <div className="overview-cards">
      {items.map((item) => (
        <div className="overview-card" key={item.label}>
          <span className="overview-card-value">{item.value ?? "—"}</span>
          <span className="overview-card-label">{item.label}</span>
          {item.hint && <span className="overview-card-hint">{item.hint}</span>}
        </div>
      ))}
    </div>
  );
}

export function Overview() {
  const { data } = useQuery<OverviewStats>({ queryKey: ["admin-overview"], queryFn: () => api(`${adminApiBasePath}/overview`) });
  const imageCards: Card[] = [
    { label: "图库", value: data?.gallery, hint: "已分类展示" },
    { label: "未设置", value: data?.unset, hint: "缺少设备或亮度" },
    { label: "回收站", value: data?.trash, hint: "可恢复" },
    { label: "主题", value: data?.theme_count, hint: "图库主题数" }
  ];
  const deviceCards: Card[] = [
    { label: "桌面", value: data?.pc },
    { label: "移动", value: data?.mb },
    { label: "暗色", value: data?.dark },
    { label: "亮色", value: data?.light }
  ];
  const storageCards: Card[] = [
    { label: storageBackendShortLabel("local"), value: data?.local },
    { label: storageBackendShortLabel("s3"), value: data?.s3 },
    { label: "默认上传", value: data ? storageBackendShortLabel(data.default_backend) : undefined },
    { label: "待处理任务", value: data?.pending_tasks }
  ];
  return (
    <section className="workspace overview">
      <header className="workspace-head">
        <div>
          <h1>概览</h1>
          <p>图片库与存储概况 · 共 {data?.total ?? 0} 张图片</p>
        </div>
      </header>

      <div className="overview-grid">
        <div className="overview-main">
          <Cards items={imageCards} />

          <div className="overview-section">
            <h2>设备与亮度</h2>
            <Cards items={deviceCards} />
          </div>

          <div className="overview-section">
            <h2>存储与任务</h2>
            <Cards items={storageCards} />
          </div>

          <div className="overview-section">
            <h2>快捷入口</h2>
            <div className="overview-links">
              <Link className="button secondary pressable" to={`${adminBasePath}/images`}><Icon name="image-line" />图片管理</Link>
              <Link className="button secondary pressable" to={`${adminBasePath}/settings`}><Icon name="settings-3-line" />设置</Link>
              <Link className="button secondary pressable" to={`${adminBasePath}/check`}><Icon name="checkbox-circle-line" />检查</Link>
            </div>
          </div>
        </div>

        <div className="overview-side">
          {!!data?.top_themes?.length && (
            <div className="overview-section">
              <h2>热门主题</h2>
              <div className="overview-themes">
                {data.top_themes.map((item) => (
                  <span className="overview-theme-chip" key={item.theme}>{item.theme}<b>{item.count}</b></span>
                ))}
              </div>
            </div>
          )}

          {!!data?.recent?.length && (
            <div className="overview-section">
              <h2>最近上传</h2>
              <div className="overview-recent">
                {data.recent.map((img) => (
                  <Link className="overview-recent-item" key={img.id} to={`${adminBasePath}/images`} title={img.title || img.id}>
                    <ThumbImage src={img.thumb_url} alt="" />
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
