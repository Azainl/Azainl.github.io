// 临时验证脚本：在真实浏览器环境里对页面做布局与功能断言。
import { spawn } from 'node:child_process';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:4321';
const PORT = 9223;

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=D:/Code/blog/.chrome-tmp2',
  'about:blank',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDebugger() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome DevTools 端口未就绪');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  const ready = new Promise((resolve) => (ws.onopen = resolve));
  return { ws, send, ready };
}

async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(JSON.stringify(res.exceptionDetails));
  }
  return res.result.value;
}

const results = [];
const check = (name, ok, detail = '') =>
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);

await waitForDebugger();

async function runPage(url, fn, label, { dark = false, width = 1440, height = 1000 } = {}) {
  const tabRes = await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
  );
  const tab = await tabRes.json();
  const cdp = connect(tab.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });
  await cdp.send('Emulation.setEmulatedMedia', {
    media: 'screen',
    features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }],
  });
  await cdp.send('Page.navigate', { url });
  await sleep(1200);
  // 清掉上一个用例残留的主题偏好，保证每个页面按系统偏好走
  await cdp.send('Runtime.evaluate', {
    expression: `localStorage.clear(); location.reload();`,
  });
  await sleep(1200);
  try {
    await fn(cdp, label);
  } catch (e) {
    check(`${label}: 脚本异常`, false, e.message);
  }
  cdp.ws.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${tab.id}`);
}

const baseChecks = (cdp, label, { dark = false } = {}) =>
  evaluate(cdp, `(async () => {
    const out = {};
    out.hOverflow = document.documentElement.scrollWidth > window.innerWidth + 1;
    out.title = document.title;
    out.h1 = document.querySelector('h1')?.textContent.trim().slice(0, 24);
    out.navWrap = (() => {
      const nav = document.querySelector('.site-nav');
      return nav ? nav.getBoundingClientRect().height > 64 : null;
    })();
    out.fonts = {
      geist: document.fonts.check('400 16px "Geist Variable"'),
      serif: document.fonts.check('650 32px "Source Serif 4 Variable"'),
    };
    out.darkApplied = document.documentElement.classList.contains('dark');
    out.images = [...document.images].map(i => i.currentSrc || i.src);
    return out;
  })()`).then((r) => {
    check(`${label}: 无横向溢出`, !r.hOverflow);
    check(`${label}: 标题`, r.title.length > 0, r.title);
    check(`${label}: H1 存在`, !!r.h1, r.h1);
    check(`${label}: 导航单行`, r.navWrap === false, String(r.navWrap));
    check(`${label}: Geist 字体加载`, r.fonts.geist);
    check(`${label}: Source Serif 4 加载`, r.fonts.serif);
    check(`${label}: 深色主题生效`, r.darkApplied === dark);
  });

await runPage(`${BASE}/`, (cdp, label) => baseChecks(cdp, label, { dark: false }), '首页-浅色', {});
await runPage(`${BASE}/`, (cdp, label) => baseChecks(cdp, label, { dark: true }), '首页-深色', { dark: true });
await runPage(`${BASE}/posts/blog-build-notes/`, (cdp, label) => baseChecks(cdp, label), '文章页');
await runPage(`${BASE}/posts/blog-build-notes/`, async (cdp, label) => {
  const r = await evaluate(cdp, `(() => {
    const prose = document.querySelector('.prose');
    return {
      hasProse: !!prose,
      codeBlocks: prose ? prose.querySelectorAll('.astro-code').length : 0,
      tables: prose ? prose.querySelectorAll('table').length : 0,
      pCount: prose ? prose.querySelectorAll('p').length : 0,
    };
  })()`);
  check(`${label}: 正文容器`, r.hasProse);
  check(`${label}: 代码块高亮`, r.codeBlocks >= 1, `${r.codeBlocks} 个`);
  check(`${label}: 表格渲染`, r.tables >= 1, `${r.tables} 个`);
  check(`${label}: 段落数量`, r.pCount >= 4, `${r.pCount} 段`);
}, '文章页');
await runPage(`${BASE}/posts/why-i-write/`, async (cdp, label) => {
  const r = await evaluate(cdp, `(() => ({
    blockquotes: document.querySelectorAll('.prose blockquote').length,
  }))()`);
  check(`${label}: 引用渲染`, r.blockquotes >= 1, `${r.blockquotes} 个`);
}, '引用页面');
await runPage(`${BASE}/`, async (cdp, label) => {
  const r = await evaluate(cdp, `(async () => {
    const btn = document.getElementById('theme-toggle');
    const before = document.documentElement.classList.contains('dark');
    btn.click();
    await new Promise(r => setTimeout(r, 80));
    const after1 = document.documentElement.classList.contains('dark');
    const stored1 = localStorage.getItem('theme');
    btn.click();
    await new Promise(r => setTimeout(r, 80));
    const after2 = document.documentElement.classList.contains('dark');
    const stored2 = localStorage.getItem('theme');
    return { before, after1, stored1, after2, stored2 };
  })()`);
  check(`${label}: 首次点击关闭深色`, r.before === true && r.after1 === false);
  check(`${label}: 再次点击恢复深色`, r.after2 === true);
  check(`${label}: localStorage 同步`, r.stored1 === 'light' && r.stored2 === 'dark', `${r.stored1} -> ${r.stored2}`);
}, '主题切换', { dark: true });
await runPage(`${BASE}/`, (cdp, label) => baseChecks(cdp, label), '首页-移动端', { width: 390, height: 844 });

// 全站内部链接检查
const linksRes = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`${BASE}/`)}`, { method: 'PUT' });
const linksTab = await linksRes.json();
const linksCdp = connect(linksTab.webSocketDebuggerUrl);
await linksCdp.ready;
await linksCdp.send('Page.enable');
await linksCdp.send('Page.navigate', { url: `${BASE}/` });
await sleep(1000);
const hrefs = await evaluate(linksCdp, `(() => {
  const links = [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href'));
  const out = [];
  for (const h of links) {
    if (h.startsWith('/')) out.push(h);
  }
  return [...new Set(out)];
})()`);
linksCdp.ws.close();
await fetch(`http://127.0.0.1:${PORT}/json/close/${linksTab.id}`);

let bad = 0;
for (const href of hrefs) {
  const res = await fetch(`${BASE}${href}`);
  if (!res.ok) {
    bad++;
    check(`链接 ${href}`, false, `HTTP ${res.status}`);
  }
}
check('全站内部链接可达', bad === 0, `${hrefs.length} 个链接`);

const rssRes = await fetch(`${BASE}/rss.xml`);
const rssText = await rssRes.text();
check('RSS 返回 200', rssRes.ok);
check('RSS 包含文章', rssText.includes('<item>'), `${(rssText.match(/<item>/g) || []).length} 篇`);

const sitemapRes = await fetch(`${BASE}/sitemap-index.xml`);
check('站点地图存在', sitemapRes.ok);

console.log(results.join('\n'));
chrome.kill();
