import { useRef } from "react";
import { DialogFrame } from "../../../components/feedback/DialogFrame.js";
import { storageBackendDisplay } from "../../../lib/ui/select-options.js";
import type { StorageBackendAdmin } from "../../../lib/types.js";
import { storageBackendDeletionReasons } from "./storage-backend-deletion-policy.js";

export function StorageBackendDeletionBlockedDialog({
  backend,
  onClose
}: {
  backend: StorageBackendAdmin;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const reasons = storageBackendDeletionReasons(backend);
  return (
    <DialogFrame
      className="modal edit-modal"
      ariaLabel="不能删除存储后端"
      initialFocusRef={closeButtonRef}
      onClose={onClose}
    >
      {({ requestClose }) => (
        <form
          className="operation-modal storage-deletion-blocked-dialog"
          onSubmit={(event) => {
            event.preventDefault();
            requestClose();
          }}
        >
          <header>
            <div>
              <h2>暂时不能删除“{storageBackendDisplay(backend)}”</h2>
            </div>
          </header>
          <div className="operation-body">
            <ul>
              {(reasons.length
                ? reasons
                : ["当前状态不允许删除，请刷新页面后重试。"]
              ).map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          </div>
          <footer>
            <button ref={closeButtonRef} className="button" type="submit">
              知道了
            </button>
          </footer>
        </form>
      )}
    </DialogFrame>
  );
}
