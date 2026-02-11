const { test, expect } = require('@playwright/test');

test.describe('Comms QR printing', () => {
  test('Print QR uses in-page print (no popup)', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => !!window.radioApp && typeof window.radioApp.loadModule === 'function');
    await page.evaluate(() => window.radioApp.loadModule('comms'));

    await page.waitForFunction(() => {
      const app = window.radioApp;
      if (!app) return false;
      if (app.currentModule !== 'comms') return false;
      const mc = document.getElementById('module-container');
      const mod = mc && mc.querySelector('.module');
      const err = mc && mc.querySelector('.error-message');
      return !!mod && mod.id === 'comms' && !err;
    });

    await page.evaluate(() => {
      window.__printQrOpened = 0;
      window.__printQrPrinted = 0;
      window.open = () => {
        window.__printQrOpened++;
        return null;
      };
      window.print = () => {
        window.__printQrPrinted++;
      };
    });

    await page.fill('#commsOutput', 'XTOC-TEST');
    await expect(page.locator('#commsPrintQrBtn')).toBeVisible();

    await page.click('#commsPrintQrBtn');
    await page.waitForFunction(() => window.__printQrPrinted > 0);

    const opened = await page.evaluate(() => window.__printQrOpened);
    const printed = await page.evaluate(() => window.__printQrPrinted);
    expect(opened).toBe(0);
    expect(printed).toBeGreaterThan(0);
  });
});
