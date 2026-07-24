import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  brightnesses as imageBrightnesses,
  devices as imageDevices
} from "@imageshow/shared/browser";
import { FacetSelector } from "../../components/data-display/FacetSelector.js";
import { Icon } from "../../components/icon/Icon.js";
import { SelectMenu } from "../../components/form/SelectMenu.js";
import {
  brightnessOptionLabel,
  deviceOptionLabel
} from "../../lib/ui/select-options.js";
import type { FacetOption } from "../../lib/types.js";
import { AnchoredMenuDismissSignalContext } from "../../hooks/useAnchoredMenu.js";
import type { ImageAdminView } from "./useImageAdminOperations.js";

const imageAdminFilterPortalSelector = ".select-menu, .facet-select-menu";

const filterOutsideInteractionEvents = [
  "pointerdown",
  "click",
  "focusin",
  "wheel"
] as const;

function isWithinImageAdminFilterSurface(
  root: HTMLElement,
  event: Pick<Event, "composedPath" | "target">
) {
  const path = event.composedPath?.() ?? (event.target ? [event.target] : []);
  return path.some((entry) => {
    if (entry === root) return true;
    if (
      typeof Node !== "undefined"
      && entry instanceof Node
      && root.contains(entry)
    ) return true;

    const matches = (entry as Partial<Element>).matches;
    return typeof matches === "function"
      && matches.call(entry, imageAdminFilterPortalSelector);
  });
}

export type ImageAdminFilterValues = {
  device: string;
  brightness: string;
  theme: string;
  tag: string;
  author: string;
};

export const emptyImageAdminFilters: ImageAdminFilterValues = {
  device: "",
  brightness: "",
  theme: "",
  tag: "",
  author: ""
};

type ImageAdminFilterVocabulary = {
  themes: FacetOption[];
  tags: FacetOption[];
  authors: FacetOption[];
};

export function ImageAdminFilters({
  value,
  vocabulary,
  view,
  mobileLayout,
  disabled,
  onChange
}: {
  value: ImageAdminFilterValues;
  vocabulary?: ImageAdminFilterVocabulary;
  view: ImageAdminView;
  mobileLayout: boolean;
  disabled: boolean;
  onChange: (key: keyof ImageAdminFilterValues, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [motionEnabled, setMotionEnabled] = useState(false);
  const [menuDismissSignal, setMenuDismissSignal] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const motionTimerRef = useRef<number | undefined>(undefined);
  const themeDisabled = disabled || view === "unset";
  const activeCount =
    (value.device ? 1 : 0)
    + (value.brightness ? 1 : 0)
    + (view !== "unset" && value.theme ? 1 : 0)
    + (value.tag ? 1 : 0)
    + (value.author ? 1 : 0);

  const setFilterOpen = (nextOpen: boolean) => {
    window.clearTimeout(motionTimerRef.current);
    if (!nextOpen) {
      setMenuDismissSignal((current) => current + 1);
    }
    setMotionEnabled(true);
    setOpen(nextOpen);
    // 动画只覆盖用户触发的本次开合，避免之后跨越响应式断点时播放关闭动画。
    motionTimerRef.current = window.setTimeout(
      () => setMotionEnabled(false),
      100
    );
  };

  useLayoutEffect(() => {
    window.clearTimeout(motionTimerRef.current);
    setMenuDismissSignal((current) => current + 1);
    setMotionEnabled(false);
    setOpen(false);
  }, [mobileLayout]);

  useEffect(() => () => {
    window.clearTimeout(motionTimerRef.current);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!open || !root) return;

    const closeOnOutsideInteraction = (event: Event) => {
      if (isWithinImageAdminFilterSurface(root, event)) return;
      setFilterOpen(false);
    };
    // pointerdown 覆盖触控与滚动条拖动，wheel 覆盖鼠标滚动；不监听结果性的
    // scroll，避免移动键盘、视口重排或程序性滚动误关。Portal 菜单仍属于内部。
    for (const eventName of filterOutsideInteractionEvents) {
      document.addEventListener(eventName, closeOnOutsideInteraction, true);
    }
    return () => {
      for (const eventName of filterOutsideInteractionEvents) {
        document.removeEventListener(eventName, closeOnOutsideInteraction, true);
      }
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`image-list-filter-bar${open ? " filters-open" : ""}${motionEnabled ? " filters-motion-enabled" : ""}`}
    >
      <button
        type="button"
        className="image-list-filter-toggle"
        aria-expanded={open}
        aria-controls="admin-image-filter-panel"
        onClick={() => setFilterOpen(!open)}
      >
        <Icon name="filter-3-line" />
        筛选
        {activeCount > 0 && (
          <span className="image-list-filter-count">{activeCount}</span>
        )}
        <span className="image-list-filter-chevron">
          <Icon name="arrow-down-s-line" />
        </span>
      </button>
      <AnchoredMenuDismissSignalContext.Provider
        key={mobileLayout ? "mobile" : "desktop"}
        value={menuDismissSignal}
      >
        <div
          id="admin-image-filter-panel"
          className="image-list-filter-panel"
          role="group"
          aria-label="图片列表筛选条件"
        >
          <button
            type="button"
            className="image-list-filter-panel-close"
            onClick={() => setFilterOpen(false)}
          >
            <Icon name="close-line" />
            收起筛选
          </button>
          <div className="image-list-filter-primary">
            <label className="image-list-filter-device">
              设备
              <SelectMenu
                value={value.device}
                onChange={(next) => onChange("device", next)}
                options={[
                  { value: "", label: "全部设备" },
                  ...imageDevices.map((option) => ({
                    value: option,
                    label: deviceOptionLabel(option)
                  }))
                ]}
                disabled={disabled}
                ariaLabel="设备"
              />
            </label>
            <label className="image-list-filter-brightness">
              亮度
              <SelectMenu
                value={value.brightness}
                onChange={(next) => onChange("brightness", next)}
                options={[
                  { value: "", label: "全部亮度" },
                  ...imageBrightnesses.map((option) => ({
                    value: option,
                    label: brightnessOptionLabel(option)
                  }))
                ]}
                disabled={disabled}
                ariaLabel="亮度"
              />
            </label>
            <label className="image-list-filter-author">
              作者
              <FacetSelector
                options={vocabulary?.authors ?? []}
                value={value.author}
                onChange={(next) => onChange("author", next)}
                noun="作者"
                disabled={disabled}
              />
            </label>
          </div>
          <div className="image-list-filter-secondary">
            <label className="image-list-filter-theme">
              主题
              <FacetSelector
                options={vocabulary?.themes ?? []}
                value={view === "unset" ? "" : value.theme}
                onChange={(next) => onChange("theme", next)}
                noun="主题"
                disabled={themeDisabled}
              />
            </label>
            <label className="image-list-filter-tag">
              标签
              <FacetSelector
                options={vocabulary?.tags ?? []}
                value={value.tag}
                onChange={(next) => onChange("tag", next)}
                noun="标签"
                disabled={disabled}
              />
            </label>
          </div>
        </div>
      </AnchoredMenuDismissSignalContext.Provider>
    </div>
  );
}
