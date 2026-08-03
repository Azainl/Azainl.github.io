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

function connect(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (onEvent && msg.method) {
      onEvent(msg);
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
  const errors = [];
  const cdp = connect(tab.webSocketDebuggerUrl, (msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails?.text || 'exception');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(
        (msg.params.args || [])
          .map((a) => a.value ?? a.description ?? '')
          .join(' '),
      );
    }
  });
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
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
  check(`${label}: 无控制台错误`, errors.length === 0, errors.join(' | '));
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

// 首页标签与翻页
await runPage(`${BASE}/`, async (cdp, label) => {
  const r = await evaluate(cdp, `(() => {
    const tags = [...document.querySelectorAll('.post-row .tag')];
    const cs = tags.length ? getComputedStyle(tags[0]) : null;
    return {
      nested: document.querySelectorAll('.post-row a a').length,
      tagCount: tags.length,
      fontSize: cs?.fontSize,
      padTop: cs?.paddingTop,
      height: tags[0] ? Math.round(tags[0].getBoundingClientRect().height) : 0,
      visibleRows: [...document.querySelectorAll('.post-row')].filter((el) => !el.hidden).length,
      navVisible: document.getElementById('pagination').hidden === false,
    };
  })()`);
  check(`${label}: 无嵌套链接`, r.nested === 0, `${r.nested} 个`);
  check(`${label}: 标签数量`, r.tagCount >= 8, `${r.tagCount} 个`);
  check(`${label}: 标签字号统一`, r.fontSize === '13px', r.fontSize);
  check(`${label}: 标签高度正常`, r.padTop === '2.4px' && r.height < 30, `pad=${r.padTop} h=${r.height}`);
  check(`${label}: 首页第 1 页文章数`, r.visibleRows === 4, `${r.visibleRows} 篇`);
  check(`${label}: 翻页控件显示`, r.navVisible);
}, '首页标签与翻页');

await runPage(`${BASE}/?page=2`, async (cdp, label) => {
  await evaluate(cdp, `new Promise((r) => setTimeout(r, 400))`);
  const r = await evaluate(cdp, `(() => {
    const rows = [...document.querySelectorAll('.post-row')].filter((el) => !el.hidden);
    const active = document.querySelector('.page-number[aria-current="page"]');
    const prev = document.querySelector('[data-dir="prev"]');
    return {
      visibleRows: rows.length,
      activePage: active?.dataset.page || '',
      prevDisabled: prev.hasAttribute('aria-disabled'),
      url: location.search,
    };
  })()`);
  check(`${label}: 第 2 页文章数`, r.visibleRows === 1, `${r.visibleRows} 篇`);
  check(`${label}: 当前页码高亮`, r.activePage === '2', r.activePage);
  check(`${label}: 上一页可用`, r.prevDisabled === false);
  check(`${label}: URL 页码`, r.url === '?page=2', r.url);
}, '首页翻页-第2页');

await runPage(`${BASE}/?page=9`, async (cdp, label) => {
  await evaluate(cdp, `new Promise((r) => setTimeout(r, 400))`);
  const r = await evaluate(cdp, `(() => {
    const rows = [...document.querySelectorAll('.post-row')].filter((el) => !el.hidden);
    const active = document.querySelector('.page-number[aria-current="page"]');
    const next = document.querySelector('[data-dir="next"]');
    return {
      visibleRows: rows.length,
      activePage: active?.dataset.page || '',
      nextDisabled: next.hasAttribute('aria-disabled'),
      url: location.search,
    };
  })()`);
  check(`${label}: 越界回退到末页`, r.visibleRows === 1 && r.activePage === '2', `${r.visibleRows} 篇`);
  check(`${label}: 下一页禁用`, r.nextDisabled);
}, '首页翻页-越界');

await runPage(`${BASE}/`, async (cdp, label) => {
  const r = await evaluate(cdp, `(async () => {
    document.querySelector('.page-number[data-page="2"]').click();
    await new Promise((r) => setTimeout(r, 350));
    const rows = [...document.querySelectorAll('.post-row')].filter((el) => !el.hidden);
    return {
      visibleRows: rows.length,
      url: location.search,
      paging: document.querySelector('.archive').classList.contains('paging'),
    };
  })()`);
  check(`${label}: 点击翻页`, r.visibleRows === 1 && r.url === '?page=2', `${r.visibleRows} 篇`);
  check(`${label}: 动画结束恢复`, r.paging === false);
}, '首页翻页-点击');

// 标签页与搜索页
await runPage(`${BASE}/tags/`, async (cdp, label) => {
  const r = await evaluate(cdp, `(() => ({
    tags: document.querySelectorAll('.tag-cloud .tag').length,
    counts: [...document.querySelectorAll('.tag-cloud .count')].map((e) => e.textContent),
    sizeMap: Object.fromEntries(
      [...document.querySelectorAll('.tag-cloud .tag')].map((a) => [
        a.getAttribute('href'),
        a.className,
      ]),
    ),
  }))()`);
  check(`${label}: 标签云渲染`, r.tags >= 8, `${r.tags} 个标签`);
  check(`${label}: 标签带数量`, r.counts.every((c) => /^\d+$/.test(c)), r.counts.join(','));
  check(
    `${label}: 分级按文章数`,
    r.sizeMap['/tags/随笔/']?.includes('tag-size-2') &&
      r.sizeMap['/tags/思考/']?.includes('tag-size-1'),
    JSON.stringify(r.sizeMap),
  );
}, '标签总览');

await runPage(`${BASE}/`, async (cdp, label) => {
  const r = await evaluate(cdp, `(async () => {
    const input = document.querySelector('.header-search-input');
    input.value = 'PowerShell';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const popover = document.querySelector('.search-popover');
    const items = document.querySelectorAll('.search-popover-item');
    const more = document.querySelector('.search-popover-more');
    return {
      open: popover.classList.contains('open'),
      count: items.length,
      firstHref: items[0]?.getAttribute('href') || '',
      markCount: document.querySelectorAll('.search-popover mark').length,
      moreText: more.hidden ? '' : more.textContent,
    };
  })()`);
  check(`${label}: 下拉打开`, r.open);
  check(`${label}: 结果条目`, r.count >= 1, `${r.count} 条`);
  check(`${label}: 结果链接正确`, r.firstHref.startsWith('/posts/'), r.firstHref);
  check(`${label}: 下拉关键词高亮`, r.markCount >= 1, `${r.markCount} 个`);
  check(`${label}: 查看全部链接`, r.moreText.includes('查看全部'), r.moreText);
  const closed = await evaluate(cdp, `(async () => {
    const input = document.querySelector('.header-search-input');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    return document.querySelector('.search-popover').classList.contains('open');
  })()`);
  check(`${label}: Esc 关闭`, closed === false);
}, '页头搜索');

await runPage(`${BASE}/`, async (cdp, label) => {
  const r = await evaluate(cdp, `(() => ({
    box: getComputedStyle(document.querySelector('.header-search')).display,
    link: getComputedStyle(document.querySelector('.header-search-link')).display,
  }))()`);
  check(`${label}: 搜索框隐藏`, r.box === 'none', r.box);
  check(
    `${label}: 图标按钮显示`,
    r.link === 'inline-flex' || r.link === 'flex',
    r.link,
  );
}, '页头搜索-移动端', { width: 390, height: 844 });

await runPage(`${BASE}/tags/随笔/`, async (cdp, label) => {
  const r = await evaluate(cdp, `(() => ({
    h1: document.querySelector('h1')?.textContent.trim(),
    rows: document.querySelectorAll('.post-row').length,
    desc: document.querySelector('.page-head p:last-child')?.textContent || '',
    back: [...document.querySelectorAll('a')].some((a) => a.textContent.includes('全部标签')),
    current: document.querySelectorAll('.tag-current').length,
  }))()`);
  check(`${label}: 标题`, r.h1 === '#随笔', r.h1);
  check(`${label}: 文章列表`, r.rows >= 2, `${r.rows} 篇`);
  check(`${label}: 标签描述`, r.desc.length > 0, r.desc);
  check(`${label}: 返回链接`, r.back);
  check(`${label}: 当前标签高亮`, r.current >= 1, `${r.current} 个`);
}, '标签详情');

await runPage(`${BASE}/no-such-page/`, async (cdp, label) => {
  const r = await evaluate(cdp, `(() => ({
    title: document.title,
    h1: document.querySelector('h1')?.textContent.trim(),
  }))()`);
  check(`${label}: 标题包含站点名`, r.title.includes('Azain'), r.title);
  check(`${label}: 404 文案`, r.h1 === '页面走丢了', r.h1);
}, '404页');

await runPage(`${BASE}/search/`, async (cdp, label) => {
  await evaluate(cdp, `new Promise((r) => setTimeout(r, 900))`);
  const emptyShown = await evaluate(
    cdp,
    `document.getElementById('search-empty').hidden === false`,
  );
  check(`${label}: 初始空状态`, emptyShown);

  const r = await evaluate(cdp, `(async () => {
    const input = document.getElementById('search-input');
    input.value = 'PowerShell';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    const rows = document.querySelectorAll('#search-results .post-row');
    return {
      count: rows.length,
      meta: document.getElementById('search-meta').textContent,
      marks: document.querySelectorAll('#search-results mark').length,
      firstTitle: rows[0]?.querySelector('h3')?.textContent || '',
      snippet: rows[0]?.querySelector('.search-snippet')?.textContent || '',
    };
  })()`);
  check(`${label}: 搜索命中`, r.count >= 1, `${r.count} 条`);
  check(`${label}: 结果显示标题`, r.firstTitle.length > 0, r.firstTitle);
  check(`${label}: 关键词高亮`, r.marks >= 1, `${r.marks} 个 mark`);
  check(`${label}: 正文片段`, r.snippet.length > 0, r.snippet.slice(0, 24));

  const nr = await evaluate(cdp, `(async () => {
    const input = document.getElementById('search-input');
    input.value = '完全不存在的关键词xyz';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    return {
      noneShown: document.getElementById('search-none').hidden === false,
      resultsHidden: document.getElementById('search-results').hidden === true,
    };
  })()`);
  check(`${label}: 无结果提示`, nr.noneShown && nr.resultsHidden);
}, '搜索页');

await runPage(`${BASE}/search/?q=阅读`, async (cdp, label) => {
  await evaluate(cdp, `new Promise((r) => setTimeout(r, 900))`);
  const r = await evaluate(cdp, `(() => ({
    value: document.getElementById('search-input').value,
    count: document.querySelectorAll('#search-results .post-row').length,
  }))()`);
  check(`${label}: 参数预填充`, r.value === '阅读', r.value);
  check(`${label}: 自动检索`, r.count >= 1, `${r.count} 条`);
}, '搜索-URL参数');

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

const searchJsonRes = await fetch(`${BASE}/search.json`);
check('搜索索引返回 200', searchJsonRes.ok);
if (searchJsonRes.ok) {
  const searchIndex = await searchJsonRes.json();
  check('搜索索引包含文章', searchIndex.length >= 5, `${searchIndex.length} 篇`);
  check(
    '搜索索引含正文文本',
    searchIndex.every((p) => p.content.length > 50),
    searchIndex.map((p) => p.content.length).join(','),
  );
}

console.log(results.join('\n'));
chrome.kill();
