// The Agent tool card's two subagent entries: an "enter" button that opens the
// child's chat as the main one (the agent switcher's row click), and the
// side-panel button that opens the read-only viewer tab. Both must work from a
// finished run's card; entering must land on the child session's own content.
export async function checkSubagentCard({ browser, base, artifacts, parent, child }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  try {
    await page.goto(`${base}/?session=${parent}`, { waitUntil: "domcontentloaded" });
    // The turn's last assistant message is the Agent call itself, so the card
    // shows unfolded; its buttons are the two subagent entries.
    const enter = page.getByRole("button", { name: "Open this sub-agent's conversation as the main chat" });
    const panel = page.getByRole("button", { name: "View sub-agent work in side panel" });
    await enter.waitFor({ state: "visible" });
    await panel.waitFor({ state: "visible" });

    // The viewer tab opens beside the chat and shows the child's transcript.
    await panel.click();
    await page.getByText("E2E subagent reply").first().waitFor({ state: "visible" });

    // Entering selects the child as the main chat: the URL and the content change.
    await enter.click();
    await page.waitForFunction((expected) => new URLSearchParams(location.search).get("session") === expected, child);
    await page.getByText("E2E subagent task assigned").first().waitFor({ state: "visible" });

    console.log("PASS: Agent card offers entering the subagent chat and its side-panel viewer");
  } catch (error) {
    await page.screenshot({ path: `${artifacts}/subagent-card-failure.png` }).catch(() => {});
    throw error;
  } finally {
    await context.tracing.stop();
    await context.close();
  }
}
