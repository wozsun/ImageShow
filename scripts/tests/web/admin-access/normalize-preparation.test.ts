import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { defaultPreparationProfile, type PreparationStatusDto } from "../../../../packages/shared/src/browser.ts";
import { createConfigStreamHarness } from "../../support/web-test-context.ts";
import { dispatchDomEvent } from "../../support/dom-events.ts";

test("[Web/三档预生成] 冻结运行参数、控制版本和关闭后的请求取消", async (t) => {
  const hooks = registerHooks({ load(url, context, next) {
    return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context);
  } });
  t.after(() => hooks.deregister());
  const { default: Dialog } = await import("../../../../packages/web/src/pages/admin/check/NormalizePreparationDialog.tsx");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const h = await createConfigStreamHarness(t);
  Object.assign(h.window, { scrollTo() {}, scrollY: 0 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  t.after(() => client.clear());
  const status: PreparationStatusDto = {
    run_id: "00000000-0000-4000-8000-000000000001", profile: defaultPreparationProfile(), revision: 7,
    mode: "generate", desired_state: "running", state: "生成中", concurrency: 2, block: null,
    completed_attempts: 0, rest: null, server_time: new Date().toISOString(), total: 1, untracked: 0,
    deletion_pending: 0, variant_counts: { large: 0, middle: 0, small: 0 },
    counts: { pending: 1, running: 0, ready: 0, failed: 0, stale: 0, excluded: 0 },
    active: [], items: [], page: 1, pages: 1, verified_at: null
  };
  await h.render(h.React.createElement(QueryClientProvider, { client }, h.React.createElement(Dialog, { onClose() {} })));
  assert.equal(h.pending.length, 1);
  await h.respond(0, { ok: true, ...status });
  assert.ok(h.document.querySelector("fieldset")?.hasAttribute("disabled"));
  assert.match(h.document.body.textContent ?? "", /本轮冻结的处理参数/);
  const stop = [...h.document.querySelectorAll("button")].find((button) => button.textContent === "停止")!;
  await h.React.act(async () => { dispatchDomEvent(h.window, stop, "click"); });
  const control = h.pending.find((request) => request.path.endsWith("/control"));
  assert.ok(control);
  assert.deepEqual(JSON.parse(String(control.body)), { action: "stop", revision: 7 });
  await h.respond(h.pending.indexOf(control), { ok: true, ...status, revision: 8, desired_state: "stopped" });
  const pendingRead = h.pending.at(-1)!;
  assert.match(pendingRead.path, /status\?page=1$/);
  await h.render(null);
  assert.equal(pendingRead.signal?.aborted, true);
  assert.equal(h.pending.filter((request) => request.path.endsWith("/control")).length, 1, "关闭弹窗不发送额外停止动作");
});
