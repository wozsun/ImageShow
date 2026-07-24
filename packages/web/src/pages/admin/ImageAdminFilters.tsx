import { useState } from "react";
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
import { useDismissiblePanel } from "../../hooks/useDismissiblePanel.js";
import type { ImageAdminView } from "./useImageAdminOperations.js";

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
  const disclosure = useDismissiblePanel({
    open,
    onOpenChange: setOpen,
    resetKey: mobileLayout
  });
  const themeDisabled = disabled || view === "unset";
  const activeCount =
    (value.device ? 1 : 0)
    + (value.brightness ? 1 : 0)
    + (view !== "unset" && value.theme ? 1 : 0)
    + (value.tag ? 1 : 0)
    + (value.author ? 1 : 0);

  return (
    <div
      ref={disclosure.rootRef}
      className={`image-list-filter-bar${open ? " filters-open" : ""}${disclosure.motionEnabled ? " filters-motion-enabled" : ""}`}
    >
      <button
        type="button"
        className="image-list-filter-toggle"
        aria-expanded={open}
        aria-controls="admin-image-filter-panel"
        onClick={() => disclosure.setOpen(!open)}
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
        value={disclosure.menuDismissSignal}
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
            onClick={() => disclosure.setOpen(false)}
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
