import { useState } from "react";
import { Icon } from "../../components/Icon.js";

// The "导入链接" popup: a plain textarea of image URLs (one per line). It owns its own
// input; on 导入 it hands the non-empty lines to the parent, which downloads + stages
// each (prepare). Nested inside the upload overlay in link mode.
export function LinkUrlDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (urls: string[]) => void }) {
  const [text, setText] = useState("");
  const urls = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return (
    <div className="modal link-url-overlay" onClick={onClose}>
      <div className="link-import-card" onClick={(event) => event.stopPropagation()}>
        <div className="link-import-head">
          <h2><Icon name="download-cloud-2-line" />导入链接</h2>
          <button type="button" className="icon close" title="关闭" onClick={onClose}>
            <Icon name="close-line" />
          </button>
        </div>
        <p className="hint">每行一个图片直链（http/https）。下载并生成缩略图后即可逐张编辑属性；点击提交时缩略图写入下方所选存储位置，原图只保存链接、不入库。</p>
        <textarea
          className="link-import-urls"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={"https://example.com/a.jpg\nhttps://example.com/b.png"}
          rows={6}
        />
        <div className="link-import-actions">
          <button type="button" onClick={onClose}>取消</button>
          <button type="button" className="button" disabled={!urls.length} onClick={() => onSubmit(urls)}>
            <Icon name="download-cloud-2-line" />导入{urls.length ? ` ${urls.length} 个` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
