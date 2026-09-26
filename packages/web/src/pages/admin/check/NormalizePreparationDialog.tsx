import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  adminApiBasePath, defaultPreparationProfile, imageVariants, parsePreparationProfile, variantSettingLimits,
  type ImageVariant, type PreparationAction, type PreparationStatusDto, type VariantSettings
} from "@imageshow/shared/browser";
import { DialogFrame } from "../../../components/feedback/DialogFrame.js";
import { api, apiResponse } from "../../../lib/api/client.js";
import { formatBytes } from "../../../lib/ui/formatters.js";
import "../../../styles/admin/normalize-preparation.css";

const base = `${adminApiBasePath}/check/normalize-preparation`;
const labels: Record<ImageVariant, string> = { large: "大图 large", middle: "中图 middle", small: "小图 small" };
const fields: Array<{ key: keyof VariantSettings; label: string; min?: number; max?: number }> = [
  { key: "quality", label: "初始质量", min: 50, max: 100 },
  { key: "min_quality", label: "最低质量", min: 1, max: 80 },
  { key: "max_long_edge", label: "长边上限 px" },
  { key: "max_size_kb", label: "目标体积 KiB" },
  { key: "webp_effort", label: "WebP effort", min: 0, max: 6 }
];

export default function NormalizePreparationDialog({ onClose }: { onClose(): void }) {
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState(defaultPreparationProfile);
  const [concurrency, setConcurrency] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sample, setSample] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const loadedRun = useRef<string | null>(null);
  const query = useQuery({
    queryKey: ["admin", "normalize-preparation", page],
    queryFn: ({ signal }) => api<PreparationStatusDto>(`${base}/status?page=${page}`, { signal }),
    refetchInterval: (state) => state.state.data && ["生成中", "核验中", "正在停止", "等待调度", "恢复等待", "随机休息"].includes(state.state.data.state) ? 2_000 : 10_000,
    refetchOnWindowFocus: false,
    retry: false
  });
  const status = query.data;
  useEffect(() => {
    if (!status || loadedRun.current === (status.run_id ?? "new")) return;
    loadedRun.current = status.run_id ?? "new";
    setDraft(structuredClone(status.profile));
    setConcurrency(status.concurrency);
  }, [status]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const frozen = Boolean(status?.run_id && (status.desired_state === "running" || status.active.length || status.state === "正在停止"));
  let validation = "";
  try { parsePreparationProfile(draft); } catch (reason) { validation = reason instanceof Error ? reason.message : "参数无效"; }
  const changed = status?.run_id && JSON.stringify(status.profile) !== JSON.stringify(draft);
  const changedTiers = status ? imageVariants.filter((variant) => draft.quality_step !== status.profile.quality_step
    || JSON.stringify(draft[variant]) !== JSON.stringify(status.profile[variant])) : [];
  const serverOffset = status ? Date.parse(status.server_time) - query.dataUpdatedAt : 0;
  const restSeconds = status?.rest?.deadline ? Math.max(0, Math.ceil((Date.parse(status.rest.deadline) - now - serverOffset) / 1000)) : status?.rest?.seconds;

  async function control(action: PreparationAction) {
    if (!status) return;
    setBusy(true);
    setError("");
    try {
      await api(`${base}/control`, { method: "POST", body: JSON.stringify({
        action, revision: status.revision,
        ...(action === "start" ? { profile: parsePreparationProfile(draft), concurrency } : {}),
        ...(action === "set-concurrency" ? { concurrency } : {})
      }) });
      await query.refetch();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
      await query.refetch();
    } finally { setBusy(false); }
  }

  return <DialogFrame className="normalize-preparation-modal" titleId="normalize-preparation-title" onClose={onClose}>
    {({ requestClose }) => <section className="normalize-preparation-panel">
      <header className="normalize-preparation-heading">
        <div><h2 id="normalize-preparation-title">三档图片预生成</h2><p>从原图生成 l / m / s。关闭弹窗后后台任务继续运行。</p></div>
        <button type="button" onClick={() => requestClose()}>关闭</button>
      </header>
      <div className="normalize-preparation-body">
        {!status && <p>{query.error ? query.error.message : "正在读取任务状态…"}</p>}
        {status && <>
          <div className="normalize-preparation-summary" aria-live="polite">
            <strong>{status.state}</strong>
            <span>三档就绪 {status.counts.ready} / 当前保留 {status.total}</span>
            <span>活动 {status.active.length} / 目标并发 {status.concurrency}</span>
            <span>失败 {status.counts.failed} · 待核对 {status.counts.stale} · 已删除 {status.counts.excluded}</span>
            <span>尚未扫描 {status.untracked} · 等待实际永久删除 {status.deletion_pending}</span>
            <progress max={Math.max(1, status.total)} value={Math.min(status.total, status.counts.ready)} />
          </div>
          <p>已记录成品：large {status.variant_counts.large} · middle {status.variant_counts.middle} · small {status.variant_counts.small}。最终以完整核验为准。</p>
          {status.block && <p role="alert" className="normalize-preparation-notice">{status.block}。处理后显式点击继续或核验。</p>}
          {status.rest && <p>随机休息：{status.rest.kind === "long" ? "长休息" : "短休息"}，{status.rest.deadline ? `剩余 ${restSeconds} 秒` : `等待活动图片退出后休息 ${restSeconds} 秒`}。</p>}
          <p>累计完成逻辑尝试 {status.completed_attempts} 次。每 18 次休息 5–30 秒，每 100 次休息 50–180 秒；同时触发只执行长休息。</p>
          {status.verified_at && <p>全量核验完成：{new Date(status.verified_at).toLocaleString()}。生产切换仍需人工抽查确认。</p>}
          <h3>{frozen ? "本轮冻结的处理参数" : "预生成参数"}</h3>
          <fieldset disabled={frozen || busy} className="normalize-preparation-settings">
            {imageVariants.map((variant) => <div key={variant} className="normalize-preparation-tier">
              <h4>{labels[variant]}</h4>
              {fields.map((field) => {
                const range = field.key === "max_long_edge" || field.key === "max_size_kb" ? variantSettingLimits[variant][field.key] : [field.min!, field.max!];
                return <label key={field.key}>
                  <span>{field.label} <small>{range[0]}–{range[1]}</small></span>
                  <input type="number" min={range[0]} max={range[1]} step={1} value={draft[variant][field.key]}
                    onChange={(event) => setDraft((value) => ({ ...value, [variant]: { ...value[variant], [field.key]: Number(event.target.value) } }))} />
                </label>;
              })}
            </div>)}
            <label className="normalize-preparation-step">质量递减步长 1–20
              <input type="number" min={1} max={20} step={1} value={draft.quality_step} onChange={(event) => setDraft((value) => ({ ...value, quality_step: Number(event.target.value) }))} />
            </label>
            <button type="button" onClick={() => setDraft(defaultPreparationProfile())}>恢复默认参数</button>
          </fieldset>
          <p>仅 large 可保留原 WebP：原图须小于 large 目标体积且长边达标。middle / small 始终按各档规则编码；质量触底仍超体积时允许保留超限结果。</p>
          {changed && <p className="normalize-preparation-notice">新参数影响：{changedTiers.map((variant) => labels[variant]).join("、")}。开始后建立新一轮任务，核对原图及有效处理条件后复用合格文件，其余重新生成。</p>}
          {validation && <p role="alert">{validation}</p>}
          <div className="normalize-preparation-controls">
            <label>图片并发数 <input type="number" min={1} max={8} step={1} value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} /></label>
            <button type="button" disabled={busy || !status.run_id || concurrency < 1 || concurrency > 8 || !Number.isInteger(concurrency)} onClick={() => void control("set-concurrency")}>应用并发数</button>
            <span>降低并发时，已开始的图片自然完成。</span>
          </div>
          {status.active.length > 0 && <div className="normalize-preparation-active">{status.active.map((item) => <div key={item.image_id}>
            <strong>{item.title || item.image_id}</strong><span>{item.phase} · 当前阶段 {Math.max(0, Math.floor((now + serverOffset - Date.parse(item.updated_at)) / 1000))} 秒</span>
          </div>)}</div>}
          <h3>处理结果</h3>
          <div className="normalize-preparation-results">{status.items.map((item) => <article key={item.image_id}>
            <header><strong>{item.title || item.image_id}</strong><span>{item.state} · {item.phase}</span>
              <button type="button" onClick={() => setSample(item.image_id)} disabled={!Object.keys(item.variants).length}>对照抽查</button></header>
            {imageVariants.map((variant) => {
              const facts = item.variants[variant];
              return <p key={variant}><b>{labels[variant]}</b> {facts ? `${facts.width} × ${facts.height} · ${formatBytes(facts.bytes)} · ${facts.passthrough ? "原 WebP 保留" : `Q${facts.quality} / effort ${facts.effort}`}${facts.over_target ? " · 质量触底，体积超限" : ""}` : "未就绪"}</p>;
            })}
            {item.error && <p role="status">{item.error}</p>}
          </article>)}</div>
          <div className="normalize-preparation-controls">
            <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button>
            <span>{page} / {status.pages}</span>
            <button type="button" disabled={page >= status.pages} onClick={() => setPage((value) => value + 1)}>下一页</button>
          </div>
        </>}
        {(error || query.error) && <p role="alert">{error || query.error?.message}</p>}
      </div>
      <footer className="normalize-preparation-controls">
        <button type="button" disabled={busy || !status || Boolean(validation) || status.state === "正在停止" || status.mode === "verify" && status.active.length > 0} onClick={() => void control("start")}>{changed ? "使用新参数开始" : "开始 / 继续生成"}</button>
        <button type="button" disabled={busy || !status?.run_id} onClick={() => void control("stop")}>停止</button>
        <button type="button" disabled={busy || !status?.run_id || status.active.length > 0} onClick={() => void control("verify")}>完整核验</button>
        <button type="button" disabled={busy || !status?.run_id} onClick={() => void control("retry")}>重试失败 / 失效项</button>
        <button type="button" disabled={busy || !status?.run_id} onClick={() => void control("reconcile")}>核对图库变更</button>
        {status?.run_id && <a href={`${base}/export`} download>导出核验清单</a>}
      </footer>
      {sample && <PreparationSample imageId={sample} onClose={() => setSample(null)} />}
    </section>}
  </DialogFrame>;
}

function PreparationSample({ imageId, onClose }: { imageId: string; onClose(): void }) {
  const [urls, setUrls] = useState<Partial<Record<ImageVariant | "original", string>>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [actualSize, setActualSize] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const allocated: string[] = [];
    void (async () => {
      for (const variant of ["original", ...imageVariants] as const) {
        try {
          const response = await apiResponse(`${base}/preview/${imageId}/${variant}`, { signal: controller.signal });
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          const url = URL.createObjectURL(blob);
          allocated.push(url);
          setUrls((value) => ({ ...value, [variant]: url }));
        } catch (reason) {
          if (controller.signal.aborted) return;
          setErrors((value) => ({ ...value, [variant]: reason instanceof Error ? reason.message : "读取失败" }));
        }
      }
    })();
    return () => { controller.abort(); for (const url of allocated) URL.revokeObjectURL(url); };
  }, [imageId]);
  return <DialogFrame className="normalize-preparation-modal" ariaLabel="原图与三档对照" onClose={onClose}>
    {({ requestClose }) => <section className="normalize-preparation-panel">
      <header className="normalize-preparation-heading"><h2>原图与三档对照</h2>
        <label><input type="checkbox" checked={actualSize} onChange={(event) => setActualSize(event.target.checked)} />100% 像素</label>
        <button type="button" onClick={() => requestClose()}>关闭对照</button></header>
      <p>原图重新下载并核对输入摘要；地址内容变化时会提示，避免与错误原图对比。</p>
      <div className={`normalize-preparation-samples ${actualSize ? "actual-size" : ""}`}>
        {(["original", ...imageVariants] as const).map((variant) => <figure key={variant}>
          <figcaption>{variant === "original" ? "原图" : labels[variant]}</figcaption>
          <div>{urls[variant] ? <img src={urls[variant]} alt={variant} /> : <p>{errors[variant] || "读取中…"}</p>}</div>
        </figure>)}
      </div>
    </section>}
  </DialogFrame>;
}
