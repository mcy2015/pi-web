import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("AppShell.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(parsed);
function script(text) {
  return new Script(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
}

test("the top bar's New button and Ctrl+Alt+N share one startNewSessionInCwd handler", () => {
  const declaration = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(parsed) === "startNewSessionInCwd");
  assert.ok(declaration, "startNewSessionInCwd must exist");
  const shortcut = nodes.find((node) => ts.isCallExpression(node) && node.expression.getText(parsed) === "useGlobalKeyboardShortcuts");
  assert.ok(shortcut, "useGlobalKeyboardShortcuts call must exist");
  assert.match(shortcut.arguments[0].getText(parsed), /onNewSession:\s*startNewSessionInCwd/, "the shortcut must take the shared handler");
  // The top bar button (after the sidebar toggle) calls it with the active cwd.
  const toggleIndex = source.indexOf("onClick={handleSidebarToggle}");
  const buttonIndex = source.indexOf("startNewSessionInCwd(activeCwd)", toggleIndex);
  assert.ok(toggleIndex !== -1 && buttonIndex !== -1, "the top bar New button must sit after the sidebar toggle and use the shared handler");
  const buttonSource = source.slice(toggleIndex, source.indexOf("</button>", buttonIndex));
  assert.match(buttonSource, /disabled=\{!activeCwd\}/, "no cwd leaves the button disabled");
  assert.match(buttonSource, /sidebar\.newSessionTitle/, "its title names the cwd");
});

test("startNewSessionInCwd starts a fresh composer through handleNewSession", () => {
  const declaration = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(parsed) === "startNewSessionInCwd");
  const calls = [];
  const now = 1750000000000;
  const context = createContext({
    handleNewSession: (id, cwd) => { calls.push([id, cwd]); },
    Date: { now: () => now },
    useCallback: (fn) => fn,
  });
  script(`(${declaration.initializer.getText(parsed)})`).runInContext(context)("/some/cwd");
  assert.deepEqual(calls, [[`kb-${now}`, "/some/cwd"]]);
});
