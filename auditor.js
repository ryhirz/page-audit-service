/**
 * auditor.js —— 批量页面巡检核心
 *
 * 设计要点：
 * 1) 浏览器实例全局复用（启动一次 Chromium 约 300–800ms，逐页启停会把耗时放大 10 倍以上）；
 * 2) 每页开独立 BrowserContext，避免 cookie / localStorage 在页面之间串味；
 * 3) 并发用自实现信号量限制，不引第三方库 —— 并发数是这条链路唯一需要调的参数；
 * 4) 单页失败只影响该页，用 try/catch 隔离，整批任务永远能返回结果。
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

/**
 * 浏览器内核路径解析，优先级：环境变量 CHROME_PATH > 常见安装路径探测。
 *
 * 踩过的坑：playwright-core 与浏览器 build 版本差太多时，CDP 协议会走兼容分支，
 * 单页耗时从 2.4 秒劣化到 20 秒（差 8 倍），但不报错、只是慢，极难发现。
 * 所以默认优先用系统安装的正式版 Chrome / Edge，它们与 playwright-core 的协议最稳。
 */
const BROWSER_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function resolveBrowserPath() {
  if (process.env.CHROME_PATH) {
    if (!existsSync(process.env.CHROME_PATH)) {
      throw new Error(`CHROME_PATH 指向的文件不存在：${process.env.CHROME_PATH}`);
    }
    return process.env.CHROME_PATH;
  }
  for (const p of BROWSER_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    '未找到可用的 Chromium 内核。请安装 Chrome / Edge，或用 CHROME_PATH 指定可执行文件路径。'
  );
}

let browserPromise = null;

/** 浏览器单例：第一次调用时启动，后续复用同一个进程 */
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      executablePath: resolveBrowserPath(),
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browserPromise;
}

/** 任务结束后释放浏览器，避免 node 进程挂住不退出 */
export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close().catch(() => {});
    browserPromise = null;
  }
}

/**
 * 信号量：控制同时在跑的页面数量
 * 为什么需要：并发太高会把目标站点打到限流甚至封禁，太低则批量任务时间不可接受
 */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

/**
 * 单页巡检：打开页面 → 采集结构化指标 → 返回
 * 采集项按「能直接转成行动项」来选，不做无意义的指标堆砌
 */
async function auditOne(context, url, timeout) {
  const page = await context.newPage();
  const consoleErrors = [];
  const failedRequests = [];

  // 控制台报错和失败请求是前端质量最直接的信号，先挂监听再导航
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
  });
  page.on('requestfailed', (req) => {
    failedRequests.push({ url: req.url().slice(0, 120), reason: req.failure()?.errorText || 'unknown' });
  });

  const startedAt = Date.now();
  let response;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch (err) {
    await page.close();
    return { url, ok: false, error: `导航失败：${err.message.split('\n')[0]}`, loadMs: Date.now() - startedAt };
  }

  // 等网络基本静默，拿到更接近真实的首屏；超时不算失败
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  const loadMs = Date.now() - startedAt;
  const status = response ? response.status() : 0;

  // 所有指标在页面上下文里一次性取回，减少跨进程往返
  const metrics = await page.evaluate(() => {
    const $ = (sel) => Array.from(document.querySelectorAll(sel));
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const res = performance.getEntriesByType('resource');

    const imgs = $('img');
    const links = $('a[href]');
    const external = links.filter((a) => {
      try {
        return new URL(a.href, location.href).origin !== location.origin;
      } catch {
        return false;
      }
    });
    const targetBlankNoRel = links.filter(
      (a) => a.target === '_blank' && !/(^|\s)(noopener|noreferrer)(\s|$)/i.test(a.rel || '')
    );
    const inputs = $('input, select, textarea').filter(
      (el) => !['hidden', 'submit', 'button', 'reset'].includes(el.type)
    );

    return {
      title: document.title.trim(),
      metaDescription: (document.querySelector('meta[name="description"]')?.content || '').trim(),
      canonical: document.querySelector('link[rel="canonical"]')?.href || '',
      lang: document.documentElement.lang || '',
      h1: $('h1').map((e) => e.innerText.trim()).filter(Boolean),
      headingCounts: {
        h1: $('h1').length,
        h2: $('h2').length,
        h3: $('h3').length,
        h4: $('h4').length,
      },
      imgTotal: imgs.length,
      imgMissingAlt: imgs.filter((i) => !i.getAttribute('alt')?.trim()).length,
      imgLazy: imgs.filter((i) => i.loading === 'lazy').length,
      linkTotal: links.length,
      linkExternal: external.length,
      targetBlankNoRel: targetBlankNoRel.length,
      formTotal: $('form').length,
      inputTotal: inputs.length,
      inputNoName: inputs.filter((el) => !el.getAttribute('name')).length,
      domNodes: document.getElementsByTagName('*').length,
      // 移动端横向溢出：教育机构官网在手机上出现横向滚动条是高频投诉项
      hasHorizontalScroll: document.documentElement.scrollWidth > window.innerWidth + 2,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      ttfb: Math.round(nav.responseStart || 0),
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
      loadEvent: Math.round(nav.loadEventEnd || 0),
      transferKB: Math.round(res.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024),
      requestCount: res.length,
    };
  });

  // 用手机视口再量一次横向溢出 —— 桌面不溢出不代表移动端不溢出
  let mobileOverflow = false;
  try {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(300);
    mobileOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 2
    );
  } catch {
    /* 视口切换失败不影响主流程 */
  }

  await page.close();

  // 把离散指标折算成 0–100 的分数，便于跨页排序；扣分规则集中在一处方便调整
  const issues = [];
  if (status >= 400) issues.push(`HTTP ${status}`);
  if (!metrics.title) issues.push('缺少 title');
  if (!metrics.metaDescription) issues.push('缺少 meta description');
  if (metrics.headingCounts.h1 === 0) issues.push('缺少 H1');
  if (metrics.headingCounts.h1 > 1) issues.push(`H1 重复 ${metrics.headingCounts.h1} 个`);
  if (metrics.imgMissingAlt > 0) issues.push(`${metrics.imgMissingAlt} 张图缺 alt`);
  if (metrics.targetBlankNoRel > 0) issues.push(`${metrics.targetBlankNoRel} 个外链缺 noopener`);
  if (metrics.inputNoName > 0) issues.push(`${metrics.inputNoName} 个表单字段缺 name`);
  if (mobileOverflow) issues.push('移动端横向溢出');
  if (consoleErrors.length > 0) issues.push(`控制台 ${consoleErrors.length} 条报错`);
  if (loadMs > 3000) issues.push(`加载 ${loadMs}ms 偏慢`);

  /**
   * 健康分：100 分起扣。
   *
   * 权重按「对真实业务的影响」排，不按「好不好改」排：
   * - title / H1 缺失是致命项，直接影响搜索结果里的呈现，扣分最重；
   * - 图片 alt、表单 name 属于可批量修的低成本项，单条扣得轻但设上限；
   * - 移动端横向溢出是用户能直接看见的体验问题，单列一档；
   * - 控制台报错按条累加，因为每条背后通常是一个没处理的分支。
   */
  let score = 100;
  score -= status >= 400 ? 40 : 0;
  score -= metrics.title ? 0 : 12;
  score -= metrics.metaDescription ? 0 : 6;
  score -= metrics.headingCounts.h1 === 0 ? 12 : 0;
  score -= metrics.headingCounts.h1 > 1 ? 8 : 0;
  score -= Math.min(15, metrics.imgMissingAlt * 3);
  score -= Math.min(8, metrics.inputNoName * 2);
  score -= Math.min(8, metrics.targetBlankNoRel * 2);
  score -= mobileOverflow ? 10 : 0;
  score -= Math.min(12, consoleErrors.length * 3);
  score -= loadMs > 3000 ? 6 : 0;
  score = Math.max(0, Math.min(100, score));

  return {
    url,
    ok: true,
    status,
    loadMs,
    score,
    issues,
    consoleErrors: consoleErrors.slice(0, 5),
    failedRequests: failedRequests.slice(0, 5),
    mobileOverflow,
    ...metrics,
  };
}

/**
 * 批量巡检入口
 * @param {string[]} urls 目标地址
 * @param {object} opts concurrency 并发数 / timeout 单页超时 / onProgress 进度回调
 */
export async function auditBatch(urls, { concurrency = 3, timeout = 30000, onProgress } = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const limit = createLimiter(concurrency);
  let done = 0;
  const results = await Promise.all(
    urls.map((url) =>
      limit(async () => {
        let r;
        try {
          r = await auditOne(context, url, timeout);
        } catch (err) {
          r = { url, ok: false, error: err.message.slice(0, 200) };
        }
        done++;
        onProgress?.({ done, total: urls.length, url, ok: r.ok });
        return r;
      })
    )
  );

  await context.close();
  return results;
}

export { getBrowser };
