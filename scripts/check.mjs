// 临时验证脚本：在真实浏览器环境里对页面做布局与功能断言。
// 用法：先在另一个终端跑 `npm run dev`（或 `npm run preview`），再执行 `npm run check`
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// 注意：不要写成 dirname(fileURLToPath(new URL('..', import.meta.url)))——
// fileURLToPath 会保留结尾的反斜杠（"…\blog\"），dirname 再吃掉一层就变成
// 上一级目录，导致 .chrome-tmp* / .shots 落到项目外面。
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// 可用 CHROME_BIN 环境变量覆写 Chrome 路径，否则用默认安装位置
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// preview 默认绑定 IPv6 localhost，浏览器/Node fetch 经 Local host 才能访问到
const BASE = process.env.BASE_URL || 'http://localhost:4321';
const PORT = 9223;

const chromeArgs = [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${ROOT}/.chrome-tmp2`,
  'about:blank',
];
// GitHub Actions 的容器里 Chrome 常因内核沙箱与 /dev/shm 限制起不来；
// 只在 CI 上关掉，本地保持沙箱开启，不无谓降低强度。
if (process.env.CI) chromeArgs.unshift('--no-sandbox', '--disable-dev-shm-usage');


// Chrome 被强杀后会在 profile 目录里留下 SingletonLock 等文件。下一个实例看到锁，
// 会认为已有实例在运行，于是把请求「移交」过去并**自己立刻 exit 0** ——
// 表现为「启动后立即退出」，且不打印任何输出，极难排查（本项目实际踩到过）。
// 每次运行前把 profile 目录清掉，从根上避免。
const PROFILE_DIR = `${ROOT}/.chrome-tmp2`;
// 上一个实例可能还占着目录，删不掉也不算致命（Chrome 自己会处理）
try {
  rmSync(PROFILE_DIR, { recursive: true, force: true });
} catch { /* 忽略 */ }

const chrome = spawn(CHROME, chromeArgs);

/**
 * 结束 Chrome 及其**整棵进程树**。
 *
 * Windows 上 `chrome.kill()` 只终止主进程，渲染进程会残留并继续占着
 * `--user-data-dir` 与 `--remote-debugging-port`；下一次运行就会卡在
 * 「Chrome DevTools 端口未就绪」（实测残留过 8 个进程）。用 taskkill /T 连子树一起结束。
 */
const PROFILE_TAG = PROFILE_DIR.slice(PROFILE_DIR.lastIndexOf('/') + 1); // .chrome-tmp2

function killChromeTree() {
  try {
    if (process.platform === 'win32') {
      // 不能按 spawn 返回的 pid 杀：Windows 上 chrome.exe 会「自重启」——
      // 初次进程立刻 exit 0，真正的浏览器在另外的进程里继续跑。
      // 按 profile 目录名反查进程，才杀得干净。
      spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${PROFILE_TAG}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
        ],
        { stdio: 'ignore' },
      );
    } else {
      chrome.kill('SIGKILL');
    }
  } catch {
    // 收尾失败不该影响断言结果
  }
}

// 提前抛错（例如端口等待超时）时同样要收尾，否则会攒下游离进程
process.on('exit', killChromeTree);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    killChromeTree();
    process.exit(1);
  });
}


// 收集 Chrome 的输出：端口起不来时把它一并报出来，否则只看到一句
// 「端口未就绪」，根本不知道是路径错、沙箱拦了还是单纯启动慢。
let chromeLog = '';
chrome.stderr?.on('data', (d) => { chromeLog += d.toString(); });
chrome.stdout?.on('data', (d) => { chromeLog += d.toString(); });
let chromeExit = null;
chrome.on('exit', (code) => { chromeExit = code; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 30 秒超时（原为 10 秒）。CI runner 上 Chrome 冷启动明显更慢，
// 曾因此在 GitHub Actions 上间歇性失败，而本地与上一次 CI 都是通过的。
async function waitForDebugger() {
  for (let i = 0; i < 120; i++) {
    // 注意：**不能**因为 chrome.on('exit') 触发就判定失败 —— Windows 上
    // chrome.exe 会自重启，初次进程立刻 exit 0 而浏览器照常运行。
    // 只把退出码作为超时时的诊断信息。
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(
    `Chrome DevTools 端口 ${PORT} 在 30 秒内未就绪。\n命令: ${CHROME} ${chromeArgs.join(' ')}\n` +
      `进程退出码: ${chromeExit ?? '(仍在运行)'}\n输出:\n${chromeLog.slice(-1500)}`,
  );
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
// 失败计数：结尾会换算成退出码，CI / 脚本化验证才能据以拦截。
// 此前只看输出不看退出码，导致 6 个 FAIL 被静默忽略了很久。
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

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

await runPage(`${BASE}/page/2/`, async (cdp, label) => {
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
    await runPage(`${BASE}/page/${totalPages}/`, async (cdp, label) => {
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
    // 主题是三态循环 light → dark → system：最多点 3 次直到进入深色
    let toggled = false;
    for (let i = 0; i < 3; i++) {
      document.getElementById('theme-toggle')?.click();
      await new Promise((r) => setTimeout(r, 120));
      if (document.documentElement.classList.contains('dark') !== before) {
        toggled = true;
      }
      if (document.documentElement.classList.contains('dark')) break;
    }
    const after = document.documentElement.classList.contains('dark');
    return {
      path: decodeURIComponent(location.pathname),
      href,
      marker: window.__vtMarker,
      h1,
      navOnPost,
      backVisible,
      toggleWorks: toggled && after === true,
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
    const indexAtLoad = window.history.state?.index ?? null;
    btn.click();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (location.pathname === '/') break;
    }
    await new Promise((r) => setTimeout(r, 500));
    return { visible, indexAtLoad, path: location.pathname, hash: location.hash };
  })()`);
  check(`${label}: 文章页显示返回按钮`, r.visible === true);
  check(`${label}: 点击回首页`, r.path === '/', r.path);
  // 直进时本页是该标签页的第一个条目（index 0），不存在来源页，
  // 必须回首页且不残留锚点 —— 该判定不依赖可能被污染的历史栈
  check(`${label}: 直进时无来源页可回（index=0）`, r.indexAtLoad === 0, `index=${r.indexAtLoad}`);
  check(`${label}: 回首页后无锚点残留`, r.hash === '', r.hash || '(none)');
}, '返回按钮-文章页直进');

// 目录锚点跳转后，返回按钮必须回到「来源页」，而不是上一个锚点。
// 回归背景：TOC 锚点会压入同页历史条目，若直接 history.back() 只会退一条，
// 落在正文中间的锚点上 —— 本轮修复的正是这个行为。
await runPage(`${BASE}/`, async (cdp, label) => {
  const r = await evaluate(cdp, `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, 900);
    await sleep(250);
    const yBefore = Math.round(window.scrollY);
    // 客户端导航进文章页（走 View Transitions，与用户点击一致）
    const link = [...document.querySelectorAll('a')].find(
      (a) => a.getAttribute('href') === '/posts/writing-short/',
    );
    link.click();
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      if (location.pathname.startsWith('/posts/')) break;
    }
    await sleep(400);
    const tocCount = document.querySelectorAll('.toc-list a').length;
    // 连点两个目录锚点：每次都会压入一个同页历史条目
    for (const k of [1, 2]) {
      const a = document.querySelectorAll('.toc-list a')[k];
      if (a) {
        a.click();
        await sleep(900);
      }
    }
    const hashBefore = location.hash;
    const idxBefore = window.history.state?.index ?? null;
    document.getElementById('back-button').click();
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      if (location.pathname === '/') break;
    }
    await sleep(700);
    return {
      tocCount,
      hashBefore,
      idxBefore,
      path: location.pathname,
      hash: location.hash,
      yBefore,
      yAfter: Math.round(window.scrollY),
    };
  })()`);
  check(
    `${label}: 目录锚点可跳转`,
    r.tocCount >= 2 && r.hashBefore.length > 1,
    `${r.tocCount} 个锚点 · idx=${r.idxBefore}`,
  );
  check(
    `${label}: 目录跳转后返回来源页（不停在上一锚点）`,
    r.path === '/' && r.hash === '',
    `${r.path}${r.hash}`,
  );
  check(
    `${label}: 返回后来源页滚动位置恢复`,
    Math.abs(r.yAfter - r.yBefore) <= 2,
    `${r.yBefore} -> ${r.yAfter}`,
  );
}, '返回按钮-目录锚点后返回');

// 标签页与搜索页
await runPage(`${BASE}/tags/`, async (cdp, label) => {
  const r = await evaluate(cdp, `(() => ({
    tags: document.querySelectorAll('.tag-cloud .tag').length,
    counts: [...document.querySelectorAll('.tag-cloud .count')].map((e) => e.textContent),
    sizes: [...new Set([...document.querySelectorAll('.tag-cloud .tag')].map(
      (a) => getComputedStyle(a).fontSize,
    ))],
    backVisible: (() => {
      const b = document.getElementById('back-button');
      return !!b && !b.hidden;
    })(),
  }))()`);
  check(`${label}: 标签云渲染`, r.tags >= 8, `${r.tags} 个标签`);
  check(`${label}: 标签带数量`, r.counts.every((c) => /^\d+$/.test(c)), r.counts.join(','));
  check(`${label}: 标签字号统一`, r.sizes.length === 1, r.sizes.join(','));
  check(`${label}: 显示返回按钮`, r.backVisible === true);
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

// 标签详情页必须用英文 slug URL（中文 URL 自 P1-5 起只是重定向桩，
// 走它测到的是重定向页而不是标签页本身）
await runPage(`${BASE}/tags/essays/`, async (cdp, label) => {
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

// 旧的中文标签 URL 是已发布的对外链接，必须继续 301 到 slug（astro.config.mjs
// 的 redirects）；这是重定向桩而不是标签页，单独一条用例守住它
await runPage(`${BASE}/tags/随笔/`, async (cdp, label) => {
  const r = await evaluate(cdp, `(async () => {
    // meta refresh 需要时间落定，轮询等 URL 稳定
    for (let i = 0; i < 40; i++) {
      if (location.pathname === '/tags/essays/') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return {
      path: location.pathname,
      h1: document.querySelector('h1')?.textContent.trim(),
    };
  })()`);
  check(`${label}: 重定向到 slug URL`, r.path === '/tags/essays/', r.path);
  check(`${label}: 重定向后页面正常`, r.h1 === '#随笔', r.h1);
}, '旧标签URL重定向');

await runPage(`${BASE}/tags/essays/`, async (cdp, label) => {
  const r = await evaluate(cdp, `(async () => {
    const btn = document.getElementById('back-button');
    const visible = !!btn && !btn.hidden;
    if (btn) {
      btn.click();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (location.pathname === '/') break;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
    return { visible, path: location.pathname };
  })()`);
  check(`${label}: 显示返回按钮`, r.visible === true);
  check(`${label}: 直进点击回首页`, r.path === '/', r.path);
}, '返回按钮-标签详情直进');

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

// ---- 结构化数据 / 无障碍 / 图片优先级（T-09 固化本次审计成果）----
// 这三项都是"不会让任何功能失败"的缺陷类型：JSON-LD 缺失、live region 缺失、
// 首图懒加载，页面看起来与功能上都完全正常。所以只能靠断言守。

// ① 标签页与分页页的 JSON-LD（T-02）：必须存在且能解析，且条数与页面渲染一致
for (const path of ['/tags/astro/', '/page/2/']) {
  const res = await fetch(`${BASE}${path}`);
  const html = await res.text();
  const blocks = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let parsed = null;
  try {
    parsed = blocks.map((b) => JSON.parse(b));
  } catch {
    parsed = null;
  }
  check(`${path}: 含可解析的 JSON-LD`, parsed !== null && parsed.length > 0, `${blocks.length} 块`);

  if (parsed) {
    // 递归展开 @graph，找出 CollectionPage（T-02 的产物）
    const flat = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      flat.push(n);
      Object.values(n).forEach(walk);
    };
    parsed.forEach(walk);
    const cp = flat.find((n) => n['@type'] === 'CollectionPage');
    check(`${path}: 含 CollectionPage`, !!cp);
    // 结构化数据必须与可见内容同源 —— 声明了页面上没有的文章就是欺骗爬虫
    // 只数列表项本身。两个坑：
    //  1) `class="post-row` 也会匹配 `post-row-title`，每篇被算两次（实测 12 vs 6）；
    //  2) 首页/分页页的类名是 `post-row reveal`，标签页是 `post-row` ——
    //     只认收尾引号会漏掉前者（实测 dom=0）。故用 [ "\s] 收尾。
    const domCount = (html.match(/<li class="post-row[ "]/g) || []).length;
    const ldCount = cp?.mainEntity?.numberOfItems ?? -1;
    check(
      `${path}: JSON-LD 条数与页面一致`,
      domCount > 0 && ldCount === domCount,
      `ld=${ldCount} dom=${domCount}`,
    );
    // position 必须从 1 连续递增，跳号会让富结果校验失败
    const positions = (cp?.mainEntity?.itemListElement ?? []).map((x) => x.position);
    check(
      `${path}: breadcrumb/item position 连续`,
      positions.length > 0 && positions.every((v, i) => v === i + 1),
      positions.join(','),
    );
    // 面包屑（T-03）
    const bc = flat.find((n) => n['@type'] === 'BreadcrumbList');
    check(
      `${path}: 含 BreadcrumbList 且首级为首页`,
      !!bc && bc.itemListElement?.[0]?.name === '首页',
      bc ? bc.itemListElement.map((x) => x.name).join(' > ') : '(none)',
    );
  }
}

// ② 文章页 og:type 与 BlogPosting.image（T-18）
{
  const res = await fetch(`${BASE}/posts/blog-build-notes/`);
  const html = await res.text();
  check('文章页 og:type=article', /<meta property="og:type" content="article"/.test(html));
  check('文章页含 article:published_time', /<meta property="article:published_time"/.test(html));
  const m = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  let hasImage = false;
  if (m) {
    try {
      const flat = [];
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(walk);
        flat.push(n);
        Object.values(n).forEach(walk);
      };
      walk(JSON.parse(m[1]));
      hasImage = !!flat.find((n) => n['@type'] === 'BlogPosting')?.image;
    } catch {}
  }
  check('BlogPosting 含 image', hasImage);
  // 首页必须仍然是 website，不能被文章页的改动带偏
  const homeRes = await fetch(`${BASE}/`);
  const homeHtml = await homeRes.text();
  check('首页 og:type 仍为 website', /<meta property="og:type" content="website"/.test(homeHtml));
}

// ③ 搜索 aria-live 播报区（T-04）：页头与搜索页都要有
for (const path of ['/about/', '/search/']) {
  const res = await fetch(`${BASE}${path}`);
  const html = await res.text();
  // 必须同时存在 aria-live 与 sr-only 容器：只有 sr-only 不播报，
  // 只有 aria-live 则可能被 display:none 挡在可访问性树外
  check(`${path}: 搜索播报区含 aria-live`, /aria-live="polite"/.test(html));
  check(`${path}: 播报区用 sr-only（不移出可访问性树）`, /class="sr-only"[^>]*aria-live|aria-live[^>]*class="sr-only"/.test(html));
}

// ④ 正文首图即时加载（T-05）：修复前全部 lazy，会让首图无法成为 LCP 元素
{
  const res = await fetch(`${BASE}/posts/small-site/`);
  const html = await res.text();
  const imgs = [...html.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
  check('正文有图片可断言', imgs.length > 0, `${imgs.length} 张`);
  if (imgs.length > 0) {
    check('首图 loading=eager', /loading="eager"/.test(imgs[0]));
    check('首图 fetchpriority=high', /fetchpriority="high"/.test(imgs[0]));
    // 其余图必须仍是 lazy，否则等于把全篇图都提前拉
    check(
      '非首图仍为 lazy',
      imgs.slice(1).every((t) => /loading="lazy"/.test(t)),
      `${imgs.length - 1} 张后续图`,
    );
    // 防 CLS 回归：width/height/srcset 一个都不能少
    check(
      '首图保留 width/height/srcset（防 CLS 回归）',
      imgs.every((t) => /width="\d+"/.test(t) && /height="\d+"/.test(t) && /srcset="/.test(t)),
    );
  }
}

// ---- 页面切换动画（View Transitions）----
// 这几项是"改了样式但看不出坏了"的典型：方向性关键帧若选择器不匹配，
// 页面**照样能正常切换**，只是方向动画静默失效 —— 必须断言。
//
// 本轮（动效柔和化）新增三条判据，都是"肉眼看不出、但一改就退化"的：
//   1. 出场曲线必须从静止起步（y1 === 0）—— ease-out 型曲线的起始斜率很大，
//      视觉上就是"啪一下没了"，这正是此前生硬的根因。
//   2. 位移必须足够大 —— 重叠期两层若不分开，溶解就退化成双重曝光。
//   3. 页头必须独立成层 —— persist 只复用 DOM，不把元素摘出快照；
//      不显式命名的话，root 位移会把页头渲染两份。
await runPage(
  `${BASE}/`,
  async (cdp, label) => {
  // 在过渡进行中读 ::view-transition-*(root) 的 computed 样式
  const readTransition = (action) => `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let snap = null;
    let headCounts = [];
    const t0 = performance.now();
    // 共享元素（列表标题 → 文章标题）在导航前先取名字；导航后该元素
    // 属于新文档，名字要靠这里记住才能读到伪元素。
    const titleEl0 = document.querySelector('.post-row-title');
    const tn = titleEl0 ? getComputedStyle(titleEl0).viewTransitionName : '';
    const xy = (tf) => {
      if (!tf || tf === 'none') return [0, 0];
      const m = tf.match(/matrix\\(([^)]+)\\)/);
      if (!m) return [0, 0];
      const p = m[1].split(',').map(Number);
      return p.length >= 6 ? [p[4], p[5]] : [0, 0];
    };
    // 逐帧扫描峰值位移：首帧动画尚未应用，读数恒为 0,0
    const peak = { rootOld: [0, 0], rootNew: [0, 0], titleOld: [0, 0], titleNew: [0, 0] };
    const keep = (slot, v) => {
      if (Math.abs(v[0]) > Math.abs(peak[slot][0])) peak[slot][0] = v[0];
      if (Math.abs(v[1]) > Math.abs(peak[slot][1])) peak[slot][1] = v[1];
    };
    const tick = () => {
      const dir = document.documentElement.getAttribute('data-astro-transition');
      if (dir) {
        keep('rootOld', xy(getComputedStyle(document.documentElement, '::view-transition-old(root)').transform));
        keep('rootNew', xy(getComputedStyle(document.documentElement, '::view-transition-new(root)').transform));
        if (tn) {
          keep('titleOld', xy(getComputedStyle(document.documentElement, '::view-transition-old(' + tn + ')').transform));
          keep('titleNew', xy(getComputedStyle(document.documentElement, '::view-transition-new(' + tn + ')').transform));
        }
        headCounts.push(document.querySelectorAll('.site-header').length);
        if (!snap) {
          const read = (sel) => {
            const cs = getComputedStyle(document.documentElement, sel);
            return {
              name: cs.animationName,
              dur: cs.animationDuration,
              ease: cs.animationTimingFunction,
            };
          };
          const rootCs = getComputedStyle(document.documentElement);
          snap = {
            dir,
            old: read('::view-transition-old(root)'),
            next: read('::view-transition-new(root)'),
            shift: rootCs.getPropertyValue('--vt-shift').trim(),
            headOldAnim: getComputedStyle(
              document.documentElement,
              '::view-transition-old(site-header)',
            ).animationName,
            titleName: tn,
            titleOldAnim: tn
              ? getComputedStyle(document.documentElement, '::view-transition-old(' + tn + ')').animationName
              : null,
          };
        }
      }
      if (performance.now() - t0 < 1200) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    ${action}
    await sleep(1400);
    if (snap) {
      snap.maxHeads = headCounts.length ? Math.max(...headCounts) : 0;
      snap.rootOldPeak = peak.rootOld;
      snap.rootNewPeak = peak.rootNew;
      snap.titleOldPeak = peak.titleOld;
      snap.titleNewPeak = peak.titleNew;
    }
    return snap;
  })()`;

  const fwd = await evaluate(cdp, readTransition(`document.querySelector('.post-row a').click();`));
  check(`${label}: 前进过渡有方向信息`, fwd && fwd.dir === 'forward', fwd ? fwd.dir : '(null)');
  check(
    `${label}: 前进用 forward 关键帧`,
    !!fwd && fwd.old.name === 'vt-out-forward' && fwd.next.name === 'vt-in-forward',
    fwd ? `${fwd.old.name} / ${fwd.next.name}` : '(null)',
  );

  // 判据 1：旧层在时间上先让位（时长不等才不会两层同时半透明）
  const outMs = fwd ? parseFloat(fwd.old.dur) : 0;
  const inMs = fwd ? parseFloat(fwd.next.dur) : 0;
  check(
    `${label}: 旧层让位快于新层进入`,
    outMs > 0 && inMs > 0 && outMs < inMs,
    `out ${outMs}s < in ${inMs}s`,
  );

  // 判据 2：出场曲线从静止起步。cubic-bezier(x1,y1,x2,y2) 的 y1 即起始斜率，
  // 必须为 0 —— 否则就是 ease-out 型的"突然启动"，也就是"生硬"。
  const outEase = fwd ? String(fwd.old.ease) : '';
  const y1m = outEase.match(/cubic-bezier\(\s*[-\d.]+\s*,\s*([-\d.]+)/);
  check(
    `${label}: 出场从静止起步（不生硬）`,
    !!y1m && parseFloat(y1m[1]) === 0,
    outEase || '(none)',
  );

  // 判据 3：位移足够大，重叠期两层在空间上分开
  const shift = fwd ? parseFloat(fwd.shift) : NaN;
  check(
    `${label}: 位移足以分开两层（防叠影）`,
    Number.isFinite(shift) && shift >= 16,
    `shift ${fwd ? fwd.shift : '(none)'}`,
  );

  // 判据 4：页头独立成层（不在 root 快照里），且过渡中只渲染一份
  check(
    `${label}: 页头独立成层（不在 root 快照里）`,
    !!fwd && fwd.headOldAnim === 'none',
    fwd ? `site-header old layer: ${fwd.headOldAnim}` : '(null)',
  );
  check(
    `${label}: 过渡中页头不重复渲染`,
    !!fwd && fwd.maxHeads === 1,
    fwd ? `header 元素数 ${fwd.maxHeads}` : '(null)',
  );

  // 判据 5：具名标题层（列表标题 → 文章标题）必须与页面同向同量移动。
  // 这一层会被**抽离** root 快照，默认拿到 Astro 内建的
  // astroFadeOut/astroFadeIn —— 纯淡化、零位移，于是"页面在动、文字不动"。
  // 这正是用户报的"字体移动方向与页面切换不一致"。
  check(
    `${label}: 标题文字不再只做淡化`,
    !!fwd && !!fwd.titleOldAnim && !/Fade/i.test(fwd.titleOldAnim),
    fwd ? `title layer: ${fwd.titleOldAnim || '(none)'}` : '(null)',
  );
  check(
    `${label}: 标题文字与页面同向同量`,
    !!fwd &&
      fwd.titleOldPeak[0] === fwd.rootOldPeak[0] &&
      fwd.titleOldPeak[1] === fwd.rootOldPeak[1] &&
      fwd.titleNewPeak[0] === fwd.rootNewPeak[0] &&
      fwd.titleNewPeak[1] === fwd.rootNewPeak[1] &&
      fwd.titleNewPeak[1] !== 0,
    fwd
      ? `title old=${fwd.titleOldPeak} new=${fwd.titleNewPeak} | root old=${fwd.rootOldPeak} new=${fwd.rootNewPeak}`
      : '(null)',
  );

  await evaluate(cdp, `new Promise((r) => setTimeout(r, 400))`);
  const back = await evaluate(cdp, readTransition(`history.back();`));
  check(`${label}: 后退过渡有方向信息`, back && back.dir === 'back', back ? back.dir : '(null)');
  check(
    `${label}: 后退用 back 关键帧`,
    !!back && back.old.name === 'vt-out-back' && back.next.name === 'vt-in-back',
    back ? `${back.old.name} / ${back.next.name}` : '(null)',
  );
  check(
    `${label}: 后退同样从静止起步`,
    !!back && (() => {
      const m = String(back.old.ease).match(/cubic-bezier\(\s*[-\d.]+\s*,\s*([-\d.]+)/);
      return !!m && parseFloat(m[1]) === 0;
    })(),
    back ? String(back.old.ease) : '(null)',
  );

  // 页头是 transition:persist 的：导航后节点应被复用（搜索框内容与焦点得以保留）
  await evaluate(cdp, `new Promise((r) => setTimeout(r, 500))`);
  const persist = await evaluate(
    cdp,
    `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const first = document.querySelector('.site-header');
      if (!first) return { reused: false, skip: true };
      first.dataset.probe = 'kept';
      const link = document.querySelector('.post-row a') || document.querySelector('a[href*="/posts/"]');
      if (!link) return { reused: false, skip: true };
      link.click();
      await sleep(700);
      const after = document.querySelector('.site-header');
      return {
        reused: !!after && after.dataset.probe === 'kept',
        skip: false,
        count: document.querySelectorAll('.site-header').length,
      };
    })()`,
  );
  check(
    `${label}: 页头跨导航复用（persist）`,
    !!(persist && persist.reused),
    persist && persist.skip ? '(跳过)' : persist ? '节点已复用' : '(null)',
  );
  },
  '页面切换动画',
);


// ---- 左右翻阅：轴向与「哪来哪去」----
// 这三类控件是横向翻阅（翻页、更早/更新的文章、页码），此前套用的是
// 纵向动画：点左右两边的控件，画面却上下动。更隐蔽的是「字体与页面
// 方向不一致」—— 具名标题层默认拿到 Astro 内建的 astroFadeOut/FadeIn
// （纯淡化、零位移），页面在动而文字不动。二者都不会让页面切换失败，
// 只会静默变差，所以必须断言。
await runPage(
  `${BASE}/`,
  async (cdp, label) => {
  // 采样一次横向翻阅：读到首帧位移、方向属性与具名层动画名
  const sampleAxis = (sel, nav) => `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const xy = (tf) => {
      if (!tf || tf === 'none') return [0, 0];
      const m = tf.match(/matrix\\(([^)]+)\\)/);
      if (!m) return [0, 0];
      const p = m[1].split(',').map(Number);
      return p.length >= 6 ? [p[4], p[5]] : [0, 0];
    };
    const titleEl = document.querySelector('.post-row-title, .post-title');
    const tn = titleEl ? getComputedStyle(titleEl).viewTransitionName : '';
    let snap = null;
    const t0 = performance.now();
    const el = document.querySelector(${JSON.stringify('__SEL__')}.replace('__SEL__', ${JSON.stringify(sel)}));
    if (!el) return { error: 'no element' };
    const before = { path: location.pathname, scroll: window.scrollY };
    // 位移不能在"第一帧"读：那一刻伪元素的动画尚未被应用，
    // computed transform 还是 none（恒为 0,0）。必须逐帧扫描，
    // 取达到过的**最大位移绝对值**作为方向证据（保留符号）。
    const peak = { old: [0, 0], new: [0, 0], titleOld: [0, 0], titleNew: [0, 0] };
    const keep = (slot, v) => {
      if (!v) return;
      if (Math.abs(v[0]) > Math.abs(peak[slot][0])) peak[slot][0] = v[0];
      if (Math.abs(v[1]) > Math.abs(peak[slot][1])) peak[slot][1] = v[1];
    };
    if (${JSON.stringify(nav)} === 'back') history.back(); else el.click();
    return await new Promise((resolve) => {
      function tick() {
        {
          keep('old', xy(getComputedStyle(document.documentElement, '::view-transition-old(root)').transform));
          keep('new', xy(getComputedStyle(document.documentElement, '::view-transition-new(root)').transform));
          if (tn) {
            keep('titleOld', xy(getComputedStyle(document.documentElement, '::view-transition-old(' + tn + ')').transform));
            keep('titleNew', xy(getComputedStyle(document.documentElement, '::view-transition-new(' + tn + ')').transform));
          }
        }
        if (document.documentElement.getAttribute('data-astro-transition') && !snap) {
          const read = (s) => { const cs = getComputedStyle(document.documentElement, s); return { name: cs.animationName, dur: cs.animationDuration }; };
          const ro = getComputedStyle(document.documentElement, '::view-transition-old(root)');
          const rn = getComputedStyle(document.documentElement, '::view-transition-new(root)');
          const to = tn ? getComputedStyle(document.documentElement, '::view-transition-old(' + tn + ')') : null;
          const tnew = tn ? getComputedStyle(document.documentElement, '::view-transition-new(' + tn + ')') : null;
          snap = {
            axis: document.documentElement.getAttribute('data-vt-axis'),
            backFlag: document.documentElement.hasAttribute('data-vt-back'),
            dir: document.documentElement.getAttribute('data-astro-transition'),
            rootOld: read('::view-transition-old(root)'),
            rootNew: read('::view-transition-new(root)'),
            titleName: tn,
            titleOldName: to ? to.animationName : null,
            titleNewName: tnew ? tnew.animationName : null,
          };
        }
        if (performance.now() - t0 > 1100) {
          snap = Object.assign(snap || {}, {
            oldStart: peak.old,
            newStart: peak.new,
            titleOldStart: peak.titleOld,
            titleNewStart: peak.titleNew,
          });
          resolve({ snap, before });
          return;
        }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  })()`;

  // A) 点「下一页 →」（右侧控件）→ 内容向左走，新页自右入
  const next = await evaluate(cdp, sampleAxis('[data-dir="next"]', 'click'));
  const ns = next && next.snap;
  check(`${label}: 翻页走横向轴`, !!ns && ns.axis === 'x', ns ? `data-vt-axis=${ns.axis}` : '(null)');
  check(
    `${label}: 点右侧控件 → 内容向左走（新页自右入）`,
    !!ns && ns.oldStart[1] === 0 && ns.newStart[0] > 0 && ns.newStart[1] === 0,
    ns ? `oldStart=${ns.oldStart} newStart=${ns.newStart}` : '(null)',
  );

  await evaluate(cdp, `new Promise((r) => setTimeout(r, 900))`);
  // B) 点「← 上一页」（左侧控件）→ 必须与 A 精确镜像
  const prev = await evaluate(cdp, sampleAxis('[data-dir="prev"]', 'click'));
  const ps = prev && prev.snap;
  check(`${label}: 上一页标记为后退语义`, !!ps && ps.backFlag === true, ps ? `data-vt-back=${ps.backFlag}` : '(null)');
  check(
    `${label}: 上一页走 back 键帧`,
    !!ps && ps.rootOld.name === 'vt-out-back' && ps.rootNew.name === 'vt-in-back',
    ps ? `${ps.rootOld.name} / ${ps.rootNew.name}` : '(null)',
  );
  check(
    `${label}: 上一页是下一页的精确镜像（哪来哪去）`,
    !!ns && !!ps && ps.newStart[0] === -ns.newStart[0] && ps.newStart[0] < 0,
    ns && ps ? `next newStart.x=${ns.newStart[0]} vs prev newStart.x=${ps.newStart[0]}` : '(null)',
  );

  // 翻页前后是**不同文章**，所以没有"共享元素飞行"；但旧文档的标题层
  // 仍会作为 old-only 图层退场 —— 它同样必须**跟着页面横向走**，
  // 不能自己纵向飘。这正是"字体移动方向与页面不一致"的横向版本。
  // （"共享元素同向同量"的断言放在「页面切换动画」块的 列表→文章 处，
  //   那里才有真正的同名元素对。）
  check(
    `${label}: 翻页时旧标题层也走横向（不纵向飘）`,
    !!ns && !!ns.titleOldStart && ns.titleOldStart[1] === 0 && Math.abs(ns.titleOldStart[0]) > 0,
    ns ? `titleOld peak=${ns.titleOldStart}（root old peak=${ns.oldStart}）` : '(null)',
  );

  // D) 浏览器返回键（无被点击元素）也要保持横向
  await evaluate(cdp, `new Promise((r) => setTimeout(r, 900))`);
  const bback = await evaluate(cdp, sampleAxis('[data-dir="prev"]', 'back'));
  const bs = bback && bback.snap;
  check(
    `${label}: 浏览器返回键仍保持横向`,
    !!bs && bs.axis === 'x' && bs.backFlag === true,
    bs ? `axis=${bs.axis} back=${bs.backFlag}` : '(null)',
  );
  },
  '左右翻阅动画',
);

// ---- 文章页底部：更新的文章（左）/ 更早的文章（右）----
// 与翻页同理：它们是左右翻阅，必须互为镜像。
await runPage(
  `${BASE}/posts/why-i-write/`,
  async (cdp, label) => {
  const sampleNav = (sel) => `(async () => {
    const xy = (tf) => {
      if (!tf || tf === 'none') return [0, 0];
      const m = tf.match(/matrix\\(([^)]+)\\)/);
      if (!m) return [0, 0];
      const p = m[1].split(',').map(Number);
      return p.length >= 6 ? [p[4], p[5]] : [0, 0];
    };
    const peak = { old: [0, 0], nu: [0, 0] };
    const keep = (s, v) => {
      if (Math.abs(v[0]) > Math.abs(peak[s][0])) peak[s][0] = v[0];
      if (Math.abs(v[1]) > Math.abs(peak[s][1])) peak[s][1] = v[1];
    };
    const t0 = performance.now();
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { error: 'no el' };
    const dirAttr = el.getAttribute('data-vt-dir');
    el.click();
    return await new Promise((resolve) => {
      let snap = null;
      function tick() {
        keep('old', xy(getComputedStyle(document.documentElement, '::view-transition-old(root)').transform));
        keep('nu', xy(getComputedStyle(document.documentElement, '::view-transition-new(root)').transform));
        if (document.documentElement.hasAttribute('data-astro-transition') && !snap) {
          snap = {
            dirAttr,
            axis: document.documentElement.getAttribute('data-vt-axis'),
            back: document.documentElement.hasAttribute('data-vt-back'),
          };
        }
        if (performance.now() - t0 > 1100) { resolve({ snap, peak }); return; }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  })()`;

  const newer = await evaluate(cdp, sampleNav('.post-nav-link.newer'));
  await evaluate(cdp, `new Promise((r) => setTimeout(r, 900))`);
  const older = await evaluate(cdp, sampleNav('.post-nav-link.older'));

  check(
    `${label}: 更新的文章走横向后退`,
    !!(newer && newer.snap) && newer.snap.axis === 'x' && newer.snap.back === true,
    newer && newer.snap ? `axis=${newer.snap.axis} back=${newer.snap.back}` : '(null)',
  );
  check(
    `${label}: 更早的文章走横向前进`,
    !!(older && older.snap) && older.snap.axis === 'x' && older.snap.back === false,
    older && older.snap ? `axis=${older.snap.axis} back=${older.snap.back}` : '(null)',
  );
  check(
    `${label}: 更新的/更早的文章互为镜像（哪来哪去）`,
    !!(newer && newer.peak) && !!(older && older.peak) &&
      newer.peak.nu[0] === -older.peak.nu[0] && newer.peak.nu[0] < 0,
    newer && older ? `更新的 newPeak.x=${newer.peak.nu[0]} vs 更早的 newPeak.x=${older.peak.nu[0]}` : '(null)',
  );
  },
  '文章前后导航动画',
);

// ---- 页头不透明：搜索框不能被页面文字"盖住" ----
// 起因：页头曾写成「92% 半透明 + backdrop-filter 毛玻璃」，但构建器按
// 「同一属性的重复声明」只保留了后写的 -webkit-backdrop-filter，而 Chrome
// 不认这个前缀别名（CSS.supports 为 false）—— 于是页头半透明且没有任何模糊。
// 后果是滚动时正文直接透过页头，压在搜索框上，看起来像"搜索框颜色被盖住"。
//
// 这类缺陷**不会让任何功能失败**，只是看着脏，所以必须用断言钉住：
// 页头底色必须完全不透明（alpha = 1 且不是 color(srgb …/ 0.92) 这种形式）。
await runPage(
  `${BASE}/`,
  async (cdp, label) => {
    const info = await evaluate(
      cdp,
      `(() => {
        const h = document.querySelector('.site-header');
        if (!h) return { error: 'no header' };
        const bg = getComputedStyle(h).backgroundColor;
        const bf = getComputedStyle(h).backdropFilter;
        // 把 rgb()/rgba()/color(srgb ...) 里的 alpha 抠出来
        let alpha = 1;
        const rgba = bg.match(/rgba?\\([^)]*?([\\d.]+)\\)\\s*$/);
        const slash = bg.match(/\\/\\s*([\\d.]+)\\s*\\)/);
        if (slash) alpha = parseFloat(slash[1]);
        else if (/^rgba/.test(bg) && rgba) alpha = parseFloat(rgba[1]);
        return { bg, alpha, bf };
      })()`,
    );
    check(
      `${label}: 页头底色不透明（搜索框不被正文透过）`,
      !!info && !info.error && typeof info.alpha === 'number' && info.alpha >= 1,
      info && !info.error ? `background=${info.bg} alpha=${info.alpha}` : '(null)',
    );
    // 顺带钉住"不要依赖 backdrop-filter"：它在这个构建里拿不到标准属性
    check(
      `${label}: 页头不依赖 backdrop-filter 维持可读性`,
      !!info && !info.error && (info.bf === 'none' || info.alpha >= 1),
      info && !info.error ? `backdropFilter=${info.bf} alpha=${info.alpha}` : '(null)',
    );
  },
  '页头可读性',
);

// ---- 页头搜索框：保留打开动画，只把"未打开时的底色"钉住 ----
// 起因：原本未打开时 background: transparent，聚焦才变成 --surface 纸面。
// 用户反馈"打开前后颜色不一致"。实测两态：
//   未打开  background: rgba(0, 0, 0, 0)     宽 180px，仅下边 1px --line
//   聚焦    background: rgb(251, 248, 241)   宽 240px，四边 1px 朱砂 + 光晕
// 唯一改动：未打开时也取 --surface —— 底色两态同值，开合不再跳色。
//
// **判据必须跟着改**：这里不能再断言"两态尺寸相同"。
// 180 → 240px 的延展正是要保留的动画；曾经为了"不抽动"把它钉死，
// 结果把打开时唯一的动感也抹掉了 —— 那是治错了病。
// 真正该守的是「点开时页头**其余部分**不跟着动」，所以改为测量
// 刊头 / 导航 / 主题按钮在开合两态的位置。
await runPage(
  `${BASE}/`,
  async (cdp, label) => {
    const readState = () => `(() => {
      const i = document.querySelector('.header-search-input');
      if (!i) return { error: 'no input' };
      const cs = getComputedStyle(i);
      const r = i.getBoundingClientRect();
      const probe = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { left: Math.round(b.left), right: Math.round(b.right) };
      };
      return {
        bg: cs.backgroundColor,
        topW: cs.borderTopWidth,
        botW: cs.borderBottomWidth,
        leftW: cs.borderLeftWidth,
        rightW: cs.borderRightWidth,
        topColor: cs.borderTopColor,
        botColor: cs.borderBottomColor,
        leftColor: cs.borderLeftColor,
        rightColor: cs.borderRightColor,
        width: Math.round(r.width),
        height: Math.round(r.height),
        wordmark: probe('.wordmark'),
        nav: probe('.site-nav'),
        toggle: probe('.theme-toggle'),
      };
    })()`;
    const closed = await evaluate(cdp, readState());
    await evaluate(cdp, "document.querySelector('.header-search-input').focus(); true");
    await sleep(500);
    const focused = await evaluate(cdp, readState());
    await evaluate(cdp, "document.querySelector('.header-search-input').blur(); true");
    await sleep(400);

    const ok = closed && focused && !closed.error && !focused.error;
    const visible = (c) => {
      if (!c || typeof c !== 'string') return false;
      if (/^transparent$/.test(c)) return false;
      const slash = c.match(/\/\s*([\d.]+)\s*\)/);
      if (slash) return parseFloat(slash[1]) > 0;
      const rgba = c.match(/^rgba\([^)]*?,\s*([\d.]+)\)$/);
      if (rgba) return parseFloat(rgba[1]) > 0;
      return /^rgb\(/.test(c) || /^color\(/.test(c);
    };
    // "实色"直接用 visible 判定：它同时覆盖 rgb() 与 rgba()/color() 两种序列表述。
    // 不要另写一个只查斜杠 alpha 的正则 —— Chrome 对旧值报的是
    // rgba(0, 0, 0, 0)（逗号形式，没有斜杠），只查斜杠会把它误判成实色。
    const solid = visible;

    // ① 用户报的那个问题本身：底色开合两态必须同值，且未打开时已是实色。
    //    只查"两态相等"不够 —— 两态都是 transparent 也相等，所以再查实色。
    check(
      `${label}: 搜索框底色打开前后一致`,
      ok && closed.bg === focused.bg,
      ok ? `closed=${closed.bg} focused=${focused.bg}` : '(null)',
    );
    check(
      `${label}: 未打开时底色已是纸面（不是 transparent）`,
      ok && solid(closed.bg),
      ok ? `closed=${closed.bg}` : '(null)',
    );

    // ② 打开动画必须还在：宽度要真的延展，且高度不变。
    //    否则等于把动效删了 —— 而这正是本次要恢复的东西。
    check(
      `${label}: 打开时有宽度延展动画`,
      ok && focused.width - closed.width >= 40 && closed.height === focused.height,
      ok ? `closed=${closed.width}px focused=${focused.width}px` : '(null)',
    );

    // ③ 真正的"不抽动"判据：页头其余部分在开合两态不得位移。
    //    搜索框右对齐、向**左**延展，所以左邻（导航）与右邻（主题按钮）
    //    都必须纹丝不动 —— 这才是"不抽动"该测的东西。
    const still =
      ok &&
      closed.wordmark && focused.wordmark &&
      closed.nav && focused.nav &&
      closed.toggle && focused.toggle &&
      closed.wordmark.left === focused.wordmark.left &&
      closed.nav.left === focused.nav.left &&
      closed.nav.right === focused.nav.right &&
      closed.toggle.left === focused.toggle.left &&
      closed.toggle.right === focused.toggle.right;
    check(
      `${label}: 点开时页头其余部分不位移`,
      still,
      ok
        ? `nav ${closed.nav?.left}→${focused.nav?.left} · 主题 ${closed.toggle?.right}→${focused.toggle?.right} · 刊头 ${closed.wordmark?.left}→${focused.wordmark?.left}`
        : '(null)',
    );

    // ④ 未打开时仍有"存在感"：下边线可见。盒子感由下划线 + 纸面底共同给出。
    check(
      `${label}: 未打开时下边线可见`,
      ok && visible(closed.botColor) && parseFloat(closed.botW) > 0,
      ok ? `bottom=${closed.botColor} w=${closed.botW}` : '(null)',
    );

    // ⑤ 反向确认"聚焦确实有反馈"：不能奖励一个死掉的焦点态。
    //    要求四边同时点亮（未打开时只有下边有色）。
    check(
      `${label}: 聚焦点亮四边（线色变化）`,
      ok &&
        closed.topColor !== focused.topColor &&
        visible(focused.topColor) &&
        visible(focused.leftColor) &&
        visible(focused.rightColor),
      ok
        ? `top ${closed.topColor} → ${focused.topColor}`
        : '(null)',
    );
  },
  '搜索框开合一致',
);

// ---- 关于页：题头与正文必须共用同一条左边缘 ----
// 起因：about.astro 把两个**各自居中**的盒子上下叠放：
//   .page-head  max-width: 58rem（--container-wide）
//   .prose      max-width: 34rem（--measure）
// 二者都 margin:0 auto，于是各自在视口里居中。实测 1440px 下
// 标题左边缘 271px、正文左边缘 463px —— 错位 192px，看着像两段无关的内容。
await runPage(
  `${BASE}/about/`,
  async (cdp, label) => {
    const r = await evaluate(
      cdp,
      `(() => {
        const h = document.querySelector('.page-head h1');
        const p = document.querySelector('.prose > p');
        if (!h || !p) return { error: 'missing', hasH: !!h, hasP: !!p };
        const rh = h.getBoundingClientRect();
        const rp = p.getBoundingClientRect();
        return {
          delta: +(rp.left - rh.left).toFixed(1),
          hLeft: +rh.left.toFixed(1),
          pLeft: +rp.left.toFixed(1),
          hRight: +rh.right.toFixed(1),
          pRight: +rp.right.toFixed(1),
          overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      })()`,
    );
    check(
      `${label}: 标题与正文左边缘对齐`,
      !!r && !r.error && Math.abs(r.delta) <= 2,
      r && !r.error ? `h1.left=${r.hLeft} p.left=${r.pLeft} delta=${r.delta}` : JSON.stringify(r),
    );
    check(
      `${label}: 标题与正文右边缘对齐`,
      !!r && !r.error && Math.abs(r.hRight - r.pRight) <= 2,
      r && !r.error ? `h1.right=${r.hRight} p.right=${r.pRight}` : '(null)',
    );
    check(`${label}: 无横向溢出`, !!r && !r.error && !r.overflow, String(r && r.overflow));
  },
  '关于页版式',
);

// ---- 首页列表：标签在「上方文字」与「下方分割线」之间居中 ----
// 起因：标签是 <a> 的兄弟节点，上间距 = <a> 的 24px 下内边距 + 标签 8px 外边距
// = 32px；而下间距只由标签自己的 margin-bottom 决定，原为 0。
// 实测标签底 535.4 与分割线 535.4 完全重合，视觉上"坠"在下边。
await runPage(
  `${BASE}/`,
  async (cdp, label) => {
    const rows = await evaluate(
      cdp,
      `(() => {
        const all = [...document.querySelectorAll('.post-row')];
        return all.map((row, i) => {
          const tl = row.querySelector('.tag-list');
          const p = row.querySelector('a p');
          if (!tl || !p) return null;
          const next = all[i + 1];
          const rt = tl.getBoundingClientRect();
          const rp = p.getBoundingClientRect();
          const divider = next ? next.getBoundingClientRect().top : row.getBoundingClientRect().bottom;
          return {
            above: +(rt.top - rp.bottom).toFixed(1),
            below: +(divider - rt.bottom).toFixed(1),
          };
        }).filter(Boolean);
      })()`,
    );
    // 只考察"同年份组内"的行：跨年份组时下方还有年份标题，间距天然更大
    const within = rows.filter(
      (r) => Math.abs(r.below - r.above) <= 8,
    );
    const off = rows.filter((r) => r.below < 8);
    check(
      `${label}: 首页标签在文字与分割线之间居中`,
      rows.length > 0 && off.length === 0,
      rows.length
        ? `${within.length}/${rows.length} 行上下对称（如 above=${rows[0].above} below=${rows[0].below}）；贴线行数=${off.length}`
        : '(no rows)',
    );
  },
  '首页列表间距',
);

console.log(results.join('\n'));
console.log(
  `\n${failed === 0 ? 'PASS' : 'FAIL'}  ${results.length - failed} passed, ${failed} failed, ${results.length} total`,
);
killChromeTree();
// 用 exitCode 而非 process.exit()：管道下 Node 的 stdout 是异步的，
// process.exit() 可能在 flush 前截断输出、把断言结果整段吞掉。
// exitCode 让进程自然退出，同时给出正确的返回值。
process.exitCode = failed === 0 ? 0 : 1;
