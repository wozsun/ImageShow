import { useState } from "react";
import { Icon } from "../../../../components/icon/Icon.js";
import { SelectMenu } from "../../../../components/form/SelectMenu.js";
import { parseImportUrls } from "../import-job-utils.js";

export type LinkImportMode = "download" | "proxy";

const modeOptions = [
  { value: "download", label: "下载图片" },
  { value: "proxy", label: "代理链接" }
] as const;

export function LinkUrlDialog({ onClose, onSubmit }: {
  onClose: () => void;
  onSubmit: (urls: string[], mode: LinkImportMode) => void;
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<LinkImportMode>("download");
  const urls = parseImportUrls(text);

  const submit = () => {
    if (!urls.length) return;
    onSubmit(urls, mode);
    onClose();
  };

  return (
    <div className="modal link-url-overlay">
      <div className="link-import-card">
        <div className="link-import-head">
          <h2><Icon name="download-cloud-2-line" />导入链接</h2>
          <div className="link-import-head-status">
            <button type="button" className="icon close" title="关闭" onClick={onClose}>
              <Icon name="close-line" />
            </button>
          </div>
        </div>
        <p className="hint">
          {mode === "download"
            ? <>服务器下载原图并转为压缩 WebP，<br />处理完成后按普通图片保存，原始下载数据不会保留。</>
            : <>服务器仅生成并保存缩略图。<br />图库记录保留外部图片链接，查看时通过代理访问原图。</>}
        </p>
        <textarea
          className="link-import-urls"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={"https://example.com/a.jpg\nhttps://example.com/b.png"}
          rows={6}
        />
        <div className="link-import-actions">
          <SelectMenu
            className="link-import-mode"
            value={mode}
            onChange={(value) => setMode(value as LinkImportMode)}
            options={modeOptions}
            ariaLabel="链接导入模式"
          />
          <div className="link-import-action-buttons">
            <button type="button" onClick={onClose}>取消</button>
            <button type="button" className="button" disabled={!urls.length} onClick={submit}>
              <Icon name="download-cloud-2-line" />{`导入${urls.length ? ` ${urls.length} 个` : ""}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
