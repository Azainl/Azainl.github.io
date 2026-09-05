// 临时验证脚本：在真实浏览器环境里对页面做布局与功能断言。
// 用法：先在另一个终端跑 `npm run dev`（或 `npm run preview`），再执行 `npm run check`
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = dirname(fileURLToPath(new URL('..', import.meta.url)));
// 可用 CHROME_BIN 环境变量覆写 Chrome 路径，否则用默认安装位置
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// preview 默认绑定 IPv6 localhost，浏览器/Node fetch 经 Local host 才能访问到
const BASE = process.env.BASE_URL || 'http://localhost:4321';
const PORT = 9223;

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${ROOT}/.chrome-tmp2`,
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
    const page1Count = document.querySelectorAll('.post-row').length;
    return {
      nested: document.querySelectorAll('.post-row a a').length,
      tagCount: tags.length,
      fontSize: cs?.fontSize,
      padTop: cs?.paddingTop,
      height: tags[0] ? Math.round(tags[0].getBoundingClientRect().height) : 0,
      visibleRows: [...document.querySelectorAll('.post-row')].filter((el) => !el.hidden).length,
      navVisible: document.getElementById('pagination').hidden === false,
      page1Count,
    };
  })()`);
  check(`${label}: 无嵌套链接`, r.nested === 0, `${r.nested} 个`);
  check(`${label}: 标签数量`, r.tagCount >= 8, `${r.tagCount} 个`);
  check(`${label}: 标签字号统一`, r.fontSize === '13px', r.fontSize);
  check(`${label}: 标签高度正常`, r.padTop === '2.4px' && r.height < 30, `pad=${r.padTop} h=${r.height}`);
  check(`${label}: 首页第 1 页文章数`, r.visibleRows === r.page1Count && r.page1Count > 0, `${r.visibleRows} 篇`);
  check(`${label}: 翻页控件显示`, r.navVisible);
}, '首页标签与翻页');

await runPage(`${BASE}/page/2`, async (cdp, label) => {
  await evaluate(cdp, `new Promise((r) => setTimeout(r, 400))`);
  const r = await evaluate(cdp, `(() => {
    const total = Number(document.getElementById('pagination').dataset.total);
    const page2Count = document.querySelectorAll('.post-row').length;
    const visible = [...document.querySelectorAll('.post-row')].filter((el) => !el.hidden).length;
    const active = document.querySelector('.page-number[aria-current="page"]');
    const prev = document.querySelector('[data-dir="prev"]');
    const next = document.querySelector('[data-dir="next"]');
    return {
      total,
      page2Count,
      visible,
      activePage: active?.dataset.page || '',
      prevDisabled: prev.hasAttribute('aria-disabled'),
      nextDisabled: next.hasAttribute('aria-disabled'),
      path: location.pathname,
    };
  })()`);
  check(`${label}: 第 2 页文章数`, r.visible === r.page2Count && r.page2Count > 0, `共 ${r.total} 页，第 2 页 ${r.visible} 篇`);
  check(`${label}: 当前页码高亮`, r.activePage === '2', r.activePage);
  check(`${label}: 上一页可用`, r.prevDisabled === false);
  check(`${label}: 下一页可用`, r.nextDisabled === false);
  check(`${label}: URL 静态分页`, r.path === '/page/2/', r.path);
}, '首页翻页-第2页');

// 超出范围的分页地址应返回 404 页面（静态分页没有"回退到末页"的逻辑）
await runPage(`${BASE}/page/999`, async (cdp, label) => {
  const r = await evaluate(cdp, `(() => ({
    title: document.title,
    h1: document.querySelector('h1')?.textContent.trim(),
    hasArchive: !!document.querySelector('.archive'),
  }))()`);
  check(`${label}: 返回 404 页`, r.h1 === '页面走丢了', r.h1);
  check(`${label}: 无文章列表`, r.hasArchive === false);
}, '首页翻页-越界');

await runPage(`${BASE}/`, async (cdp, label) => {
  const r = await evaluate(cdp, `(async () => {
    const page2Count = document.querySelectorAll('.post-row').length;
    document.querySelector('.page-number[data-page="2"]').click();
    await new Promise((r) => setTimeout(r, 600));
    const rows = [...document.querySelectorAll('.post-row')].filter((el) => !el.hidden);
    return {
      visibleRows: rows.length,
      page2Count,
      path: location.pathname,
      paging: document.querySelector('.archive').classList.contains('paging'),
    };
  })()`);
  check(`${label}: 点击翻页`, r.visibleRows === r.page2Count && r.page2Count > 0, `${r.visibleRows} 篇`);
  check(`${label}: 跳转到 /page/2/`, r.path === '/page/2/', r.path);
  check(`${label}: 无残留 paging 类`, r.paging === false);
}, '首页翻页-点击');

await runPage(`${BASE}/`, async (cdp, label) => {
  await evaluate(cdp, `new Promise((r) => setTimeout(r, 300))`);
  const r = await evaluate(cdp, `(async () => {
    const prev = document.querySelector('[data-dir="prev"]');
    const page1Count = document.querySelectorAll('.post-row').length;
    prev.click();
    await new Promise((r) => setTimeout(r, 300));
    const rows = [...document.querySelectorAll('.post-row')].filter((el) => !el.hidden);
    return {
      visibleRows: rows.length,
      page1Count,
      url: location.search,
      prevDisabled: prev.getAttribute('aria-disabled'),
      tabindex: prev.getAttribute('tabindex'),
    };
  })()`);
  check(
    `${label}: 首页点上一页不越界`,
    r.visibleRows === r.page1Count && r.page1Count > 0 && r.url === '',
    `${r.visibleRows} 篇 url=${r.url}`,
  );
  check(
    `${label}: 上一页正确禁用`,
    r.prevDisabled === 'true' && r.tabindex === '-1',
    `disabled=${r.prevDisabled} tabindex=${r.tabindex}`,
  );
}, '翻页边界-首页');

// 末页：先取总页数，再直接访问 /page/{total} 验证下一页禁用
{
  const totalTab = await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`${BASE}/`)}`,
    { method: 'PUT' },
  ).then((r) => r.json());
  const totalCdp = connect(totalTab.webSocketDebuggerUrl);
  await totalCdp.ready;
  await totalCdp.send('Page.enable');
  await totalCdp.send('Page.navigate', { url: `${BASE}/` });
  await sleep(800);
  const totalPages = await evaluate(
    totalCdp,
    `Number(document.getElementById('pagination')?.dataset.total || '1')`,
  );
  totalCdp.ws.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${totalTab.id}`);

  if (totalPages >= 2) {
    await runPage(`${BASE}/page/${totalPages}`, async (cdp, label) => {
      const r = await evaluate(cdp, `(async () => {
        const next = document.querySelector('[data-dir="next"]');
        const pageRows = document.querySelectorAll('.post-row').length;
        return {
          pageRows,
          total: Number(document.getElementById('pagination').dataset.total),
          nextDisabled: next.getAttribute('aria-disabled'),
          path: location.pathname,
        };
      })()`);
      check(`${label}: 末页文章数 > 0`, r.pageRows > 0, `${r.pageRows} 篇`);
      check(`${label}: 末页路径正确`, r.path === `/page/${r.total}/`, r.path);
      check(`${label}: 下一页正确禁用`, r.nextDisabled === 'true', `disabled=${r.nextDisabled}`);
    }, '翻页边界-末页');
  } else {
    check('翻页边界-末页: 仅一页，跳过', true);
  }
}

// View Transitions：客户端切换页面
await runPage(`${BASE}/`, async (cdp, label) => {
  const r = await evaluate(cdp, `(async () => {
    window.__vtMarker = 'alive';
    const link = document.querySelector('.post-row a');
    const href = decodeURIComponent(link.getAttribute('href'));
    link.click();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (decodeURIComponent(location.pathname) === href) break;
    }
    await new Promise((r) => setTimeout(r, 700));
    const h1 = document.querySelector('.post-title')?.textContent?.trim() || '';
    const navOnPost = document.querySelector('.site-nav a[aria-current="page"]')?.textContent?.trim() || '';
    const backBtn = document.getElementById('back-button');
    const backVisible = !backBtn.hidden;
    const before = document.documentElement.classList.contains('dark');
    document.getElementById('theme-toggle')?.click(); // 切到深色
    await new Promise((r) => setTimeout(r, 100));
    const after = document.documentElement.classList.contains('dark');
    return {
      path: decodeURIComponent(location.pathname),
      href,
      marker: window.__vtMarker,
      h1,
      navOnPost,
      backVisible,
      toggleWorks: before !== after,
      darkOnPost: document.documentElement.classList.contains('dark'),
    };
  })()`);
  check(`${label}: 客户端导航到文章`, r.path === r.href && r.h1.length > 0, r.href.slice(0, 24));
  check(`${label}: 未整页刷新`, r.marker === 'alive');
  check(`${label}: 文章页无残留高亮`, r.navOnPost === '', r.navOnPost || '(none)');
  check(`${label}: 返回按钮显示`, r.backVisible === true, String(r.backVisible));
  check(`${label}: 主题切换仍可用`, r.toggleWorks);
  check(`${label}: 主题在文章页保持`, r.darkOnPost === true, String(r.darkOnPost));

  // 点击返回按钮回首页（站内导航栈 + 客户端路由，不应整页刷新）
  await evaluate(cdp, `document.getElementById('back-button').click(); 'ok'`);
  let home = null;
  for (let i = 0; i < 10 && !home; i++) {
    try {
      home = await evaluate(cdp, `(() => {
        if (location.pathname !== '/' || !document.querySelectorAll('.post-row').length) return null;
        return {
          navOnHome: document.querySelector('.site-nav a[aria-current="page"]')?.textContent?.trim() || '',
          marker: window.__vtMarker,
          darkOnHome: document.documentElement.classList.contains('dark'),
        };
      })()`);
    } catch {}
    if (!home) await sleep(1000);
  }
  check(`${label}: 返回首页`, !!home, home ? home.navOnHome : '(未返回)');
  check(`${label}: 返回未整页刷新`, home?.marker === 'alive', String(home?.marker));
  check(`${label}: 返回后导航高亮恢复`, home?.navOnHome === '首页', home?.navOnHome || '(none)');
  check(`${label}: 主题返回后保持`, home?.darkOnHome === true, String(home?.darkOnHome));

  let pageTurn = null;
  for (let i = 0; i < 6 && !pageTurn; i++) {
    try {
      pageTurn = await evaluate(cdp, `(async () => {
        const nav = document.getElementById('pagination');
        if (!nav || nav.hidden) return null;
        document.querySelector('.page-number[data-page="2"]')?.click();
        await new Promise((r) => setTimeout(r, 450));
        const visible = [...document.querySelectorAll('.post-row')].filter((el) => !el.hidden).length;
        return {
          visible,
          page2Count: document.querySelectorAll('.post-row').length,
        };
      })()`);
    } catch {}
    if (!pageTurn) await sleep(800);
  }
  check(
    `${label}: 返回后翻页可用`,
    !!pageTurn && pageTurn.visible === pageTurn.page2Count && pageTurn.page2Count > 0,
    pageTurn ? `第 2 页 ${pageTurn.visible} 篇` : '(不可用)',
  );
}, '页面切换-往返');

await runPage(`${BASE}/`, async (cdp, label) => {
  const r = await evaluate(cdp, `(() => ({
    exists: !!document.getElementById('back-button'),
  }))()`);
  check(`${label}: 首页无返回按钮`, r.exists === false, String(r.exists));
}, '返回按钮-首页');

await runPage(`${BASE}/posts/hello-world/`, async (cdp, label) => {
  const r = await evaluate(cdp, `(async () => {
    const btn = document.getElementById('back-button');
    const visible = !btn.hidden;
    btn.click();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (location.pathname === '/') break;
    }
    await new Promise((r) => setTimeout(r, 500));
    return { visible, path: location.pathname };
  })()`);
  check(`${label}: 文章页显示返回按钮`, r.visible === true);
  check(`${label}: 点击回首页`, r.path === '/', r.path);
}, '返回按钮-文章页直进');

// 标签页与搜索页
await runPage(`${BASE}/tags/`, async (cdp, label) => {
  const r = await evaluate(cdp, `(() => ({
    tags: document.querySelectorAll('.tag-cloud .tag').length,
    counts: [...document.querySelectorAll('.tag-cloud .count')].map((e) => e.textContent),
    sizes: [...new Set([...document.querySelectorAll('.tag-cloud .tag')].map(
      (a) => getComputedStyle(a).fontSize,
    ))],
  }))()`);
  check(`${label}: 标签云渲染`, r.tags >= 8, `${r.tags} 个标签`);
  check(`${label}: 标签带数量`, r.counts.every((c) => /^\d+$/.test(c)), r.counts.join(','));
  check(`${label}: 标签字号统一`, r.sizes.length === 1, r.sizes.join(','));
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
