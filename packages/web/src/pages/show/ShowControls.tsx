import type { RefObject } from "react";
import { Link } from "react-router";
import { Icon, type IconName } from "../../components/icon/Icon.js";
import type { ShowOrder } from "@imageshow/shared/browser";
import { nextShowOrder } from "./show-layout.js";
import type { ShowPixiSceneKind } from "./pixi/show-pixi-types.js";

const orderLabels: Record<ShowOrder, string> = {
  random: "乱序",
  latest: "最新",
  oldest: "最旧"
};

const orderIcons: Record<ShowOrder, IconName> = {
  random: "shuffle-line",
  latest: "sort-desc",
  oldest: "sort-asc"
};

export function ShowControls({
  decreaseButtonRef,
  largerDisabled,
  onDecreaseSize,
  onIncreaseSize,
  onOrderChange,
  onReset,
  onRunningChange,
  getSceneHref,
  order,
  reducedMotion,
  running,
  scene,
  sizeDescription,
  smallerDisabled
}: {
  decreaseButtonRef: RefObject<HTMLButtonElement | null>;
  largerDisabled: boolean;
  onDecreaseSize: () => void;
  onIncreaseSize: () => void;
  onOrderChange: (order: ShowOrder) => void;
  onReset: () => void;
  onRunningChange: (running: boolean) => void;
  getSceneHref: (scene: ShowPixiSceneKind) => string;
  order: ShowOrder;
  reducedMotion: boolean;
  running: boolean;
  scene: ShowPixiSceneKind;
  sizeDescription: string;
  smallerDisabled: boolean;
}) {
  const nextOrder = nextShowOrder(order);
  const orderLabel = `排列顺序：${orderLabels[order]}；点击切换为${orderLabels[nextOrder]}`;
  const motionLabel = reducedMotion
    ? "系统减少动态效果已开启，自动滚动已关闭"
    : running ? "暂停自动滚动" : "继续自动滚动";
  const currentSize = sizeDescription;
  const nextScene = scene === "waterfall" ? "float" : "waterfall";
  const sceneLabel = `当前模式：${scene}；点击切换为 ${nextScene}`;
  return (
    <>
      <div className="show-density-actions" data-show-control="">
        <button
          ref={decreaseButtonRef}
          type="button"
          className="show-round-control pressable"
          aria-label={`缩小图片；${currentSize}`}
          title={smallerDisabled ? "图片已达到最小尺寸" : `缩小图片（${currentSize}）`}
          disabled={smallerDisabled}
          onClick={onDecreaseSize}
        >
          <span className="show-round-surface">
            <Icon name="subtract-line" />
          </span>
        </button>
        <button
          type="button"
          className="show-round-control pressable"
          aria-label={`放大图片；${currentSize}`}
          title={largerDisabled
            ? "图片已达到最大尺寸"
            : `放大图片（${currentSize}）`}
          disabled={largerDisabled}
          onClick={onIncreaseSize}
        >
          <span className="show-round-surface">
            <Icon name="add-line" />
          </span>
        </button>
        <button
          type="button"
          className="show-round-control pressable show-density-reset"
          aria-label="恢复默认图片大小"
          title="恢复默认图片大小"
          onClick={onReset}
        >
          <span className="show-round-surface">
            <Icon name="reset-left-line" />
          </span>
        </button>
      </div>
      <div className="show-corner-actions" data-show-control="">
        <button
          type="button"
          className="show-round-control pressable"
          aria-label={orderLabel}
          title={orderLabel}
          onClick={() => onOrderChange(nextOrder)}
        >
          <span className="show-round-surface">
            <Icon name={orderIcons[order]} />
          </span>
        </button>
        <button
          type="button"
          className="show-round-control pressable"
          aria-label={motionLabel}
          aria-pressed={!running}
          disabled={reducedMotion}
          title={motionLabel}
          onClick={() => onRunningChange(!running)}
        >
          <span className="show-round-surface">
            <Icon name={running && !reducedMotion ? "pause-fill" : "play-fill"} />
          </span>
        </button>
        <Link
          to={getSceneHref(nextScene)}
          className="button show-round-control pressable show-scene-control"
          aria-label={sceneLabel}
          title={sceneLabel}
        >
          <span className="show-round-surface">
            <Icon name="slideshow-3-line" />
          </span>
        </Link>
      </div>
      <span className="sr-only" aria-live="polite">
        当前排列顺序：{orderLabels[order]}
        ；当前模式：{scene}
      </span>
    </>
  );
}
