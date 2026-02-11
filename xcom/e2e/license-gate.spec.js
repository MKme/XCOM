const { test, expect } = require('@playwright/test');

function stubDialogs(page, opts = {}) {
  const { promptValue = 'TEST-KEY' } = opts;
  return page.addInitScript((key) => {
    try {
      window.__testPromptCalls = 0;
      window.__testAlertCalls = 0;
      window.__testLastAlert = '';
      window.prompt = () => {
        window.__testPromptCalls++;
        return key;
      };
      window.alert = (msg) => {
        window.__testAlertCalls++;
        window.__testLastAlert = String(msg ?? '');
      };
    } catch (_) {
      // ignore
    }
  }, promptValue);
}

function clearLicenseStorage(page) {
  return page.addInitScript(() => {
    try {
      localStorage.removeItem('xcom.license.ok');
      localStorage.removeItem('xcom.license.key');
      localStorage.removeItem('xcom.license.checkedAt');
      localStorage.removeItem('xcom.accessMode');
    } catch (_) {
      // ignore
    }
  });
}

test.describe('License gate', () => {
  test('blocks app until activated (access=license)', async ({ page }) => {
    await clearLicenseStorage(page);
    await stubDialogs(page, { promptValue: 'XCOM-TEST-KEY' });

    await page.route('**/license.php', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    });

    await page.goto('/?access=license');

    await expect(page.locator('#xLicenseGate')).toBeVisible();
    await expect(page.locator('#xLicenseActivateBtn')).toBeVisible();

    const appBefore = await page.evaluate(() => !!window.radioApp);
    expect(appBefore).toBe(false);

    await page.click('#xLicenseActivateBtn');
    await page.waitForFunction(() => !!window.radioApp);

    await expect(page.locator('#xLicenseGate')).toHaveCount(0);

    const ls = await page.evaluate(() => ({
      ok: localStorage.getItem('xcom.license.ok'),
      key: localStorage.getItem('xcom.license.key'),
    }));
    expect(ls.ok).toBe('1');
    expect(ls.key).toBe('XCOM-TEST-KEY');
  });

  test('invalid key keeps gate open and shows error messaging', async ({ page }) => {
    await clearLicenseStorage(page);
    await stubDialogs(page, { promptValue: 'XCOM-BAD-KEY' });

    await page.route('**/license.php', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, reason: 'invalid', message: 'Invalid license' }),
      });
    });

    await page.goto('/?access=license');

    await expect(page.locator('#xLicenseGate')).toBeVisible();
    await page.click('#xLicenseActivateBtn');

    await expect(page.locator('#xLicenseGate')).toBeVisible();
    await expect(page.locator('#xLicenseMessage')).toContainText(/license not validated/i);
    await expect(page.locator('#xLicenseCachedRow')).toBeVisible();
    await expect(page.locator('#xLicenseCachedKey')).toHaveText('XCOM-BAD-KEY');

    const ok = await page.evaluate(() => localStorage.getItem('xcom.license.ok'));
    expect(ok).not.toBe('1');

    const alertCalls = await page.evaluate(() => window.__testAlertCalls);
    expect(alertCalls).toBeGreaterThan(0);
  });

  test('Clear Key clears cached values', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('xcom.license.ok', '0');
        localStorage.setItem('xcom.license.key', 'XCOM-CACHED-KEY');
        localStorage.setItem('xcom.license.checkedAt', new Date().toISOString());
      } catch (_) {
        // ignore
      }
    });

    await page.goto('/?access=license');

    await expect(page.locator('#xLicenseGate')).toBeVisible();
    await expect(page.locator('#xLicenseCachedRow')).toBeVisible();

    await page.click('#xLicenseClearBtn');

    await expect(page.locator('#xLicenseCachedRow')).toBeHidden();
    await expect(page.locator('#xLicenseMessage')).toContainText(/cleared/i);

    const ls = await page.evaluate(() => ({
      ok: localStorage.getItem('xcom.license.ok'),
      key: localStorage.getItem('xcom.license.key'),
      checkedAt: localStorage.getItem('xcom.license.checkedAt'),
    }));
    expect(ls.ok).toBe(null);
    expect(ls.key).toBe(null);
    expect(ls.checkedAt).toBe(null);
  });
});
