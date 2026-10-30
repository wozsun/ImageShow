import { registerHooks } from "node:module";

const webSourceRoot = new URL("../../../packages/web/src/", import.meta.url).href;

// DOM contract tests exercise component behavior; browser acceptance owns CSS layout.
// Vite replaces import.meta.env at build time, so web modules see the production values here.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) {
      return { format: "module", source: "export {};", shortCircuit: true };
    }
    const loaded = nextLoad(url, context);
    if (!url.startsWith(webSourceRoot) || loaded.source == null) return loaded;
    const source = String(loaded.source);
    return source.includes("import.meta.env")
      ? { ...loaded, source: `import.meta.env = { DEV: false, PROD: true };${source}` }
      : loaded;
  }
});
