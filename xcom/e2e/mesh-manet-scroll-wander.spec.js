const { test, expect } = require('@playwright/test');

async function setLongUnbrokenText(page, elementId, len = 900) {
  await page.evaluate(({ id, n }) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing #${id}`);
    el.textContent = `LONG_TOKEN_${'X'.repeat(Math.max(0, Number(n) || 0))}`;
  }, { id: elementId, n: len });
}

async function getOverflowX(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return {
      clientW: el.clientWidth,
      scrollW: el.scrollWidth,
      overflowX: el.scrollWidth - el.clientWidth,
    };
  }, selector);
}

async function expectNoOverflowX(page, selector, label) {
  const m = await getOverflowX(page, selector);
  expect(m, `${label}: missing ${selector}`).not.toBeNull();
  const msg = `${label}: ${selector} scrollW/clientW=${m.scrollW}/${m.clientW}`;
  expect(m.overflowX, msg).toBeLessThanOrEqual(1);
}

test.describe('Mesh + MANET screens', () => {
  test('long tokens do not create horizontal wander on scroll', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => !!window.radioApp && typeof window.radioApp.loadModule === 'function');

    // Mesh
    await page.evaluate(() => window.radioApp.loadModule('mesh'));
    await page.waitForFunction(() => window.radioApp.currentModule === 'mesh');
    await setLongUnbrokenText(page, 'meshStatusMeta', 1200);

    await expectNoOverflowX(page, '.xMain', 'Mesh');
    await expectNoOverflowX(page, '#module-container', 'Mesh');
    await expectNoOverflowX(page, '#mesh', 'Mesh');
    await expectNoOverflowX(page, '#mesh .meshShell', 'Mesh');

    // MANET (HaLow)
    await page.evaluate(() => {
      try {
        localStorage.setItem('xcom.halow.deviceLinks.v1', JSON.stringify([
          { id: 't1', label: 'Heltec', url: `http://example.com/${'A'.repeat(900)}` },
        ]));
      } catch (_) {
        // ignore
      }
    });

    await page.evaluate(() => window.radioApp.loadModule('halow'));
    await page.waitForFunction(() => window.radioApp.currentModule === 'halow');
    await setLongUnbrokenText(page, 'halowStatusMeta', 1200);

    await expectNoOverflowX(page, '.xMain', 'MANET');
    await expectNoOverflowX(page, '#module-container', 'MANET');
    await expectNoOverflowX(page, '#halow', 'MANET');
    await expectNoOverflowX(page, '#halow .halowShell', 'MANET');
  });
});

