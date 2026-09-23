import type { RefObject } from "react";
import { Link } from "react-router";
import type { ShowMode } from "@imageshow/shared/browser";
import { Icon } from "../../components/icon/Icon.js";
import { PublicToolbarPopover } from "../../components/navigation/PublicImageToolbar.js";
import { mobileViewportMediaQuery, useMediaQuery } from "../../hooks/useMediaQuery.js";

export function ShowSizeControls({
  sizeControlRef, largerDisabled, onDecreaseSize, onIncreaseSize, onReset,
  sizeDescription, smallerDisabled
}: {
  sizeControlRef: RefObject<HTMLButtonElement | null>;
  largerDisabled: boolean;
  onDecreaseSize: () => void;
  onIncreaseSize: () => void;
  onReset: () => void;
  sizeDescription: string;
  smallerDisabled: boolean;
}) {
  const mobile = useMediaQuery(mobileViewportMediaQuery);
  const buttonClass = mobile ? "public-round-control pressable" : "public-toolbar-button is-icon";
  const icon = (name: "subtract-line" | "add-line" | "reset-left-line") => mobile
    ? <span className="public-round-surface"><Icon name={name} /></span> : <Icon name={name} />;
  return <div className="show-toolbar-size" role="group" aria-label={`图片大小：${sizeDescription}`}>
      <button ref={sizeControlRef} type="button" className={buttonClass}
        aria-label={`缩小图片；${sizeDescription}`} title={smallerDisabled ? "图片已达到最小尺寸" : `缩小图片（${sizeDescription}）`}
        disabled={smallerDisabled} onClick={onDecreaseSize}>{icon("subtract-line")}</button>
      <button type="button" className={buttonClass}
        aria-label={`放大图片；${sizeDescription}`} title={largerDisabled ? "图片已达到最大尺寸" : `放大图片（${sizeDescription}）`}
        disabled={largerDisabled} onClick={onIncreaseSize}>{icon("add-line")}</button>
      <button type="button" className={buttonClass} aria-label="恢复默认图片大小" title="恢复默认图片大小"
        onClick={onReset}>{icon("reset-left-line")}</button>
    </div>;
}

export function ShowToolbarControls({ getSceneHref, scene }: {
  getSceneHref: (scene: ShowMode) => string;
  scene: ShowMode;
}) {
  const compact = useMediaQuery("(max-width: 900px)");
  const modes = (close?: () => void) => <div className="show-toolbar-mode" role="group" aria-label="展映模式">
    {(["waterfall", "float"] as const).map((mode) => <Link key={mode}
      to={getSceneHref(mode)} className={scene === mode ? "is-active" : undefined}
      aria-current={scene === mode ? "true" : undefined} onClick={(event) => {
        if (scene === mode) event.preventDefault();
        close?.();
      }}>
      {mode === "waterfall" ? "瀑布" : "漂浮"}
    </Link>)}
  </div>;
  return compact ? <PublicToolbarPopover label="画面" icon="slideshow-3-line">
    {(close) => <><strong>展映画面</strong><div className="show-toolbar-settings">{modes(close)}</div></>}
  </PublicToolbarPopover> : modes();
}

type ShowPlaybackProps = {
  onRunningChange: (running: boolean) => void;
  reducedMotion: boolean;
  running: boolean;
};

export function ShowPlaybackButton({ onRunningChange, reducedMotion, running, floating = false }: ShowPlaybackProps & { floating?: boolean }) {
  const motionLabel = reducedMotion
    ? "系统减少动态效果已开启，自动滚动已关闭"
    : running ? "暂停自动滚动" : "继续自动滚动";
  const icon = <Icon name={running && !reducedMotion ? "pause-fill" : "play-fill"} />;
  return <button type="button" className={floating ? "public-round-control pressable" : "public-toolbar-button is-icon"}
      aria-label={motionLabel} aria-pressed={!running} disabled={reducedMotion}
      title={motionLabel} onClick={() => onRunningChange(!running)}>
      {floating ? <span className="public-round-surface">{icon}</span> : icon}
    </button>;
}

export function ShowMobileControls({ scene, getSceneHref, ...playback }: ShowPlaybackProps & {
  scene: ShowMode; getSceneHref: (scene: ShowMode) => string;
}) {
  const next = scene === "waterfall" ? "float" : "waterfall";
  const label = `当前画面：${scene === "waterfall" ? "瀑布" : "漂浮"}；点击切换为${next === "waterfall" ? "瀑布" : "漂浮"}`;
  return <><ShowPlaybackButton {...playback} floating />
    <Link className="button public-round-control pressable show-scene-control" to={getSceneHref(next)} aria-label={label} title={label}>
      <span className="public-round-surface"><Icon name="slideshow-3-line" /></span>
    </Link>
  </>;
}
