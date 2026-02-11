const { test, expect } = require('@playwright/test');

test.describe('Forced Offline', () => {
  test('NET pill toggles Forced Offline and blocks external fetch', async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.removeItem('xtoc.forcedOffline'); } catch (_) { /* ignore */ }
    });

    await page.goto('/');

    await page.waitForFunction(() => !!window.radioApp);

    await page.locator('#xNetPill').click();
    await expect(page.locator('#xNetValue')).toHaveText('FORCED OFFLINE');

    const ls = await page.evaluate(() => localStorage.getItem('xtoc.forcedOffline'));
    expect(ls).toBe('1');

    const err = await page.evaluate(async () => {
      try {
        await fetch('https://example.com/blocked');
        return null;
      } catch (e) {
        return String(e && e.message ? e.message : e);
      }
    });
    expect(err).toMatch(/forced offline/i);
  });
});

