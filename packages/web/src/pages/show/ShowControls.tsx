import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link } from "react-router";
import {
  publicImageOrders,
  showClusterGroups,
  showModes,
  type ShowClusterGroup,
  type ShowMode,
  type ShowOrder
} from "@imageshow/shared/browser";
import { Icon, type IconName } from "../../components/icon/Icon.js";
import {
  publicImageOrderIcons,
  publicImageOrderLabels,
  PublicToolbarPopover
} from "../../components/navigation/PublicImageToolbar.js";
import { mobileViewportMediaQuery, useMediaQuery } from "../../hooks/useMediaQuery.js";

const showModeLabels: Record<ShowMode, string> = {
  waterfall: "瀑布",
  float: "漂浮",
  cluster: "星群"
};
export const showClusterGroupLabels: Record<ShowClusterGroup, string> = {
  theme: "主题",
  tag: "标签",
  author: "作者"
};
const compactOrderLabels: Record<ShowOrder, string> = {
  random: "随机",
  latest: "最新",
  oldest: "最旧"
};

export function ShowSizeControls({
  sizeControlRef,
  largerDisabled,
  onDecreaseSize,
  onIncreaseSize,
  onReset,
  sizeDescription,
  smallerDisabled,
  resetDisabled = false,
  labels
}: {
  sizeControlRef: RefObject<HTMLButtonElement | null>;
  largerDisabled: boolean;
  onDecreaseSize: () => void;
  onIncreaseSize: () => void;
  onReset: () => void;
  sizeDescription: string;
  smallerDisabled: boolean;
  resetDisabled?: boolean;
  /** 三个按钮在当前画面里的含义不是“图片大小”时，由画面给出各自的说明。 */
  labels?: { group: string; decrease: string; increase: string; reset: string };
}) {
  const mobile = useMediaQuery(mobileViewportMediaQuery);
  const buttonClass = mobile ? "public-round-control pressable" : "public-toolbar-button is-icon";
  const icon = (name: "subtract-line" | "add-line" | "reset-left-line") =>
    mobile ? (
      <span className="public-round-surface">
        <Icon name={name} />
      </span>
    ) : (
      <Icon name={name} />
    );
  return (
    <div
      className="show-toolbar-size"
      role="group"
      aria-label={labels?.group ?? `图片大小：${sizeDescription}`}
    >
      <button
        ref={sizeControlRef}
        type="button"
        className={buttonClass}
        aria-label={labels?.decrease ?? `缩小图片；${sizeDescription}`}
        title={
          labels?.decrease ??
          (smallerDisabled ? "图片已达到最小尺寸" : `缩小图片（${sizeDescription}）`)
        }
        disabled={smallerDisabled}
        onClick={onDecreaseSize}
      >
        {icon("subtract-line")}
      </button>
      <button
        type="button"
        className={buttonClass}
        aria-label={labels?.increase ?? `放大图片；${sizeDescription}`}
        title={
          labels?.increase ??
          (largerDisabled ? "图片已达到最大尺寸" : `放大图片（${sizeDescription}）`)
        }
        disabled={largerDisabled}
        onClick={onIncreaseSize}
      >
        {icon("add-line")}
      </button>
      <button
        type="button"
        className={buttonClass}
        aria-label={labels?.reset ?? "恢复默认图片大小"}
        title={labels?.reset ?? "恢复默认图片大小"}
        disabled={resetDisabled}
        onClick={onReset}
      >
        {icon("reset-left-line")}
      </button>
    </div>
  );
}

function ShowModeLinks({
  className,
  getSceneHref,
  onSelect,
  scene
}: {
  className?: string;
  getSceneHref: (scene: ShowMode) => string;
  onSelect?: () => void;
  scene: ShowMode;
}) {
  return (
    <>
      {showModes.map((mode) => (
        <Link
          key={mode}
          to={getSceneHref(mode)}
          className={
            [className, scene === mode ? "is-active" : ""].filter(Boolean).join(" ") || undefined
          }
          aria-current={scene === mode ? "true" : undefined}
          onClick={(event) => {
            if (scene === mode) event.preventDefault();
            onSelect?.();
          }}
        >
          {showModeLabels[mode]}
        </Link>
      ))}
    </>
  );
}

export function ShowToolbarControls({
  getSceneHref,
  scene
}: {
  getSceneHref: (scene: ShowMode) => string;
  scene: ShowMode;
}) {
  const compact = useMediaQuery("(max-width: 900px)");
  const modes = (close?: () => void) => (
    <div className="show-toolbar-mode" role="group" aria-label="展映模式">
      <ShowModeLinks scene={scene} getSceneHref={getSceneHref} onSelect={close} />
    </div>
  );
  return compact ? (
    <PublicToolbarPopover label="画面" icon="slideshow-3-line">
      {(close) => (
        <>
          <strong>展映画面</strong>
          <div className="show-toolbar-settings">{modes(close)}</div>
        </>
      )}
    </PublicToolbarPopover>
  ) : (
    modes()
  );
}

/** 星群模式下占据副导航的筛选位置：切换用哪一种分类聚成星团。 */
export function ShowClusterGroupControl({
  getGroupHref,
  group
}: {
  getGroupHref: (group: ShowClusterGroup) => string;
  group: ShowClusterGroup;
}) {
  return (
    <div className="public-filter-buttons show-cluster-groups" role="group" aria-label="星群分组">
      {showClusterGroups.map((value) => (
        <Link
          key={value}
          to={getGroupHref(value)}
          className={`public-toolbar-button${group === value ? " is-active" : ""}`}
          aria-current={group === value ? "true" : undefined}
          onClick={(event) => {
            if (group === value) event.preventDefault();
          }}
        >
          {showClusterGroupLabels[value]}
        </Link>
      ))}
    </div>
  );
}

type ShowPlaybackProps = {
  onRunningChange: (running: boolean) => void;
  reducedMotion: boolean;
  running: boolean;
};

export function ShowPlaybackButton({
  onRunningChange,
  reducedMotion,
  running,
  floating = false
}: ShowPlaybackProps & { floating?: boolean }) {
  const motionLabel = reducedMotion
    ? "系统减少动态效果已开启，自动滚动已关闭"
    : running
      ? "暂停自动滚动"
      : "继续自动滚动";
  const icon = <Icon name={running && !reducedMotion ? "pause-fill" : "play-fill"} />;
  return (
    <button
      type="button"
      className={floating ? "public-round-control pressable" : "public-toolbar-button is-icon"}
      aria-label={motionLabel}
      aria-pressed={!running}
      disabled={reducedMotion}
      title={motionLabel}
      onClick={() => onRunningChange(!running)}
    >
      {floating ? <span className="public-round-surface">{icon}</span> : icon}
    </button>
  );
}

/** 移动端浮动按钮：点按后选项向左展开，选中、点按别处或按 Esc 收起。 */
function ShowMobileFlyout({
  children,
  icon,
  label
}: {
  children: (close: () => void) => ReactNode;
  icon: IconName;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const { signal } = controller;
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) {
          setOpen(false);
        }
      },
      { capture: true, signal }
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
      },
      { capture: true, signal }
    );
    return () => controller.abort();
  }, [open]);
  return (
    <div ref={rootRef} className="show-mobile-flyout">
      {open && (
        <div id={id} className="show-mobile-flyout-options" role="group" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      )}
      <button
        ref={triggerRef}
        type="button"
        className="public-round-control pressable"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="public-round-surface">
          <Icon name={icon} />
        </span>
      </button>
    </div>
  );
}

export function ShowMobileControls({
  scene,
  getSceneHref,
  order,
  onOrderChange,
  ...playback
}: ShowPlaybackProps & {
  scene: ShowMode;
  getSceneHref: (scene: ShowMode) => string;
  order: ShowOrder;
  onOrderChange: (order: ShowOrder) => void;
}) {
  return (
    <>
      <ShowPlaybackButton {...playback} floating />
      <ShowMobileFlyout
        label={`排列顺序：${publicImageOrderLabels[order]}`}
        icon={publicImageOrderIcons[order]}
      >
        {(close) =>
          publicImageOrders.map((value) => (
            <button
              key={value}
              type="button"
              className={`show-mobile-flyout-option pressable${order === value ? " is-active" : ""}`}
              aria-label={publicImageOrderLabels[value]}
              aria-pressed={order === value}
              onClick={() => {
                if (order !== value) onOrderChange(value);
                close();
              }}
            >
              {compactOrderLabels[value]}
            </button>
          ))
        }
      </ShowMobileFlyout>
      <ShowMobileFlyout label={`展映画面：${showModeLabels[scene]}`} icon="slideshow-3-line">
        {(close) => (
          <ShowModeLinks
            className="show-mobile-flyout-option pressable"
            scene={scene}
            getSceneHref={getSceneHref}
            onSelect={close}
          />
        )}
      </ShowMobileFlyout>
    </>
  );
}
