import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../lib/api/client.js";
import { ThumbImage } from "../../components/image/ThumbImage.js";
import { adminApiBasePath, adminBasePath, queryKeys } from "../../lib/constants.js";
import { formatBytes } from "../../lib/ui/formatters.js";

type RecentImage = { id: string; title: string; thumb_url: string; created_at: string | null };
type ThemeCount = { theme: string; count: number };
type OverviewStats = {
  gallery: number;
  theme_unset: number;
  trash: number;
  total: number;
  local: number;
  nonlocal: number;
  link_count: number;
  local_image_size: number;
  local_thumb_size: number;
  nonlocal_image_size: number;
  nonlocal_thumb_size: number;
  link_local_size: number;
  link_nonlocal_size: number;
  theme_count: number;
  backend_count: number;
  pc: number;
  mb: number;
  dark: number;
  light: number;
  top_themes: ThemeCount[];
  recent: RecentImage[];
};

type Card = { label: string; value?: number | string; hint?: string; hintTitle?: string; to?: string };

function Cards({ items }: { items: Card[] }) {
  return (
    <div className="overview-cards">
      {items.map((item) => {
        const body = (
          <>
            <span className="overview-card-value">{item.value ?? "—"}</span>
            <span className="overview-card-label">{item.label}</span>
            {item.hint && <span className="overview-card-hint" title={item.hintTitle}>{item.hint}</span>}
          </>
        );
        return item.to
          ? (
            <Link className="overview-card overview-card-link pressable" key={item.label} to={item.to}>
              {body}
            </Link>
          )
          : <div className="overview-card" key={item.label}>{body}</div>;
      })}
    </div>
  );
}

export function Overview() {
  const { data } = useQuery<OverviewStats>({ queryKey: queryKeys.overview, queryFn: () => api(`${adminApiBasePath}/overview`) });
  const imageCards: Card[] = [
    { label: "图库", value: data?.gallery, hint: "已分类展示", to: `${adminBasePath}/images` },
    { label: "未设置主题", value: data?.theme_unset, hint: "缺少主题", to: `${adminBasePath}/images?view=unset` },
    { label: "回收站", value: data?.trash, hint: "可恢复", to: `${adminBasePath}/images?view=deleted` },
    { label: "主题", value: data?.theme_count, hint: "图库主题数", to: `${adminBasePath}/themes` }
  ];
  const deviceCards: Card[] = [
    { label: "桌面", value: data?.pc },
    { label: "移动", value: data?.mb },
    { label: "暗色", value: data?.dark },
    { label: "亮色", value: data?.light }
  ];
  // 原图大小 + 缩略图大小（或链接图的本地占用 + 其它存储占用），用「+」拼成卡片副标题。
  const sizePair = (first?: number, second?: number) =>
    first === undefined || second === undefined ? undefined : `${formatBytes(first)} + ${formatBytes(second)}`;
  // 卡片副标题只显示「X + Y」两个体积；hover 的 title 再标明每段各是什么，避免用户不清楚 + 两边的含义。
  const sizeTitle = (firstLabel: string, first: number | undefined, secondLabel: string, second: number | undefined) =>
    first === undefined || second === undefined ? undefined : `${firstLabel} ${formatBytes(first)} + ${secondLabel} ${formatBytes(second)}`;
  const storageCards: Card[] = [
    // 本地存储 / 其它存储的非链接图片（原图+缩略图，不含链接图）、链接图缩略图（本地+其它存储）、当前存储后端数。
    { label: "本地存储", value: data?.local,
      hint: sizePair(data?.local_image_size, data?.local_thumb_size),
      hintTitle: sizeTitle("原图", data?.local_image_size, "缩略图", data?.local_thumb_size) },
    { label: "其它存储", value: data?.nonlocal,
      hint: sizePair(data?.nonlocal_image_size, data?.nonlocal_thumb_size),
      hintTitle: sizeTitle("原图", data?.nonlocal_image_size, "缩略图", data?.nonlocal_thumb_size) },
    { label: "链接图片", value: data?.link_count,
      hint: sizePair(data?.link_local_size, data?.link_nonlocal_size),
      hintTitle: sizeTitle("本地", data?.link_local_size, "其它存储", data?.link_nonlocal_size) },
    { label: "存储后端", value: data?.backend_count }
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
            <h2>存储与大小</h2>
            <Cards items={storageCards} />
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
                  <Link
                    className="overview-recent-item"
                    key={img.id}
                    to={`${adminBasePath}/images`}
                    title={img.title || img.id}
                  >
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
