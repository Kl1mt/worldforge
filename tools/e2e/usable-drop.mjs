// Shared by the browser runs that equip a drop from the Pack (ticket F.8).
//
// A drop is "usable" when the Pack's Equip button is enabled for it: an item with a slot that the
// hero's class may wear (web `canUse`). The first drops are not always usable: with a random
// activity seed a level-1 warrior's first Abandoned Fields drop is another class's gear about
// 1 time in 5 (a mage's or hunter's about 1 in 3.4), the first two both about 1 in 22 (1 in 12).
// Measured with game-core over 5,000 seeds per class; docs/ROADMAP.md F.8. So the runs must not
// read the Pack once after the first loot and fail: they keep farming (the hero farms on
// server-side) and read the Pack again whenever it has grown, until a usable drop is there or
// the real-time budget runs out.

/** Real seconds to wait for a usable drop. At ×120 that is 3 game hours (the worst of 10,000 seeds: 24 game minutes). */
export const USABLE_DROP_BUDGET_SECONDS = Number(process.env.E2E_USABLE_DROP_SECONDS ?? 90);

/**
 * Opens the Pack and selects the first drop whose Equip button is enabled, reading the Pack again
 * (a reload) whenever more drops have arrived. Leaves that drop selected and returns its label and
 * the number of drops in the Pack. Throws when no usable drop arrived within the budget.
 */
export async function selectUsableDrop(page, { baseUrl, log = () => {} } = {}) {
  const budgetMs = USABLE_DROP_BUDGET_SECONDS * 1000;
  const deadline = Date.now() + budgetMs;
  const sockets = page.locator('.stash__grid button.item-frame');
  const equipButton = page.getByRole('button', { name: 'Equip', exact: true });
  if (!/#\/inventory/.test(page.url())) await page.goto(`${baseUrl}/#/inventory`);
  await sockets.first().waitFor();
  for (;;) {
    const count = await sockets.count();
    for (let i = 0; i < count; i++) {
      await sockets.nth(i).click();
      if (await equipButton.isEnabled()) {
        return { picked: (await sockets.nth(i).getAttribute('aria-label')) ?? `#${i}`, count };
      }
    }
    const tried = count;
    log(`no usable item among ${count} drops yet; the hero farms on`);
    // Wait for state, not time: read the Pack again until it holds more drops than were tried.
    let grown = false;
    while (!grown && Date.now() < deadline) {
      await page.waitForTimeout(1500);
      await reloadPack(page);
      grown = (await sockets.count()) > tried;
    }
    if (!grown) {
      throw new Error(
        `no usable item among ${tried} drops after ${USABLE_DROP_BUDGET_SECONDS}s of farming`,
      );
    }
  }
}

const RETURN_MIN_MS = 60_000; // apps/web/src/game/chronicle.ts

/**
 * Reloads the page on the Pack. The page's own scheduled-settle poll only reloads the Pack when
 * its own window brought loot, and the server's scheduled settlement often takes it first, so a
 * reload is the way to see every drop. The reload settles at once "as a return"; whether that
 * opens the return dialog follows from the settle response (web `isWorthAReturnDialog`), so
 * wait for exactly that instead of guessing with a timeout, and close it.
 */
async function reloadPack(page) {
  // After the commit the old page (and its poll) is gone and the new one has not run yet, so the
  // next settle response is the reload's own.
  await page.reload({ waitUntil: 'commit' });
  const res = await page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/activity\/settle$/.test(new URL(r.url()).pathname),
  );
  await page.locator('.stash__grid button.item-frame').first().waitFor();
  if (!res.ok()) return;
  const { summary } = await res.json();
  const away = Date.parse(summary.until) - Date.parse(summary.since);
  if (away >= RETURN_MIN_MS && (summary.simulatedMs > 0 || summary.cappedMs > 0)) {
    const back = page.getByRole('button', { name: 'Back to the fields' });
    await back.click();
    await back.waitFor({ state: 'hidden' });
  }
}
