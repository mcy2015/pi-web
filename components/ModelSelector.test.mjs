import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, jsx: { runtime: "automatic" } });
const { ModelSelector, filterModelOptions, groupModelOptions } = await jiti.import("./ModelSelector.tsx");
const { SelectorRow, SelectorRowStarMenu } = await jiti.import("./SelectorRow.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function render(props) {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(ModelSelector, {
        onChange() {},
        ...props,
      }),
    ),
  );
}

function renderRow(star, children = "An option") {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(SelectorRow, { active: false, onSelect() {}, star }, children),
    ),
  );
}

test("filters model options by model name, id, provider, and provider/id", () => {
  const options = [
    { provider: "anthropic", providerName: "Anthropic", modelId: "claude-opus-5", name: "Claude Opus 5" },
    { provider: "openai", providerName: "OpenAI", modelId: "gpt-6-luna", name: "GPT-6 Luna" },
    { provider: "acme", providerName: "Acme Gateway", modelId: "custom-one", name: "Custom One" },
  ];

  assert.deepEqual(filterModelOptions(options, "opus"), [options[0]]);
  assert.deepEqual(filterModelOptions(options, "gpt-6"), [options[1]]);
  assert.deepEqual(filterModelOptions(options, "acme/custom"), [options[2]]);
  assert.deepEqual(filterModelOptions(options, "gateway"), [options[2]]);
  assert.deepEqual(filterModelOptions(options, "   "), options);
  assert.deepEqual(filterModelOptions(options, "nonexistent"), []);
});

test("groups models by provider and labels each group with the provider's display name", () => {
  const options = [
    { provider: "aiflashapi", providerName: "AI Flash API", modelId: "one", name: "One" },
    { provider: "aiflashapi", modelId: "two", name: "Two" },
    { provider: "commandcode", modelId: "three", name: "Three" },
  ];

  const groups = groupModelOptions(options);
  assert.deepEqual(groups.map((group) => group.provider), ["aiflashapi", "commandcode"]);
  assert.deepEqual(groups.map((group) => group.providerName), ["AI Flash API", "commandcode"]);
  assert.deepEqual(groups[0].options.map((option) => option.modelId), ["one", "two"]);
});

test("names a current model outside the scope from the loaded full list", () => {
  const html = render({
    options: [{ provider: "anthropic", modelId: "claude-opus-5", name: "Claude Opus 5" }],
    allOptions: [{ provider: "openai", modelId: "gpt-6-luna", name: "GPT-6 Luna" }],
    value: { provider: "openai", modelId: "gpt-6-luna" },
    onShowAll() {},
  });

  assert.match(html, /GPT-6 Luna/);
});

const saveChoices = [
  { key: "global", label: "global", onPick() {} },
  { key: "project", label: "project", onPick() {} },
];

test("a star with choices is a menu trigger, without them a plain save button", () => {
  const withChoices = renderRow({
    isDefault: false,
    saveLabel: "Use and save as default for new chats",
    defaultLabel: "Default model for new chats",
    onSave() {},
    choices: saveChoices,
  });
  assert.match(withChoices, /aria-haspopup="menu"/);
  assert.match(withChoices, /aria-expanded="false"/);

  const withoutChoices = renderRow({
    isDefault: false,
    saveLabel: "Use and save as default for new chats",
    defaultLabel: "Default model for new chats",
    onSave() {},
  });
  // The pre-menu markup: a save button that is not a menu trigger.
  assert.doesNotMatch(withoutChoices, /aria-haspopup/);
  assert.doesNotMatch(withoutChoices, /aria-expanded/);
});

test("the default row's star stays a static marker without defaultChoices, a menu button with them", () => {
  const plain = renderRow({
    isDefault: true,
    saveLabel: "Use and save as default for new chats",
    defaultLabel: "Default model for new chats",
    onSave() {},
  });
  assert.match(plain, /role="img"/);
  assert.doesNotMatch(plain, /aria-haspopup/);

  const withChoices = renderRow({
    isDefault: true,
    saveLabel: "Use and save as default for new chats",
    defaultLabel: "Default model for new chats",
    onSave() {},
    defaultChoices: [{ key: "follow-global", label: "Follow global default", onPick() {} }],
  });
  assert.doesNotMatch(withChoices, /role="img"/);
  assert.match(withChoices, /aria-haspopup="menu"/);
});

test("the star menu marks a disabled choice with its note", () => {
  const html = renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(SelectorRowStarMenu, {
        anchorRect: { top: 100, right: 400, bottom: 120 },
        label: "Use and save as default for new chats",
        choices: [
          {
            key: "global",
            label: "global",
            disabled: true,
            disabledNote: "Saved globally, but this project's settings override it",
            onPick() {},
          },
          { key: "project", label: "project", onPick() {} },
        ],
        onPick() {},
      }),
    ),
  );

  assert.match(html, /role="menu"/);
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /aria-describedby=/);
  assert.match(html, /this project&#x27;s settings override it/);
});
