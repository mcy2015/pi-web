import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// A render smoke: the panel mounts inside the i18n provider and shows its
// loading state. Fetch never runs under renderToStaticMarkup (no effects),
// so the loaded layout is covered by lib/git-graph-layout.test.mjs.

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { GitGraphPanel } = await jiti.import("./GitGraphPanel.tsx");

const h = React.createElement;

test("mounts with its folder and shows the loading state", () => {
  const html = renderToStaticMarkup(h(I18nProvider, null, h(GitGraphPanel, { cwd: "/work/alpha" })));
  assert.match(html, /Loading…/);
  // The folder's name is not part of the loading view itself.
  assert.doesNotMatch(html, /api\/git\/graph/);
});
