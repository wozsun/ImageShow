import type { ReactNode } from "react";

/**
 * 窄屏可随滚动显隐的整块操作区，每页只有一个。外层轨道在窄屏绝对定位于标题区下方，操作区在
 * 轨道内以 sticky 定位，由浏览器原生滚动带动显隐（见 useWorkspaceToolbarCollapse）；桌面两层
 * 包装都不参与布局，子元素按页面原有排布显示。
 */
export function WorkspaceToolbar({
  className = "",
  children
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="workspace-toolbar-rail">
      <div className={["workspace-toolbar", className].filter(Boolean).join(" ")}>
        {children}
      </div>
    </div>
  );
}
