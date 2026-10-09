import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EditableImageSnapshotDto } from "@imageshow/shared/browser";
import {
  loadImageEditorCapabilityModule,
  type ImageEditorIntent,
  type ImageEditorOpenResult,
  type ImageEditorTarget
} from "../../../components/image/editor/image-editor-capability-loader.js";
import { usePageScrollLock } from "../../../hooks/usePageScrollLock.js";
import { createPageLifetimeModuleLoader } from "../../../lib/page-lifetime-module-loader.js";

type ImageIdInputDialogModule = typeof import("./ImageIdInputDialog.js");

const loadImageIdInputDialog = createPageLifetimeModuleLoader<ImageIdInputDialogModule>(
  () => import("./ImageIdInputDialog.js")
);

/** 输入 ID 后交给图片操作窗口，两段模块一并预取。 */
export function preloadImageIdInput() {
  void loadImageIdInputDialog().catch(() => undefined);
  void loadImageEditorCapabilityModule().catch(() => undefined);
}

type OpenImageEditor = (
  target: ImageEditorTarget,
  opener: HTMLElement,
  onOpened: () => void
) => Promise<ImageEditorOpenResult>;

/**
 * 按完整图片 ID 指定图片的入口编排：模块加载、页面锁、加载失败的焦点归还，以及向图片操作窗口的交接。
 * 权限、业务繁忙约束、错误反馈和写入回调仍由页面持有。
 */
export function useImageIdInputEntry<Intent extends ImageEditorIntent>({
  onLoadError
}: {
  onLoadError: (error: unknown) => void;
}) {
  const [session, setSession] = useState<{
    intent: Intent;
    Dialog: ImageIdInputDialogModule["ImageIdInputDialog"];
  } | null>(null);
  const [pending, setPending] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const failedOpenerRef = useRef<HTMLElement | null>(null);
  const openingRef = useRef(false);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // 模块加载期间沿用上传 / 导入的做法锁住页面根节点：入口外观不变，指针、键盘、焦点与滚动
  // 一并隔离，弹窗挂载后由其自身的锁接替；加载失败时把焦点还给入口按钮。
  usePageScrollLock(pending);
  useLayoutEffect(() => {
    if (pending) return;
    const opener = failedOpenerRef.current;
    failedOpenerRef.current = null;
    if (opener?.isConnected
      && !opener.matches(":disabled")
      && !opener.closest("[inert]")) opener.focus();
  }, [pending]);

  const open = async (intent: Intent, opener: HTMLElement) => {
    if (openingRef.current) return;
    openingRef.current = true;
    setPending(true);
    try {
      const module = await loadImageIdInputDialog();
      if (mountedRef.current && opener.isConnected) {
        openerRef.current = opener;
        setSession({ intent, Dialog: module.ImageIdInputDialog });
      }
    } catch (error) {
      if (mountedRef.current) {
        failedOpenerRef.current = opener;
        onLoadError(error);
      }
    } finally {
      openingRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  };
  const close = () => setSession(null);
  // ID 弹窗保持到图片操作窗口就绪，二者在同一次渲染中交接，避免中间露出页面。
  const handOff = (openEditor: OpenImageEditor, items: EditableImageSnapshotDto[]) => {
    if (!session || !openerRef.current) return Promise.resolve("interrupted" as const);
    return openEditor(
      { items, intent: session.intent, fromDialog: true },
      openerRef.current,
      close
    );
  };

  return {
    session,
    pending,
    open,
    close,
    handOff,
    returnFocusRef: openerRef
  };
}
