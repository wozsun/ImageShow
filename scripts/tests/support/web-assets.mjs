import { registerHooks } from "node:module";

// DOM contract tests exercise component behavior; browser acceptance owns CSS layout.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) {
      return { format: "module", source: "export {};", shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});
