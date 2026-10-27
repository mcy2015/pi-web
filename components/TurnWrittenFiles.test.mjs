import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { TurnWrittenFiles } = await jiti.import("./TurnWrittenFiles.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function render(props) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(TurnWrittenFiles, props)),
  );
}

test("renders a button per file showing the basename and full path", () => {
  const html = render({
    files: [{ filePath: "/abs/out/report.html" }, { filePath: "/abs/out/data.json" }],
    onOpenFile() {},
  });
  assert.match(html, /<button/);
  assert.match(html, /report\.html/);
  assert.match(html, /data\.json/);
  assert.match(html, /title="\/abs\/out\/report\.html"/);
  assert.match(html, /title="\/abs\/out\/data\.json"/);
});

test("renders nothing when no files were written", () => {
  assert.equal(render({ files: [], onOpenFile() {} }), "");
});

test("renders +/− counts per file when git stats are cached for the cwd", async () => {
  const { setGitFileStatsForTests } = await jiti.import("@/hooks/useGitFileStats");
  setGitFileStatsForTests("/abs", new Map([
    ["/abs/out/report.html", { additions: 12, deletions: 3 }],
    ["/abs/out/data.json", { additions: 0, deletions: 0 }],
  ]));
  const html = render({
    files: [{ filePath: "/abs/out/report.html" }, { filePath: "/abs/out/data.json" }],
    onOpenFile() {},
    cwd: "/abs",
  });
  assert.match(html, /\+12/);
  assert.match(html, /−3/);
  // A file with no changed lines shows no badge, as one outside git.
  assert.doesNotMatch(html, /\+0/);
});

test("renders no badge without a cwd", () => {
  const html = render({ files: [{ filePath: "/abs/out/report.html" }], onOpenFile() {} });
  assert.doesNotMatch(html, /\+/);
});
