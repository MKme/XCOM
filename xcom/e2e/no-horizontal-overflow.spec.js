const { test, expect } = require('@playwright/test');

function uniq(list) {
  return Array.from(new Set(list.filter(Boolean)));
}

test.describe('Mobile layout', () => {
  test('modules do not horizontally overflow', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => !!window.radioApp && typeof window.radioApp.loadModule === 'function');
    await page.waitForFunction(() => typeof window.radioApp.currentModule === 'string' && window.radioApp.currentModule.length > 0);

    // Prefer nav order for stable iteration, then include any extra modules.
    const { moduleIds, navOrder } = await page.evaluate(() => {
      const ids = Object.keys(window.radioApp && window.radioApp.modules ? window.radioApp.modules : {});
      const nav = Array.from(document.querySelectorAll('.xNav a[data-module]'))
        .map((a) => a.getAttribute('data-module'))
        .filter(Boolean);
      return { moduleIds: ids, navOrder: nav };
    });

    const ordered = uniq([...navOrder, ...moduleIds]).filter((id) => moduleIds.includes(id));
    expect(ordered.length).toBeGreaterThan(0);

    for (const moduleId of ordered) {
      await page.evaluate((m) => window.radioApp.loadModule(m), moduleId);

      await page.waitForFunction((m) => {
        const app = window.radioApp;
        if (!app) return false;
        if (app.currentModule !== m) return false;
        const mc = document.getElementById('module-container');
        const mod = mc && mc.querySelector('.module');
        const err = mc && mc.querySelector('.error-message');
        return !!mod && mod.id === m && !err;
      }, moduleId);

      const metrics = await page.evaluate(() => {
        const main = document.querySelector('.xMain');
        const mc = document.getElementById('module-container');
        const mod = mc && mc.querySelector('.module');

        const dims = (el) => {
          if (!el) return null;
          return {
            clientW: el.clientWidth,
            scrollW: el.scrollWidth,
            overflow: el.scrollWidth - el.clientWidth,
          };
        };

        return {
          viewportW: document.documentElement.clientWidth,
          main: dims(main),
          moduleContainer: dims(mc),
          module: dims(mod),
        };
      });

      const mainOver = metrics.main ? metrics.main.overflow : 0;
      const mcOver = metrics.moduleContainer ? metrics.moduleContainer.overflow : 0;

      const msg = `module=${moduleId} viewportW=${metrics.viewportW} main=${metrics.main ? `${metrics.main.scrollW}/${metrics.main.clientW}` : 'n/a'} mc=${metrics.moduleContainer ? `${metrics.moduleContainer.scrollW}/${metrics.moduleContainer.clientW}` : 'n/a'}`;

      if (mainOver > 1 || mcOver > 1) {
        const offenders = await page.evaluate(() => {
          const mc = document.getElementById('module-container');
          const mod = mc && mc.querySelector('.module');
          if (!mc || !mod) return [];

          const pickLabel = (el) => {
            const tag = el.tagName.toLowerCase();
            const id = el.id ? `#${el.id}` : '';
            const cls = (el.getAttribute('class') || '')
              .trim()
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 3)
              .map((c) => `.${c}`)
              .join('');
            return `${tag}${id}${cls}`;
          };

          const list = [];
          for (const el of Array.from(mod.querySelectorAll('*'))) {
            if (!el.clientWidth || !el.scrollWidth) continue;
            const over = el.scrollWidth - el.clientWidth;
            if (over > 1) {
              list.push({
                el: pickLabel(el),
                over,
                clientW: el.clientWidth,
                scrollW: el.scrollWidth,
              });
            }
          }

          list.sort((a, b) => b.over - a.over);
          return list.slice(0, 10);
        });

        throw new Error(`${msg} offenders=${JSON.stringify(offenders)}`);
      }

      expect(mainOver, msg).toBeLessThanOrEqual(1);
      expect(mcOver, msg).toBeLessThanOrEqual(1);
    }
  });
});

