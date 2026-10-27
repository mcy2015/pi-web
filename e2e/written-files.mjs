// The chips under a turn's answer list every file that turn wrote: the direct
// write, the files a bash command wrote (parsed from the command text), a
// codemode script's nested write, and a settled subagent's files (fetched from
// the child transcript a moment after the page loads). The fixture cwd is not
// a git repository, so no +/− badge shows anywhere.
export async function checkWrittenFiles({ browser, base, artifacts, session }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  try {
    await page.goto(`${base}/?session=${session}`, { waitUntil: "domcontentloaded" });
    await page.getByText("E2E written-files answer").first().waitFor({ state: "visible" });

    // The synchronous records: direct write, bash-parsed, codemode nested.
    const chips = page.getByLabel("Files changed");
    await chips.waitFor({ state: "visible" });
    for (const name of ["direct.txt", "via-bash.ts", "via-codemode.ts"]) {
      await page.getByRole("button", { name: `Open ${name}` }).waitFor({ state: "visible" });
    }

    // The subagent's file arrives with its transcript fetch, slightly later.
    await page.getByRole("button", { name: "Open via-subagent.ts" }).waitFor({ state: "visible" });

    // Not a git repository: no +n/−m badge on any chip.
    const html = await chips.innerHTML();
    if (/\+\d/.test(html)) throw new Error(`unexpected git badge in chips: ${html}`);

    console.log("PASS: written-file chips list direct, bash, codemode and subagent writes");
  } catch (error) {
    await page.screenshot({ path: `${artifacts}/written-files-failure.png` }).catch(() => {});
    throw error;
  } finally {
    await context.tracing.stop();
    await context.close();
  }
}
