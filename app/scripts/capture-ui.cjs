/* 截图脚本：访问 Vite dev server，对 home 浅/深色分别截图。
   想看其他页面（settings/usage/logs）需要先在 AppContext 注入 dev-only 的 ?view=xxx 钩子；
   先看 home 验证 token 系统和字体已经够了。*/
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(ROOT, 'tmp/ui-screenshots');
fs.mkdirSync(OUT, { recursive: true });

const URL = 'http://127.0.0.1:3000';

(async () => {
  const browser = await chromium.launch({ headless: true });

  for (const colorScheme of ['light', 'dark']) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 820 },
      deviceScaleFactor: 1,
      colorScheme,
    });
    const page = await ctx.newPage();

    // 强制在加载前注入 localStorage（避免 matchMedia 异步跟随延迟影响截图）
    await page.addInitScript((dark) => {
      const stored = {
        ui: { theme: dark ? 'dark' : 'light', themePreferenceVersion: 2 },
        agentThemeOverride: !dark, // false 表示跟随系统（不会被我的 matchMedia 覆盖）
      };
      try {
        window.localStorage.setItem('agent-llm-local-state-v1', JSON.stringify({ ui: stored.ui }));
        if (dark) window.localStorage.setItem('agent-llm-theme-manual', '1');
      } catch (e) {}
    }, colorScheme === 'dark');

    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('[browser error]', msg.text());
    });

    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    // 验证 dark class 是否加上了
    const htmlClass = await page.evaluate(() => document.documentElement.className);
    console.log(`[${colorScheme}] html.className =`, htmlClass);

    const file = path.join(OUT, `home-${colorScheme}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log('saved', file);
    await ctx.close();
  }

  await browser.close();
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });
