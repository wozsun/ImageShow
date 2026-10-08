import { detectDeviceFromUserAgent, type AdminImageListItemDto } from "@imageshow/shared/browser";
import { CopyButton } from "../../../components/actions/CopyButton.js";
import { SelectMenu } from "../../../components/form/SelectMenu.js";
import type { SelectOption } from "../../../lib/ui/select-options.js";

export type GroupLinkOptions = { device: string; brightness: string; mode: string };

const fields = [
  {
    key: "device", label: "链接设备", options: [
      { value: "all", label: "全部设备" },
      { value: "", label: "自动设备" },
      { value: "pc", label: "桌面端" },
      { value: "mb", label: "移动端" }
    ]
  },
  {
    key: "brightness", label: "链接亮度", options: [
      { value: "", label: "全部亮度" },
      { value: "dark", label: "暗色图片" },
      { value: "light", label: "亮色图片" }
    ]
  },
  {
    key: "mode", label: "链接返回方式", options: [
      { value: "", label: "默认返回" },
      { value: "redirect", label: "302 跳转" },
      { value: "proxy", label: "代理模式" },
      { value: "json", label: "JSON" }
    ]
  }
] satisfies { key: keyof GroupLinkOptions; label: string; options: SelectOption[] }[];

export function imageMatchesGroupLink(item: AdminImageListItemDto, options: GroupLinkOptions) {
  const device = options.device === "all"
    ? null
    : options.device || detectDeviceFromUserAgent(navigator.userAgent);
  return (!device || item.device === device)
    && (!options.brightness || item.brightness === options.brightness);
}

export function GroupRandomLink({ slug, value, onChange, doubleRow, mobileLayout, disabled }: {
  slug: string;
  value: GroupLinkOptions;
  onChange: (key: keyof GroupLinkOptions, value: string) => void;
  doubleRow: boolean;
  mobileLayout: boolean;
  disabled: boolean;
}) {
  const url = new URL("/random", window.location.origin);
  url.searchParams.set("group", slug);
  for (const { key } of fields) {
    if (value[key]) url.searchParams.set(key, value[key]);
  }

  return (
    <div className="group-random-link" data-double-row={doubleRow}>
      <div className="group-random-link-options">
        {fields.map(({ key, label, options }) => (
          <div className="group-random-link-select" key={key}>
            {options.map((option) => (
              <span className="group-random-link-option-width" aria-hidden="true" key={option.value}>
                {option.label}
              </span>
            ))}
            <SelectMenu
              value={value[key]}
              options={options}
              onChange={(next) => onChange(key, next)}
              ariaLabel={label}
              disabled={disabled}
            />
          </div>
        ))}
      </div>
      <div className="group-random-link-value">
        <label className="group-random-link-field">
          <span className="group-random-link-label">随机API</span>
          <input aria-label="分组随机链接" readOnly value={url.href} />
        </label>
        <CopyButton value={url.href} ariaLabel="复制分组随机链接" variant={mobileLayout ? "icon" : "text"} />
      </div>
    </div>
  );
}
