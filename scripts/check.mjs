// 临时验证脚本：在真实浏览器环境里对页面做布局与功能断言。
// 用法：先在另一个终端跑 `npm run dev`（或 `npm run preview`），再执行 `npm run check`
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

async function runPage(
  url,
  fn,
  label,
  { dark = false, width = 1440, height = 1000, initScript = '' } = {},
) {
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
  // 需要在页面脚本之前打桩时用（例如 Web Share API 必须在首次加载前存在，
  // 否则按钮的监听与显隐在初始化时就已经定型）。reload 后同样会执行。
  if (initScript) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: initScript });
  }
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

// ---- T-22 搜索面板 Tab 键缺陷（2026-10-19）----
// 这条缺陷肉眼完全看不出：面板里的选项是原生 <a href>，Tab 会从输入框直接跳进
// 第 1 个结果，而 aria-activedescendant 仍指着旧值 —— 只有读屏用户能感知到不一致。
// **必须用 CDP Input.dispatchKeyEvent**：new KeyboardEvent 是合成事件，不触发浏览器的
// 默认 Tab 行为（焦点移动是 UA 行为，不是 JS 可合成的），所以本文件在此之前从未用过
// Input 域。keyDown 与 keyUp 必须成对发送，否则 Chrome 会把按键当成一直按住。
await runPage(`${BASE}/`, async (cdp, label) => {
  // 先让搜索面板打开且有结果
  await evaluate(cdp, `(async () => {
    const input = document.querySelector('.header-search-input');
    input.focus();
    input.value = 'PowerShell';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
  })()`);

  const before = await evaluate(cdp, `(() => ({
    open: document.querySelector('.search-popover').classList.contains('open'),
    count: document.querySelectorAll('.search-popover-item').length,
    tabIndexes: [...document.querySelectorAll('.search-popover-item')]
      .map((el) => el.tabIndex),
    focused: document.activeElement?.className || '',
  }))()`);
  check(`${label}: 面板已打开且有结果`, before.open && before.count >= 1,
    `open=${before.open} count=${before.count}`);
  check(
    `${label}: 选项不进 Tab 序列（tabIndex 全为 -1）`,
    before.tabIndexes.length > 0 && before.tabIndexes.every((t) => t === -1),
    before.tabIndexes.join(','),
  );
  check(`${label}: Tab 前焦点在输入框`, before.focused.includes('header-search-input'), before.focused);

  // 真发一次 Tab（CDP Input 域），观察焦点落到哪里、面板是否收起
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
  });
  await sleep(200);

  const after = await evaluate(cdp, `(() => {
    const a = document.activeElement;
    return {
      role: a?.getAttribute('role') || '',
      cls: a?.className || '',
      tag: a?.tagName || '',
      open: document.querySelector('.search-popover').classList.contains('open'),
      expanded: document.querySelector('.header-search-input')?.getAttribute('aria-expanded'),
      activeDesc: document.querySelector('.header-search-input')?.getAttribute('aria-activedescendant') ?? null,
    };
  })()`);
  check(
    `${label}: Tab 后焦点不落在 option 上`,
    after.role !== 'option',
    `activeElement=${after.tag}.${after.cls} role=${after.role || '(none)'}`,
  );
  check(`${label}: Tab 后面板收起`, after.open === false, `open=${after.open}`);
  check(`${label}: Tab 后 aria-expanded 复位`, after.expanded === 'false', String(after.expanded));
  check(`${label}: Tab 后 activedescendant 已移除`, after.activeDesc === null, String(after.activeDesc));
  check(
    `${label}: Tab 仍能移到下一个元素（未 preventDefault）`,
    after.tag !== 'BODY' && after.cls !== '' ,
    `${after.tag}.${after.cls}`,
  );
}, '页头搜索-Tab 键');

// 反向守卫：鼠标点击选项必须仍能跳转（tabindex=-1 不该影响鼠标路径）
await runPage(`${BASE}/`, async (cdp, label) => {
  const href = await evaluate(cdp, `(async () => {
    const input = document.querySelector('.header-search-input');
    input.focus();
    input.value = 'PowerShell';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const first = document.querySelector('.search-popover-item');
    return first ? first.getAttribute('href') : '';
  })()`);
  check(`${label}: 选项 href 仍可点击跳转`, href.startsWith('/posts/'), href);

  // 方向键 + Enter 的原有路径不回归（合成 KeyboardEvent 足够：这条是 JS 逻辑不是 UA 行为）
  const enterOk = await evaluate(cdp, `(async () => {
    const input = document.querySelector('.header-search-input');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const active = document.querySelector('.search-popover-item.active');
    const desc = input.getAttribute('aria-activedescendant');
    return { hasActive: !!active, desc: desc || '', activeId: active?.id || '' };
  })()`);
  check(`${label}: 方向键仍能高亮选项`, enterOk.hasActive, JSON.stringify(enterOk));
  check(
    `${label}: activedescendant 与高亮项一致`,
    enterOk.desc !== '' && enterOk.desc === enterOk.activeId,
    `desc=${enterOk.desc} active=${enterOk.activeId}`,
  );
}, '页头搜索-Tab 键回归');

// ---- T-23 命令面板：空查询的页面跳转入口（2026-10-19）----
// 判定标准全部落在"用户可观察的行为"上：面板里有几项、在不在同一个 listbox 里、
// 方向键能不能跨组连续走、Home/End 是否直达两端、Esc 之后焦点与 ARIA 是否复位。
// Ctrl/Cmd+K 必须走 CDP Input 域：本文件原有实现里它零断言，从未被真正按过。
await runPage(`${BASE}/`, async (cdp, label) => {
  const pressK = async (modifiers) => {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75, modifiers,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75, modifiers,
    });
    await sleep(400);
  };
  const snapshot = () => evaluate(cdp, `(() => ({
    focused: document.activeElement?.className || '',
    focusedTag: document.activeElement?.tagName || '',
    open: document.querySelector('.search-popover')?.classList.contains('open'),
    expanded: document.querySelector('.header-search-input')?.getAttribute('aria-expanded'),
    groups: [...document.querySelectorAll('.search-popover-group')].map((g) => g.getAttribute('aria-labelledby')),
  }))()`);

  // Windows 上 Ctrl=2；Mac 上 Meta=4。两个都派发，两条路径都要能开面板。
  await pressK(2);
  const ctrl = await snapshot();
  check(`${label}: Ctrl+K 打开面板`, ctrl.open === true, `open=${ctrl.open}`);
  check(
    `${label}: Ctrl+K 后焦点在搜索框`,
    ctrl.focused.includes('header-search-input'),
    `${ctrl.focusedTag}.${ctrl.focused}`,
  );
  check(`${label}: Ctrl+K 后 aria-expanded=true`, ctrl.expanded === 'true', String(ctrl.expanded));

  // Esc 收起，再试 Meta+K（Mac 的主路径）
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
  await sleep(200);
  await pressK(4);
  const meta = await snapshot();
  check(`${label}: Meta+K 打开面板`, meta.open === true, `open=${meta.open}`);
  check(
    `${label}: Meta+K 后焦点在搜索框`,
    meta.focused.includes('header-search-input'),
    `${meta.focusedTag}.${meta.focused}`,
  );
}, '搜索面板-CtrlK');

await runPage(`${BASE}/`, async (cdp, label) => {
  // 聚焦但不输入：这时的面板是"入口态"，列出页面/标签/系列三组静态目标
  const nav = await evaluate(cdp, `(async () => {
    const input = document.querySelector('.header-search-input');
    input.focus();
    await new Promise((r) => setTimeout(r, 600));
    const popover = document.querySelector('.search-popover');
    const list = document.getElementById('search-popover-list');
    const options = [...document.querySelectorAll('.search-popover-item')];
    const groups = [...document.querySelectorAll('.search-popover-group')];
    const nav2 = await fetch('/nav.json').then((r) => r.json());
    return {
      open: popover?.classList.contains('open'),
      listHidden: list?.hidden,
      role: list?.getAttribute('role'),
      count: options.length,
      expected: nav2.pages.length + nav2.tags.length + nav2.series.length + nav2.topics.length,
      expectedPages: nav2.pages.length,
      expectedTags: nav2.tags.length,
      expectedSeries: nav2.series.length,
      expectedTopics: nav2.topics.length,
      groups: groups.length,
      groupLabels: groups.map((g) => document.getElementById(g.getAttribute('aria-labelledby'))?.textContent || ''),
      labels: [...document.querySelectorAll('.search-popover-group-label')].map((e) => e.textContent),
      insideList: options.every((el) => el.closest('[role=listbox]')?.id === 'search-popover-list'),
      listboxCount: document.querySelectorAll('[role=listbox]').length,
      ids: options.map((el) => el.id),
      hrefs: options.map((el) => el.getAttribute('href')),
      tabIndexes: options.map((el) => el.tabIndex),
      ariaExpanded: document.querySelector('.header-search-input')?.getAttribute('aria-expanded'),
    };
  })()`);
  check(`${label}: 空查询面板打开`, nav.open === true, `open=${nav.open}`);
  check(`${label}: 空查询面板列出全部静态目标`, nav.count === nav.expected && nav.count > 0,
    `${nav.count} 项 / 期望 ${nav.expected}（页面 ${nav.expectedPages} + 标签 ${nav.expectedTags} + 系列 ${nav.expectedSeries} + 专题 ${nav.expectedTopics}）`);
  check(`${label}: 分组齐全（页面/标签/系列/专题）`, nav.groups >= 2 && nav.groupLabels.length === nav.groups,
    `${nav.groups} 组: ${nav.groupLabels.join(' / ')}`);
  check(`${label}: 分组标题可读`, nav.labels.join('') === '页面标签系列专题', nav.labels.join(' / '));
  check(`${label}: 全站只有一个 listbox`, nav.listboxCount === 1, `${nav.listboxCount} 个`);
  check(`${label}: 所有选项都在搜索框指向的 listbox 内`, nav.insideList === true);
  check(`${label}: 选项 id 全局唯一`, new Set(nav.ids).size === nav.ids.length,
    `${new Set(nav.ids).size}/${nav.ids.length} 唯一`);
  check(`${label}: 选项仍不进 Tab 序列`, nav.tabIndexes.every((t) => t === -1), nav.tabIndexes.join(','));
  check(`${label}: 选项 href 有效`, nav.hrefs.every((h) => typeof h === 'string' && h.startsWith('/')),
    `${nav.hrefs.filter((h) => h && h.startsWith('/')).length}/${nav.hrefs.length}`);
  check(`${label}: 列出后 aria-expanded=true`, nav.ariaExpanded === 'true', String(nav.ariaExpanded));

  // 方向键必须跨组连续：走完第一组（页面）后，下一次 ArrowDown 应落到第一个标签上。
  // 锚点从 nav.json 的 pages 数量反推，不写死下标 —— 页面组增减一项时这里会自动跟上。
  const steps = nav.expectedPages + 1;
  const walk = await evaluate(cdp, `(async () => {
    const steps = ${steps};
    const input = document.querySelector('.header-search-input');
    const press = (key) => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    const state = () => {
      const active = document.querySelector('.search-popover-item.active');
      if (!active) return null;
      const group = active.closest('.search-popover-group');
      const labelId = group?.getAttribute('aria-labelledby') || '';
      return {
        id: active.id,
        group: document.getElementById(labelId)?.textContent || '',
        desc: input.getAttribute('aria-activedescendant') || '',
        index: [...document.querySelectorAll('.search-popover-item')].indexOf(active),
      };
    };
    const seen = [];
    for (let i = 0; i < steps; i++) { press('ArrowDown'); await new Promise((r) => setTimeout(r, 20)); seen.push(state()); }
    press('End'); await new Promise((r) => setTimeout(r, 20));
    const end = state();
    press('Home'); await new Promise((r) => setTimeout(r, 20));
    const home = state();
    press('ArrowUp'); await new Promise((r) => setTimeout(r, 20));
    const upAtTop = state();
    return { seen, end, home, upAtTop, total: document.querySelectorAll('.search-popover-item').length };
  })()`);
  const last = walk.seen[walk.seen.length - 1];
  const firstTagIndex = nav.expectedPages;
  check(
    `${label}: 方向键跨组连续`,
    last?.index === firstTagIndex && last?.group === '标签',
    `第 ${firstTagIndex + 1} 次 ArrowDown → index=${last?.index} group=${last?.group}`,
  );
  check(`${label}: 跨组后 activedescendant 仍唯一且对齐`,
    walk.seen.every((s, i) => s && s.desc === s.id && s.index === i),
    walk.seen.map((s) => `${s?.index}:${s?.group}`).join(' '));
  check(`${label}: End 直达最后一项`, walk.end?.index === walk.total - 1,
    `index=${walk.end?.index} total=${walk.total}`);
  check(`${label}: Home 直达第一项`, walk.home?.index === 0, `index=${walk.home?.index}`);
  check(`${label}: 在首项再按 ArrowUp 不越界`, walk.upAtTop?.index === 0, `index=${walk.upAtTop?.index}`);
}, '搜索面板-页面跳转');

await runPage(`${BASE}/`, async (cdp, label) => {
  // Esc 只负责退出面板：输入框里的字是用户自己敲的，不该被顺手擦掉
  const after = await evaluate(cdp, `(async () => {
    const input = document.querySelector('.header-search-input');
    input.focus();
    input.value = 'PowerShell';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const beforeClose = {
      open: document.querySelector('.search-popover').classList.contains('open'),
      count: document.querySelectorAll('.search-popover-item').length,
    };
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    return {
      beforeClose,
      value: input.value,
      open: document.querySelector('.search-popover').classList.contains('open'),
      expanded: input.getAttribute('aria-expanded'),
      desc: input.getAttribute('aria-activedescendant'),
      activeKept: document.querySelectorAll('.search-popover-item.active').length,
    };
  })()`);
  check(`${label}: 有查询时仍走正文搜索`, after.beforeClose.open && after.beforeClose.count >= 1,
    `${after.beforeClose.count} 条`);
  check(`${label}: Esc 后关键词保留原样`, after.value === 'PowerShell', JSON.stringify(after.value));
  check(`${label}: Esc 后面板关闭`, after.open === false);
  check(`${label}: Esc 后 aria-expanded 复位`, after.expanded === 'false', String(after.expanded));
  check(`${label}: Esc 后 activedescendant 移除`, after.desc === null, String(after.desc));
  check(`${label}: Esc 后高亮态清空`, after.activeKept === 0, `${after.activeKept} 个`);
}, '搜索面板-Esc 复位');

await runPage(`${BASE}/`, async (cdp, label) => {
  // 页头有 transition:persist，DOM 不随导航重建 —— 弹层若只靠 onPageLoad 重置，
  // 用户点了结果跳到新页面后会看到上一条遗留的面板。
  const r = await evaluate(cdp, `(async () => {
    const input = document.querySelector('.header-search-input');
    input.focus();
    await new Promise((r) => setTimeout(r, 600));
    const opened = document.querySelector('.search-popover').classList.contains('open');
    const link = [...document.querySelectorAll('.site-nav a')].find((a) => a.getAttribute('href')?.endsWith('/tags/'));
    if (link) link.click();
    await new Promise((r) => setTimeout(r, 1600));
    return {
      opened,
      path: location.pathname,
      open: document.querySelector('.search-popover')?.classList.contains('open'),
      expanded: document.querySelector('.header-search-input')?.getAttribute('aria-expanded'),
      desc: document.querySelector('.header-search-input')?.getAttribute('aria-activedescendant'),
    };
  })()`);
  check(`${label}: 导航前面板是打开的`, r.opened === true, `open=${r.opened}`);
  check(`${label}: 客户端导航确实发生了`, r.path === '/tags/', r.path);
  check(`${label}: 跨页后面板不残留`, r.open === false, `open=${r.open}`);
  check(`${label}: 跨页后 aria-expanded 复位`, r.expanded === 'false', String(r.expanded));
  check(`${label}: 跨页后 activedescendant 移除`, r.desc === null, String(r.desc));
}, '搜索面板-跨页残留');

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
  const r = await evaluate(cdp, `(() => {
    const root = document.querySelector('.not-found');
    const links = root ? [...root.querySelectorAll('a[href]')] : [];
    const hrefs = [...new Set(links.map((a) => a.getAttribute('href')))];
    const internal = hrefs.filter((h) => h && h.startsWith('/'));
    const form = root?.querySelector('form');
    return {
      title: document.title,
      h1: document.querySelector('h1')?.textContent.trim(),
      internalCount: internal.length,
      internal,
      hasSearchForm: !!form && form.getAttribute('action') === '/search/' && form.getAttribute('method') === 'get',
      hasSearchInput: !!root?.querySelector('input[name="q"]'),
      recentCount: root ? [...root.querySelectorAll('.not-found-list a[href^="/posts/"]')].length : 0,
      tagCount: root ? [...root.querySelectorAll('.not-found-tags a[href^="/tags/"]')].length : 0,
      pageLinks: root ? [...root.querySelectorAll('.not-found-pages a[href]')].map((a) => a.getAttribute('href')) : [],
      h2Count: root ? [...root.querySelectorAll('h2')].length : 0,
    };
  })()`);
  check(`${label}: 标题包含站点名`, r.title.includes('Azain'), r.title);
  check(`${label}: 404 文案`, r.h1 === '页面走丢了', r.h1);

  // ---- T-33 404 页要有真正的出路（2026-10-20）----
  // 改动前这一页只有 h1 + 一句话 + 一个「回到首页」链接（全文 2 个 href）。
  // 现在的门槛：至少 10 条站内链接、5 篇最近文章、6 个标签入口、4 个常用页面，
  // 外加一个能用的搜索框。数值都是下限，将来加内容不会红，砍内容会红。
  check(`${label}: 站内链接不少于 10 条`, r.internalCount >= 10, `${r.internalCount} 条`);
  check(`${label}: 提供搜索表单并指向 /search/`, r.hasSearchForm && r.hasSearchInput);
  check(`${label}: 列出最近文章`, r.recentCount >= 5, `${r.recentCount} 篇`);
  check(`${label}: 提供标签入口`, r.tagCount >= 6, `${r.tagCount} 个`);
  check(
    `${label}: 提供归档/标签/关于入口`,
    ['/archive/', '/tags/', '/about/'].every((h) => r.pageLinks.includes(h)),
    r.pageLinks.join(' '),
  );
  // 结构：两个分组标题（最近更新 / 按标签找），h2 不能为空，否则屏幕阅读器读不出分区
  check(`${label}: 分区块有标题`, r.h2Count >= 2, `${r.h2Count} 个 h2`);

  // 这些链接是本页独有的（404 不进 sitemap），全站链接扫描覆盖不到。
  // 逐个 fetch 一次，确认没有埋死链 —— 曾经这里只有 1 个链接，想埋死链也没机会。
  const dead = [];
  for (const h of r.internal) {
    const res = await fetch(`${BASE}${h}`);
    if (!res.ok) dead.push(`${h} HTTP ${res.status}`);
  }
  check(`${label}: 页内链接全部可达`, dead.length === 0, dead.slice(0, 3).join(' | ') || `${r.internalCount} 条已探测`);
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
const homeHrefs = await evaluate(linksCdp, `(() => {
  const links = [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href'));
  const out = [];
  for (const h of links) {
    if (h.startsWith('/')) out.push(h);
  }
  return [...new Set(out)];
})()`);
linksCdp.ws.close();
await fetch(`http://127.0.0.1:${PORT}/json/close/${linksTab.id}`);

// 标题曾写「全站」，实际只扫首页。实测首页仅 33 条站内链接，全站去重后 54 条 ——
// 也就是 21 条从未被任何断言探测过（缺一篇、写错一个 slug 都不会被发现）。
// 这里改为：从 sitemap 取全部页面 URL，逐页抓 href 合并去重，再逐一探测。
const sitemapXml = await (await fetch(`${BASE}/sitemap-0.xml`)).text();
const pagePaths = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)]
  .map((m) => m[1].replace(/^https?:\/\/[^/]+/, ''))
  .filter((p) => p);
const hrefSet = new Set();
for (const p of pagePaths) {
  const res = await fetch(`${BASE}${p}`);
  if (!res.ok) continue;
  const html = await res.text();
  for (const m of html.matchAll(/href="(\/[^"]*)"/g)) hrefSet.add(m[1]);
}
const hrefs = [...hrefSet];
// 下限是闸门：真全站扫描必须落在 45 条以上；退回首页单页扫描会立刻跌破
check(
  '全站链接扫描覆盖 sitemap 全部页面',
  pagePaths.length >= 40 && hrefs.length >= 45,
  `${pagePaths.length} 页 / ${hrefs.length} 个站内链接（首页单页仅 ${homeHrefs.length} 个）`,
);

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

// ---- T-25 feed 抽取后的行为金标准（2026-10-19）----
// 背景：rss.xml.js 的 6 段逻辑被抽到 src/utils/feed.ts，重构前后产物必须逐字节相同
// （sha256 93b71be7… 已一次性存档比对过）。但一次性比对无法守护将来，
// 这 4 条断言把「当前主 feed 的关键结构」固定下来，防止后续 T-26 重构悄悄丢字段。
// 断言口径全部是「主 feed 必须有」，不看具体值 —— 值会随文章增删变化。
{
  check('T-25 主 feed 输出全文正文', rssText.includes('<content:encoded>'), `content:encoded ${(rssText.match(/<content:encoded>/g) || []).length} 条`);
  check('T-25 主 feed 有 lastBuildDate', /<lastBuildDate>[^<]+<\/lastBuildDate>/.test(rssText), (rssText.match(/<lastBuildDate>([^<]+)<\/lastBuildDate>/) || [])[1] ?? '缺失');
  check('T-25 主 feed 声明语言', /<language>zh-cn<\/language>/.test(rssText));
  // T-32 改了这条的口径：从「条数 ≤ 30」变成「条数 == 全部已发布文章数」。
  // 旧断言守护的是「截断生效」，而截断本身就是 bug —— 它守护的是一个错误行为，
  // 所以主 feed 覆盖 30/32 时它反而是绿的。真正的守护对象是「不漏文章」。
  // 期望值从 sitemap 的文章条目反推（独立口径，不读源码常量）。
  const smForCount = await (await fetch(`${BASE}/sitemap-0.xml`)).text();
  const publishedN = (smForCount.match(/<loc>[^<]*\/posts\/[^<]+<\/loc>/g) || []).length;
  const mainItems = (rssText.match(/<item>/g) || []).length;
  check(
    'T-32 主 feed 条目数等于全部已发布文章数',
    publishedN > 0 && mainItems === publishedN,
    `${mainItems} vs sitemap 文章页 ${publishedN}`,
  );
  check(
    'T-32 主 feed 只对最近若干篇输出全文',
    (rssText.match(/<content:encoded>/g) || []).length === 20 && mainItems > 20,
    `content:encoded ${(rssText.match(/<content:encoded>/g) || []).length} 条 / item ${mainItems} 条`,
  );
}

// ---- T-26 分发能力：子 feed / JSON Feed / 订阅页（2026-10-19）----
// 背景：P2-3 把「一个订阅源」变成「可分发的一族订阅源」。这里只做三件事：
//   ① 产物必须真的落盘且数量对得上（12 个标签 + 1 个系列）；
//   ② 每个子 feed 的条数必须等于该标签/系列已发布文章数 —— 用 dist 反查，
//      不读源码口径，避免「源码改了但产物没变」这种假绿；
//   ③ JSON Feed 与 RSS 的日期格式不同（RFC3339 vs RFC822），必须分别校验。
// 注意：静态构建会丢弃端点里设的 Content-Type，.xml/.json 靠扩展名定类型，
// 所以这里不断言 Content-Type，只断言内容结构。
{
  const fs = await import('node:fs');
  const distRss = join(ROOT, 'dist', 'rss');
  const tagDir = join(distRss, 'tag');
  const seriesDir = join(distRss, 'series');
  const tagFiles = readdirSync(tagDir).filter((f) => f.endsWith('.xml')).sort();
  const seriesFiles = readdirSync(seriesDir).filter((f) => f.endsWith('.xml')).sort();
  check('T-26 标签子 feed 落盘 12 个', tagFiles.length === 12, `${tagFiles.length} 个`);
  check('T-26 系列子 feed 落盘 1 个', seriesFiles.length === 1, seriesFiles.join(','));

  // 用 dist 里的标签页目录名反查 slug → 该标签的文章页数，作为子 feed 条数的独立口径
  const tagPageCounts = new Map();
  for (const e of readdirSync(join(ROOT, 'dist', 'tags'), { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const idxFile = join(ROOT, 'dist', 'tags', e.name, 'index.html');
    if (!fs.existsSync(idxFile)) continue;
    const html = readFileSync(idxFile, 'utf8');
    // 中文标签的重定向桩不是真实标签页，跳过
    if (/http-equiv=["']refresh["']/i.test(html)) continue;
    tagPageCounts.set(e.name, (html.match(/<li class="post-row">/g) || []).length);
  }

  const mismatched = [];
  for (const file of tagFiles) {
    const slug = file.replace(/\.xml$/, '');
    const xml = readFileSync(join(tagDir, file), 'utf8');
    const n = (xml.match(/<item>/g) || []).length;
    const expected = tagPageCounts.get(slug);
    if (expected !== undefined && n !== expected) mismatched.push(`${slug}: feed=${n} 页面=${expected}`);
  }
  check('T-26 每个标签子 feed 的条数等于该标签的文章数', mismatched.length === 0, mismatched.slice(0, 3).join(' | ') || `${tagFiles.length} 个已核对`);

  // 随笔：子 feed 必须是全部 5 条。
  // T-32 之前这里还断言过「子 feed 覆盖面 > 主 feed 截断面」—— 那时主 feed 只留 30 条，
  // 随笔排在后面的 2 篇进不去。现在主 feed 覆盖全部文章，那条比较失去意义，
  // 改成更直接、也更有价值的守护：**主 feed 里必须能找到全部随笔文章**。
  // 这条能抓住「T-32 又退回去截断条目」的回归，而旧断言抓不到。
  const essays = readFileSync(join(tagDir, 'essays.xml'), 'utf8');
  const essaysN = (essays.match(/<item>/g) || []).length;
  check('T-26 随笔子 feed 含全部 5 篇', essaysN === 5, `${essaysN} 篇`);
  const mainN = (rssText.match(/<item>/g) || []).length;
  const essaysLinks = [...essays.matchAll(/<link>([^<]*\/posts\/[^<]+)<\/link>/g)].map((m) => m[1]);
  const lostInMain = essaysLinks.filter((u) => !rssText.includes(`<link>${u}</link>`));
  check(
    'T-32 主 feed 覆盖全部随笔文章（不再被条数上限砍掉）',
    essaysLinks.length === essaysN && lostInMain.length === 0,
    lostInMain.length ? lostInMain.join(',') : `随笔 ${essaysN} 篇全部在主 feed 中（主 feed ${mainN} 条）`,
  );

  // 每个子 feed 都必须是「可独立订阅」的合法 feed：全文、语言、自引用、带 xmlns
  const badFeed = [];
  for (const file of [...tagFiles, ...seriesFiles]) {
    const dir = tagFiles.includes(file) ? tagDir : seriesDir;
    const xml = readFileSync(join(dir, file), 'utf8');
    const issues = [];
    if (!xml.includes('<content:encoded>')) issues.push('无全文');
    if (!/<language>[^<]+<\/language>/.test(xml)) issues.push('无语言');
    if (!/<atom:link[^>]+rel="self"/.test(xml)) issues.push('无自引用');
    // 声明了 atom: 前缀就必须同时声明 xmlns:atom，否则是非法 XML
    if (xml.includes('atom:link') && !xml.includes('xmlns:atom=')) issues.push('缺 xmlns:atom');
    if (issues.length) badFeed.push(`${file}: ${issues.join('/')}`);
  }
  check('T-26 子 feed 结构完整（全文/语言/自引用/命名空间）', badFeed.length === 0, badFeed.slice(0, 3).join(' | ') || `${tagFiles.length + seriesFiles.length} 个`);

  // 子 feed 的地址不能落到中文重定向桩上 —— 桩是 meta refresh，订阅器拿到的是 HTML 不是 XML
  const stubFeed = [...tagFiles, ...seriesFiles].filter((f) => /[\u4e00-\u9fa5]/.test(f));
  check('T-26 子 feed 文件名只用 slug，不含中文', stubFeed.length === 0, stubFeed.join(',') || '全部为 slug');

  // ---- JSON Feed 1.1 ----
  const jsonFeedPath = join(ROOT, 'dist', 'feed.json');
  check('T-26 JSON Feed 已落盘', fs.existsSync(jsonFeedPath));
  let jsonFeed = null;
  try {
    jsonFeed = JSON.parse(readFileSync(jsonFeedPath, 'utf8'));
  } catch (e) {
    check('T-26 JSON Feed 可被 JSON.parse', false, String(e).slice(0, 120));
  }
  if (jsonFeed) {
    check('T-26 JSON Feed 可被 JSON.parse', true, `${jsonFeed.items?.length ?? 0} 条`);
    check('T-26 JSON Feed 版本号为 1.1', jsonFeed.version === 'https://jsonfeed.org/version/1.1', jsonFeed.version);
    check('T-26 JSON Feed 条数与主 feed 一致', jsonFeed.items?.length === mainN, `${jsonFeed.items?.length} vs ${mainN}`);
    check('T-26 JSON Feed 声明语言且与站点一致', jsonFeed.language === 'zh-CN', jsonFeed.language);
    // RFC3339 必须能被 Date 解析且含 T/Z；toUTCString() 产出的 'GMT' 格式不合规范
    const badDate = (jsonFeed.items ?? []).filter((it) => !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(it.date_published ?? ''));
    check('T-26 JSON Feed 的 date_published 是 RFC3339', badDate.length === 0, badDate.slice(0, 2).map((i) => i.date_published).join(' | ') || `${jsonFeed.items?.length ?? 0} 条合规`);
    // T-32 之后只有最近 FEED_FULLTEXT_LIMIT 篇带全文，其余只有 summary。
    // 断言改为「既有带全文的、也有只有摘要的」，且两者之和等于总条数。
    const itemsWithContent = (jsonFeed.items ?? []).filter((it) => typeof it.content_html === 'string' && it.content_html.length > 100);
    const itemsWithSummaryOnly = (jsonFeed.items ?? []).filter((it) => !it.content_html && typeof it.summary === 'string' && it.summary.length > 0);
    check(
      'T-26 JSON Feed 全文与摘要两档并存',
      itemsWithContent.length === 20 && itemsWithContent.length + itemsWithSummaryOnly.length === (jsonFeed.items ?? []).length,
      `全文 ${itemsWithContent.length} / 摘要 ${itemsWithSummaryOnly.length} / 共 ${jsonFeed.items?.length ?? 0}`,
    );
    // 正文里的站内相对链接必须被绝对化，否则在阅读器里全部断链
    const relLinks = (jsonFeed.items ?? []).flatMap((it) => (it.content_html ?? '').match(/(?:src|href)="\/(?!\/)/g) ?? []);
    check('T-26 JSON Feed 正文链接已绝对化', relLinks.length === 0, relLinks.length + ' 条相对链接');
    // 每条 item 的 id 与 url 必须同值（与 RSS guid 的口径一致）
    const idMismatch = (jsonFeed.items ?? []).filter((it) => it.id !== it.url);
    check('T-26 JSON Feed 的 id 与 url 同值', idMismatch.length === 0, idMismatch.length + ' 条不一致');
  }

  // ---- 订阅页 ----
  const subRes = await fetch(`${BASE}/subscribe/`);
  const subText = await subRes.text();
  check('T-26 订阅页返回 200', subRes.ok);
  check('T-26 订阅页列出全部 12 个标签 feed', (subText.match(/\/rss\/tag\/[a-z-]+\.xml/g) || []).length >= 12, `${(subText.match(/\/rss\/tag\/[a-z-]+\.xml/g) || []).length} 个`);
  check('T-26 订阅页列出系列 feed', /\/rss\/series\/[a-z-]+\.xml/.test(subText));
  check('T-26 订阅页列出 JSON Feed', /href="\/feed\.json"/.test(subText));
  // T-32：订阅页曾写死「全部文章，最近 30 篇带全文」与「不限最近 30 篇」，
  // 那两条文案在解除条目截断后就是错的（读者会以为只有 30 篇能订到）。
  // 现在必须说清「全部 N 篇 + 最近 20 篇带全文」，且 N 与主 feed 条数一致。
  check(
    'T-32 订阅页说明全部篇数与全文篇数',
    new RegExp(`全部 ${mainN} 篇，最近 20 篇带全文`).test(subText),
    (subText.match(/全部[^<]{0,20}篇[^<]{0,20}全文/) || [])[0] ?? '未找到该文案',
  );
  check('T-32 订阅页不再声称「不限最近 30 篇」', !/不限最近 30 篇/.test(subText));
  // 页脚文字链指向订阅页，图标仍是一键订阅（两者分工不同，不能都改也不能都不改）
  const homeHtml = await (await fetch(`${BASE}/`)).text();
  check('T-26 页脚文字链指向订阅页', homeHtml.includes('class="footer-rss-text" href="/subscribe/"'));
  check('T-26 页脚图标仍直指 /rss.xml', /class="icon-link footer-rss-icon" href="\/rss\.xml"/.test(homeHtml));
  // 关于页的订阅段应指向订阅页，而不是只提 RSS
  const aboutHtml = await (await fetch(`${BASE}/about/`)).text();
  check('T-26 关于页的订阅段指向订阅页', /href="\/subscribe\/"/.test(aboutHtml) && aboutHtml.includes('订阅'));

  // 新增订阅页必须被 sitemap 收录（否则全站链接扫描覆盖不到它）；
  // 而 feed 端点不该进 sitemap —— 它不是页面。
  const smRes = await fetch(`${BASE}/sitemap-0.xml`);
  const smText = await smRes.text();
  check('T-26 订阅页被 sitemap 收录', smText.includes('/subscribe/'), `sitemap ${(smText.match(/<loc>/g) || []).length} 条`);
  check('T-26 feed 端点不进 sitemap', !/rss\/tag\/|rss\/series\/|\/feed\.json/.test(smText));
}

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

// ---- T-21 搜索索引体积门禁（2026-10-19）----
// 背景：这条门禁原本只是 src/pages/search.json.ts 里的 console.warn，从不出现在
// check 输出里，等于没人看得见。截断从 2000 字降到 500 字后，把体积变成硬断言。
// 口径统一用 gzip：规划原文「100 篇 < 100 KB」没写口径，raw 口径必须截到 240 字，
// gzip 口径 500 字在 100 篇时约 69 KB 即达标（见 docs/后续功能开发计划.md §1.3）。
{
  const searchBody = await (await fetch(`${BASE}/search.json`)).text();
  const searchBuf = Buffer.from(searchBody, 'utf8');
  check(
    'T-21 搜索索引 raw 体积达标',
    searchBuf.length <= 52 * 1024,
    `${searchBuf.length} B ≤ ${52 * 1024} B（改前 59049，500 字档实测 49905）`,
  );
  check(
    'T-21 搜索索引 gzip 体积达标',
    gzipSync(searchBuf).length <= 24 * 1024,
    `${gzipSync(searchBuf).length} B ≤ ${24 * 1024} B（改前 26546，500 字档实测 22629）`,
  );

  const idx = JSON.parse(searchBody);
  check('T-21 搜索索引条目数不变', idx.length === 32, `${idx.length} 篇`);

  // 截断真的生效了：至少一篇 content 长度恰好等于 500（说明 slice 命中上限）
  const atLimit = idx.filter((p) => p.content.length === 500).length;
  check('T-21 正文截断生效', atLimit > 0, `${atLimit} 篇长度恰好 500（上限为 500）`);

  // 反向守卫：没有任何一篇超过 500，否则说明 CONTENT_LIMIT 被改回去了
  const overLimit = idx.filter((p) => p.content.length > 500).length;
  check('T-21 无正文超上限', overLimit === 0, `${overLimit} 篇超过 500 字`);

  // 短文不该被误伤：hello-world 正文 446 字 < 500，必须原样保留
  const shortPost = idx.find((p) => p.slug === 'hello-world');
  check(
    'T-21 短文不被截断',
    !!shortPost && shortPost.content.length > 400 && shortPost.content.length < 500,
    shortPost ? `hello-world = ${shortPost.content.length} 字` : 'hello-world 缺失',
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

// ---- 归档页 / 系列页 / 修订记录（P1 新增功能）----
// 这三项的共同点：它们都是"新增的**派生视图**"，数据来自 frontmatter 与文章集合。
// 派生视图最典型的退化是**悄悄少一篇或顺序错乱** —— 页面照样打得开、样式也正常，
// 只有把集合逐一对拍才看得见。所以这里全部用对拍，不用"存在性"糊过去。

// ① 归档页：文章集合必须与搜索索引（同一份已发布集合）逐一对拍
{
  const archiveHtml = await (await fetch(BASE + '/archive/')).text();
  check('归档页存在', archiveHtml.length > 0);

  // 归档页自己吐出的 slug 清单，按顺序（年月倒序）排列
  const m = /<script type="application\/json" id="archive-slugs"[^>]*>([\s\S]*?)<\/script>/.exec(archiveHtml);
  let archived = null;
  try {
    archived = m ? JSON.parse(m[1]) : null;
  } catch {
    archived = null;
  }
  check('归档页输出了可解析的文章清单', Array.isArray(archived) && archived.length > 0, (archived ? archived.length : 0) + ' 条');

  if (Array.isArray(archived)) {
    // 与 /search.json 对拍：两份都是"全部已发布文章"，少任何一篇都是缺陷
    const searchIndex = await (await fetch(BASE + '/search.json')).json();
    const a = [...archived].sort();
    const b = searchIndex.map((p) => p.slug).sort();
    const missing = b.filter((s) => !a.includes(s));
    const extra = a.filter((s) => !b.includes(s));
    check(
      '归档页文章集合与搜索索引一致',
      missing.length === 0 && extra.length === 0,
      '归档=' + a.length + ' 索引=' + b.length + ' 缺=' + (missing.slice(0, 3).join(',') || '无') + ' 多=' + (extra.slice(0, 3).join(',') || '无'),
    );

    // 列表行数必须与清单长度一致 —— 分组逻辑（年/月）写错会丢行但不改清单
    const rows = (archiveHtml.match(/<li class="post-row[ "]/g) || []).length;
    check('归档页列表行数与清单一致', rows === archived.length, '行=' + rows + ' 清单=' + archived.length);

    // 年份锚点：每个 section 的 id 都要有对应的跳转链接，否则点了不动
    const ids = [...archiveHtml.matchAll(/id="year-(\d{4})"/g)].map((x) => x[1]);
    const links = [...archiveHtml.matchAll(/href="#year-(\d{4})"/g)].map((x) => x[1]);
    check(
      '归档页每个年份锚点都有跳转链接',
      ids.length > 0 && ids.length === links.length && ids.every((y) => links.includes(y)),
      '锚点=' + ids.join(',') + ' 链接=' + links.join(','),
    );
    // 月份分组标题数必须 > 0，否则分组循环整个空转（列表会变一条长龙）
    const months = (archiveHtml.match(/class="month-label"/g) || []).length;
    check('归档页按月分组', months > 0, months + ' 个月');
  }
}

// ② 系列页：顺序、条数、结构化数据三者必须同源
{
  const seriesHtml = await (await fetch(BASE + '/series/astro-blog/')).text();
  check('系列页存在', seriesHtml.length > 0);

  const rows = (seriesHtml.match(/<li class="post-row[ "]/g) || []).length;
  check('系列页列出文章', rows > 0, rows + ' 篇');

  // 列表左侧的 time 显示的是**阅读序号**（01/02/…），不是日期。
  // 这是系列页与其它列表页唯一的结构差异 —— 若哪天有人"顺手"改成日期，
  // 系列顺序这一核心语义就静默丢了，必须断言。
  const ordinals = [...seriesHtml.matchAll(/<time[^>]*>(\d{2})<\/time>/g)].map((x) => x[1]);
  check(
    '系列页用两位阅读序号而非日期',
    ordinals.length === rows && ordinals.every((v, i) => v === String(i + 1).padStart(2, '0')),
    ordinals.join(','),
  );

  const blocks = [...seriesHtml.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
  let parsed = null;
  try {
    parsed = blocks.map((x) => JSON.parse(x));
  } catch {
    parsed = null;
  }
  check('系列页含可解析的 JSON-LD', parsed !== null && parsed.length > 0, blocks.length + ' 块');
  if (parsed) {
    const flat = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      flat.push(n);
      Object.values(n).forEach(walk);
    };
    parsed.forEach(walk);
    const cp = flat.find((n) => n['@type'] === 'CollectionPage');
    check('系列页含 CollectionPage', !!cp);
    // 与页面行数对拍 —— 声明了页面上没有的文章就是欺骗爬虫
    check(
      '系列页 JSON-LD 条数与页面一致',
      cp && cp.mainEntity && cp.mainEntity.numberOfItems === rows,
      'ld=' + ((cp && cp.mainEntity && cp.mainEntity.numberOfItems) ?? -1) + ' dom=' + rows,
    );
    const bc = flat.find((n) => n['@type'] === 'BreadcrumbList');
    const names = bc ? bc.itemListElement.map((x) => x.name) : [];
    check(
      '系列页面包屑为 首页 > 系列名',
      !!bc && names[0] === '首页' && !!names[1],
      bc ? names.join(' > ') : '(none)',
    );
  }
}

// ③ 文章页的系列上下文：系列条 + 系列内前后篇 + BlogPosting.isPartOf
//    边界是关键：系列第一篇不能有"系列上一篇"，最后一篇不能有"系列下一篇" ——
//    若边界判断写反（用全站 newer/older 代替系列前后篇），链接会指向系列外的文章，
//    读者点"系列下一篇"跳到无关内容，而页面看起来完全正常。
{
  const first = await (await fetch(BASE + '/posts/blog-build-notes/')).text(); // 系列第 1 篇
  const last = await (await fetch(BASE + '/posts/head-meta/')).text(); // 系列第 7 篇

  check('系列文章页渲染系列条', /class="post-series"/.test(first));
  // 系列条要写明"第 N 篇 / 共 M 篇"，只写系列名等于没给定位
  const bar = (/<p class="post-series">[\s\S]{0,200}?<\/p>/.exec(first) || ['(none)'])[0].replace(/\s+/g, ' ');
  check(
    '系列条标明序号与总数',
    /本系列共\s*\d+\s*篇/.test(first) && /第\s*\d+\s*篇/.test(first),
    bar.slice(0, 160),
  );

  const firstNav = (/<nav class="post-series-nav"[\s\S]*?<\/nav>/.exec(first) || [''])[0];
  const lastNav = (/<nav class="post-series-nav"[\s\S]*?<\/nav>/.exec(last) || [''])[0];
  check('系列文章页有系列内导航', firstNav.length > 0 && lastNav.length > 0);
  check('系列第一篇无"系列上一篇"', firstNav.length > 0 && !/系列上一篇/.test(firstNav));
  check('系列第一篇有"系列下一篇"', /系列下一篇/.test(firstNav));
  check('系列最后一篇无"系列下一篇"', lastNav.length > 0 && !/系列下一篇/.test(lastNav));
  check('系列最后一篇有"系列上一篇"', /系列上一篇/.test(lastNav));

  // 结构化数据：BlogPosting 必须声明所属系列，否则富结果不知道这是一套内容
  const m = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/.exec(first);
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
      const bp = flat.find((n) => n['@type'] === 'BlogPosting');
      const partOf = bp ? bp.isPartOf : null;
      check(
        '系列文章 BlogPosting.isPartOf 指向 CreativeWorkSeries',
        !!partOf && partOf['@type'] === 'CreativeWorkSeries' && /\/series\//.test(partOf.url || ''),
        JSON.stringify(partOf),
      );
      const bc = flat.find((n) => n['@type'] === 'BreadcrumbList');
      const names = bc ? bc.itemListElement.map((x) => x.name) : [];
      check(
        '系列文章面包屑含系列级',
        names[0] === '首页' && names.some((n) => /Astro 博客实践/.test(n)),
        names.join(' > '),
      );
    } catch {}
  }
}

// ④ 修订记录：只在 frontmatter 真有 updated 时才出现，且首发日期必须始终在
{
  const html = await (await fetch(BASE + '/posts/hello-world/')).text();
  check('文章页渲染修订记录', /class="post-revision"/.test(html));
  const seg = (/<p class="post-revision">[\s\S]*?<\/p>/.exec(html) || [''])[0];
  check(
    '修订记录含首发日期',
    /首次发布/.test(seg) && /<time datetime="\d{4}-\d{2}-\d{2}/.test(seg),
    seg.replace(/\s+/g, ' ').slice(0, 160),
  );
}


// ---- T-41 专题页：人工编排的阅读线（2026-10-22）----
// 专题与标签、系列的根本差别：成员不由文章自己声明，只存在于 src/data/topics.ts。
// 所以最容易静默出错的是「数据改了、页面没跟上」—— 顺序、条数、结构化数据、
// sitemap 新鲜度这几处必须同源。这里全部用**独立口径**对拍：直接读 topics.ts 与
// frontmatter，不 import src/utils/topics.ts，源码写错时测试不跟着一起错。
{
  const topicsSrc = readFileSync(join(ROOT, 'src/data/topics.ts'), 'utf8');
  const topics = [];
  for (const m of topicsSrc.matchAll(/slug:\s*'([^']+)'[\s\S]*?posts:\s*\[([\s\S]*?)\]/g)) {
    const posts = m[2]
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    topics.push({ slug: m[1], posts });
  }
  check('T-41 topics.ts 能解析出专题', topics.length >= 2, topics.map((t) => t.slug).join(','));

  // 已发布文章集合（独立口径：frontmatter + 北京日历日 + lastModified 归约）
  const postsDir = join(ROOT, 'src/content/posts');
  const bjDay = (v) => new Date(new Date(v).getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  const today = bjDay(new Date());
  const published = new Map(); // id -> { modified, tags }
  for (const f of readdirSync(postsDir)) {
    if (!f.endsWith('.md')) continue;
    const src = readFileSync(join(postsDir, f), 'utf8');
    const get = (k) =>
      ((new RegExp('^' + k + '\\s*:\\s*["\']?([^"\'\\n]+)', 'm').exec(src) || [])[1] || '').trim();
    const date = get('date');
    if (!date || get('draft').toLowerCase() === 'true' || bjDay(date) > today) continue;
    const updated = get('updated');
    const tags = ((/^tags:\s*\[([^\]]*)\]/m.exec(src) || [])[1] || '')
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    published.set(f.replace(/\.md$/, ''), {
      modified: updated && updated > date ? updated : date,
      tags,
    });
  }

  // ① 数据健康：缺 id、重复、太薄三种都要先在这里挡住。
  //    这些错不会让构建失败——页面照常渲染，只是少一篇或顺序对不上，
  //    读者完全看不出来，只有回归断言能卡住。
  const issues = [];
  for (const t of topics) {
    const seen = new Set();
    for (const id of t.posts) {
      if (seen.has(id)) issues.push(t.slug + ' 重复：' + id);
      seen.add(id);
      if (!published.has(id)) issues.push(t.slug + ' 缺失：' + id);
    }
    const tagSet = new Set();
    for (const id of t.posts) for (const tag of published.get(id)?.tags || []) tagSet.add(tag);
    const live = [...seen].filter((id) => published.has(id)).length;
    if (tagSet.size < 3 && live < 6) issues.push(t.slug + ' 太薄：' + tagSet.size + ' 个标签 / ' + live + ' 篇');
  }
  check(
    'T-41 专题数据无缺篇/重复/太薄',
    issues.length === 0,
    issues.slice(0, 3).join(' | ') || topics.length + ' 个专题',
  );

  // ② 专题总览页：行数 = 专题数，每行指向的 slug 必须真实存在
  const idxHtml = await (await fetch(BASE + '/topics/')).text();
  const idxRows = (idxHtml.match(/<li class="post-row[ "]/g) || []).length;
  const idxHrefs = [...idxHtml.matchAll(/<li class="post-row[ "][\s\S]*?<a href="([^"]+)"/g)].map((x) => x[1]);
  check('T-41 专题总览页列出全部专题', idxRows === topics.length, '行=' + idxRows + ' 数据=' + topics.length);
  check(
    'T-41 专题总览页链接与数据一致',
    idxHrefs.length === topics.length && topics.every((t) => idxHrefs.includes('/topics/' + t.slug + '/')),
    idxHrefs.join(','),
  );
  const idxLd = [...idxHtml.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
  let idxParsed = null;
  try {
    idxParsed = idxLd.map((x) => JSON.parse(x));
  } catch {
    idxParsed = null;
  }
  check('T-41 专题总览页含可解析的 JSON-LD', idxParsed !== null && idxParsed.length > 0, idxLd.length + ' 块');
  if (idxParsed) {
    const flat = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      flat.push(n);
      Object.values(n).forEach(walk);
    };
    idxParsed.forEach(walk);
    const cp = flat.find((n) => n['@type'] === 'CollectionPage');
    const cpItems = cp && cp.mainEntity && cp.mainEntity.numberOfItems;
    check('T-41 专题总览页含 CollectionPage', !!cp);
    check(
      'T-41 专题总览页 JSON-LD 条数与页面一致',
      cpItems === idxRows,
      'ld=' + (cpItems ?? -1) + ' dom=' + idxRows,
    );
    const bc = flat.find((n) => n['@type'] === 'BreadcrumbList');
    const names = bc ? bc.itemListElement.map((x) => x.name) : [];
    check('T-41 专题总览页面包屑为 首页 > 全部专题', names[0] === '首页' && names[1] === '全部专题', names.join(' > '));
  }

  // ③ 每个专题详情页：条数、阅读序号、链接顺序、结构化数据四者同源。
  //    顺序是专题唯一不可让渡的语义——按日期重排一次就退化成标签页了。
  const detailBad = [];
  for (const t of topics) {
    const expectedOrder = t.posts.filter((id) => published.has(id));
    const html = await (await fetch(BASE + '/topics/' + t.slug + '/')).text();
    const rows = (html.match(/<li class="post-row[ "]/g) || []).length;
    if (rows !== expectedOrder.length) {
      detailBad.push(t.slug + ' 行数 ' + rows + '≠' + expectedOrder.length);
      continue;
    }
    const ordinals = [...html.matchAll(/<span class="post-index"[^>]*>(\d{2})<\/span>/g)].map((x) => x[1]);
    if (ordinals.length !== rows || !ordinals.every((v, i) => v === String(i + 1).padStart(2, '0'))) {
      detailBad.push(t.slug + ' 序号 ' + ordinals.join(','));
    }
    const hrefs = [...html.matchAll(/<li class="post-row[ "][\s\S]*?<a href="([^"]+)"/g)].map((x) => x[1]);
    if (hrefs.join(',') !== expectedOrder.map((id) => '/posts/' + id + '/').join(',')) {
      detailBad.push(t.slug + ' 顺序 ' + hrefs.join(','));
    }
    const blocks = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
    let parsed = null;
    try {
      parsed = blocks.map((x) => JSON.parse(x));
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.length === 0) {
      detailBad.push(t.slug + ' 无 JSON-LD');
      continue;
    }
    const flat = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      flat.push(n);
      Object.values(n).forEach(walk);
    };
    parsed.forEach(walk);
    const cp = flat.find((n) => n['@type'] === 'CollectionPage');
    const cpItems = cp && cp.mainEntity && cp.mainEntity.numberOfItems;
    if (cpItems !== rows) detailBad.push(t.slug + ' ld 条数 ' + (cpItems ?? -1) + '≠' + rows);
    const bc = flat.find((n) => n['@type'] === 'BreadcrumbList');
    const names = bc ? bc.itemListElement.map((x) => x.name) : [];
    if (names.length !== 3 || names[0] !== '首页' || names[1] !== '专题' || !names[2]) {
      detailBad.push(t.slug + ' 面包屑 ' + names.join(' > '));
    }
  }
  check(
    'T-41 专题详情页：条数/序号/顺序/结构化数据同源',
    detailBad.length === 0,
    detailBad.slice(0, 3).join(' | ') || topics.length + ' 个专题',
  );

  // ④ sitemap：详情页的 lastmod 必须取「专题内最新一篇」，不能取全站最新——
  //    后者会让每个专题看起来天天在更新，等于没给新鲜度信号。
  const smText = await (await fetch(BASE + '/sitemap-0.xml')).text();
  const lmOf = (path) => {
    const m = new RegExp(path + '</loc><lastmod>([^<]+)</lastmod>').exec(smText);
    return m ? m[1] : '';
  };
  const newerOf = (ids) =>
    ids
      .filter((id) => published.has(id))
      .reduce((acc, id) => (published.get(id).modified > acc ? published.get(id).modified : acc), '');
  const smBad = [];
  for (const t of topics) {
    const want = newerOf(t.posts);
    const got = lmOf('/topics/' + t.slug + '/').slice(0, 10);
    if (got !== want) smBad.push(t.slug + ' ' + got + '≠' + want);
  }
  check(
    'T-41 sitemap 每个专题页 lastmod 取专题内最新',
    smBad.length === 0,
    smBad.slice(0, 3).join(' | ') || topics.length + ' 个专题',
  );
  const allNewest = [...published.values()].reduce((acc, v) => (v.modified > acc ? v.modified : acc), '');
  check(
    'T-41 sitemap 专题总览页 lastmod 取全站最新',
    lmOf('/topics/').slice(0, 10) === allNewest,
    lmOf('/topics/').slice(0, 10) + ' vs ' + allNewest,
  );

  // ⑤ 入口：首页、关于页、命令面板三处都要通得进去。
  //    专题只存在于数据文件里，没有入口就等于不存在，而页面本身看不出来。
  const homeHtml = await (await fetch(BASE + '/')).text();
  const homeTrail = (/<nav class="home-block home-trails"[\s\S]*?<\/nav>/.exec(homeHtml) || [''])[0];
  const homeLinks = [...homeTrail.matchAll(/href="(\/topics\/[^"]*)"/g)].map((x) => x[1]);
  check(
    'T-41 首页有专题入口且条数与数据一致',
    homeLinks.filter((h) => h !== '/topics/').length === topics.length,
    homeLinks.join(','),
  );
  const aboutHtml = await (await fetch(BASE + '/about/')).text();
  check('T-41 关于页链到专题总览', /href="\/topics\/"/.test(aboutHtml));
  const navData = await (await fetch(BASE + '/nav.json')).json();
  const navTopics = navData.topics;
  check(
    'T-41 命令面板专题组与数据一致',
    Array.isArray(navTopics) &&
      navTopics.length === topics.length &&
      topics.every((t) => navTopics.some((x) => x.href === '/topics/' + t.slug + '/')),
    'nav=' + (Array.isArray(navTopics) ? navTopics.length : '缺失') + ' 数据=' + topics.length,
  );
}

// ---- T-29 启用 updated：修订时间要贯穿四个出口（2026-10-19）----
// 背景：updated 字段一直存在、PostLayout 也一直在渲染，但全站 0 篇使用，
// 所以「有 updated 时会发生什么」这条路径从来没有被走过（④ 修订记录只测了
// 无 updated 的 hello-world）。这里按「一处数据，四个出口」补齐：
//   frontmatter → 文章页「更新于」/ 页脚「最后修订」/ JSON-LD dateModified /
//   sitemap lastmod / RSS lastBuildDate
// 口径：不硬编码篇数与日期，而是「找出真的设了 updated 的文章，再逐项对拍」，
// 这样将来增删文章不需要改断言。
{
  const postsDir = join(ROOT, 'src/content/posts');
  const revised = []; // { slug, date, updated }
  let latest = ''; // 全站最新 lastModified —— 含未修订文章，它们取 date
  for (const f of readdirSync(postsDir)) {
    if (!f.endsWith('.md')) continue;
    const src = readFileSync(join(postsDir, f), 'utf8');
    const get = (k) => (new RegExp('^' + k + '\\s*:\\s*["\']?([^"\'\\n]+)', 'm').exec(src) || [])[1];
    const date = (get('date') || '').trim();
    const updated = (get('updated') || '').trim();
    // 与 src/utils/posts.ts 的 lastModified() 同口径：updated 严格更新才生效
    const modified = updated && updated > date ? updated : date;
    if (modified > latest) latest = modified;
    // 只把「真的修订过」的文章放进 revised，供逐项对拍
    if (!date || !updated || !(updated > date)) continue;
    revised.push({ slug: f.replace(/\.md$/, ''), date, updated });
  }

  check('T-29 有文章启用了 updated', revised.length >= 3, `${revised.length} 篇：${revised.map((r) => r.slug).join(', ')}`);

  // ① 文章页：「更新于」只在修订后出现，且带修订日期
  const metaBad = [];
  for (const r of revised) {
    const html = await (await fetch(`${BASE}/posts/${r.slug}/`)).text();
    const meta = (/<p class="post-meta">[\s\S]*?<\/p>/.exec(html) || [''])[0];
    const want = `更新于 <time datetime="${r.updated}T00:00:00.000Z"`;
    if (!meta.includes(want)) metaBad.push(`${r.slug} 缺「${want}」`);
  }
  check('T-29 修订过的文章页显示更新于', metaBad.length === 0, metaBad.slice(0, 3).join(' | ') || `${revised.length} 篇已核对`);

  // ② 页脚修订记录：首发 + 最后修订两段都在，且最后修订值等于 updated
  const revBad = [];
  for (const r of revised) {
    const html = await (await fetch(`${BASE}/posts/${r.slug}/`)).text();
    const seg = (/<p class="post-revision">[\s\S]*?<\/p>/.exec(html) || [''])[0];
    if (!seg.includes('首次发布') || !seg.includes('最后修订')) revBad.push(`${r.slug} 缺段`);
    else if (!seg.includes(`最后修订<time datetime="${r.updated}T00:00:00.000Z"`)) revBad.push(`${r.slug} 最后修订日期不对`);
  }
  check('T-29 页脚修订记录含首次发布与最后修订', revBad.length === 0, revBad.slice(0, 3).join(' | ') || `${revised.length} 篇已核对`);

  // ③ 未修订的文章不得凭空多出「更新于」——防「用 date 兜底 updated」这种假实现
  const never = (await (async () => {
    const all = readdirSync(postsDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
    return all.filter((s) => !revised.some((r) => r.slug === s));
  })());
  const probe = 'hello-world';
  if (never.includes(probe)) {
    const html = await (await fetch(`${BASE}/posts/${probe}/`)).text();
    const meta = (/<p class="post-meta">[\s\S]*?<\/p>/.exec(html) || [''])[0];
    check('T-29 未修订的文章不显示更新于', !meta.includes('更新于'), probe);
  }

  // ④ JSON-LD dateModified 必须等于 updated（不是 date）
  const ldBound = [];
  for (const r of revised) {
    const html = await (await fetch(`${BASE}/posts/${r.slug}/`)).text();
    const ld = (/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/.exec(html) || ['', ''])[1];
    let ok = false;
    try {
      const nodes = [];
      const walk = (x) => {
        if (!x || typeof x !== 'object') return;
        if (Array.isArray(x)) return x.forEach(walk);
        nodes.push(x);
        Object.values(x).forEach(walk);
      };
      walk(JSON.parse(ld));
      const post = nodes.find((n) => n.dateModified && n.datePublished);
      ok = !!post && post.dateModified === `${r.updated}T00:00:00.000Z` && post.datePublished === `${r.date}T00:00:00.000Z`;
      if (!ok) ldBound.push(`${r.slug} dateModified=${post?.dateModified}`);
    } catch {
      ldBound.push(`${r.slug} JSON-LD 解析失败`);
    }
  }
  check('T-29 JSON-LD dateModified 跟随 updated', ldBound.length === 0, ldBound.slice(0, 3).join(' | ') || `${revised.length} 篇已核对`);

  // ⑤ sitemap lastmod 与 ⑥ RSS lastBuildDate：两者都取「全站最新修订时间」
  //    sitemap 走 astro.config.mjs 的 readPosts()（pick('updated') || pick('date')），
  //    RSS 走 src/utils/feed.ts 的 feedLastBuildDate()，两条独立链路都要对拍。
  const smUrl = await (await fetch(`${BASE}/sitemap-index.xml`)).text();
  // 注意：sitemap-index.xml 里的 <loc> 是线上绝对地址，不能直接 fetch ——
  // 静态检查必须打在本地 preview 上（也顺带避免本地证书链不认导致 TLS 失败）。
  const smLoc = (/<loc>([^<]+)<\/loc>/.exec(smUrl) || [])[1];
  const smPath = smLoc ? new URL(smLoc).pathname : '';
  const smText2 = smPath ? await (await fetch(BASE + smPath)).text() : '';
  const smMiss = [];
  for (const r of revised) {
    const entry = new RegExp(`/posts/${r.slug}/</loc><lastmod>([^<]+)</lastmod>`).exec(smText2);
    if (!entry) smMiss.push(`${r.slug} 无 lastmod`);
    else if (entry[1] !== `${r.updated}T00:00:00.000Z`) smMiss.push(`${r.slug} lastmod=${entry[1]}`);
  }
  check('T-29 sitemap lastmod 跟随 updated', smMiss.length === 0, smMiss.slice(0, 3).join(' | ') || `${revised.length} 篇已核对`);

  // ---- T-31 sitemap 里没有「无 lastmod」的页面（2026-10-20）----
  // 改动前恰好有 2 条：/about/ 与 /subscribe/ —— serialize() 没有分支接住它们。
  // 健康的 sitemap 不该有半套新鲜度信号：要么全给，要么就别声称自己给了。
  // 这里断言「0 条缺 lastmod」，而不是逐个硬编码页面名，因为将来新增页面时
  // 漏接分支同样会红，这正是我们要的。
  const smEntryNoLm = [];
  for (const m of smText2.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = (/<loc>([^<]+)<\/loc>/.exec(m[1]) || [])[1] || '?';
    if (!/<lastmod>/.test(m[1])) smEntryNoLm.push(new URL(loc).pathname);
  }
  check(
    'T-31 sitemap 每个 <url> 都带 lastmod',
    smEntryNoLm.length === 0,
    smEntryNoLm.length ? smEntryNoLm.join(',') : `${(smText2.match(/<url>/g) || []).length} 条全部带 lastmod`,
  );
  // lastmod 必须是能被 Date 解析的 ISO 时间，而不是随手写的字符串
  const badLm = [];
  for (const m of smText2.matchAll(/<loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod>/g)) {
    if (Number.isNaN(Date.parse(m[2]))) badLm.push(new URL(m[1]).pathname + '=' + m[2]);
  }
  check('T-31 sitemap 的 lastmod 是可解析的 ISO 时间', badLm.length === 0, badLm.slice(0, 3).join(' | ') || '全部可解析');
  // 曾经落空的两个页面必须真有 lastmod，且 /subscribe/ 取全站最新
  // （它列出的是随文章增删变化的 feed 清单，属于「派生自文章」的页面）。
  for (const path of ['/about/', '/subscribe/']) {
    check(`T-31 ${path} 在 sitemap 里有 lastmod`, new RegExp(`${path}</loc><lastmod>[^<]+</lastmod>`).test(smText2));
  }

  // lastBuildDate 取的是「全站最新 lastModified」（feedLastBuildDate 由 lastModified 归约而来），
  // 而不是「最新 updated」——未修订文章的 date 也参与比较，这里必须同口径，否则会算出
  // 2026-10-08（最新一篇的 date）与 2026-09-30（最新修订）这种假红。
  const lbd = (/<lastBuildDate>([^<]+)<\/lastBuildDate>/.exec(rssText) || [])[1];
  const lbdIso = lbd ? new Date(lbd).toISOString().slice(0, 10) : '';
  check('T-29 RSS lastBuildDate 取自最新修订时间', !!latest && lbdIso === latest, `${lbdIso} vs ${latest}`);

  // ⑦ 子 feed 的 lastBuildDate 同样走 feedLastBuildDate()（lastModified 口径）。
  //    主 feed 那条只证明「最大值对得上」，证明不了「updated 参与比较」——
  //    因为全站最新的那篇恰好没有 updated。要证明 updated 真的进了归约，
  //    必须找一个「该标签最新一篇有 updated、且它的 date 比别的篇晚」的标签：
  //    只有这种标签的 max(date) 与 max(modified) 不相等，两种口径才会分出胜负。
  //    这里动态算出「可判别」的标签，不硬编码是哪一个。
  const tagMetaSrc = readFileSync(join(ROOT, 'src/data/tags.ts'), 'utf8');
  const nameToSlug = new Map();
  for (const m of tagMetaSrc.matchAll(/\{\s*name:\s*'([^']+)'\s*,\s*slug:\s*'([^']+)'/g)) nameToSlug.set(m[1], m[2]);
  const perTag = new Map(); // slug -> { date, modified } 最大值
  for (const f of readdirSync(postsDir)) {
    if (!f.endsWith('.md')) continue;
    const src = readFileSync(join(postsDir, f), 'utf8');
    const get = (k) => (new RegExp('^' + k + '\\s*:\\s*["\']?([^"\'\\n]+)', 'm').exec(src) || [])[1];
    const date = (get('date') || '').trim();
    const updated = (get('updated') || '').trim();
    const modified = updated && updated > date ? updated : date;
    const arr = (/^tags:\s*\[([^\]]*)\]/m.exec(src) || [])[1] || '';
    for (const raw of arr.split(',')) {
      const name = raw.trim().replace(/^["']|["']$/g, '');
      const slug = nameToSlug.get(name);
      if (!slug) continue;
      const cur = perTag.get(slug) || { date: '', modified: '' };
      if (date > cur.date) cur.date = date;
      if (modified > cur.modified) cur.modified = modified;
      perTag.set(slug, cur);
    }
  }
  const discriminating = [...perTag.entries()].filter(([, v]) => v.modified > v.date);
  const subBad = [];
  for (const [slug, v] of discriminating) {
    const xml = await (await fetch(`${BASE}/rss/tag/${slug}.xml`)).text();
    const got = (/<lastBuildDate>([^<]+)<\/lastBuildDate>/.exec(xml) || [])[1];
    const gotIso = got ? new Date(got).toISOString().slice(0, 10) : '';
    if (gotIso !== v.modified) subBad.push(`${slug} ${gotIso}≠${v.modified}（date 口径会是 ${v.date}）`);
  }
  check(
    'T-29 子 feed lastBuildDate 也跟随 updated',
    discriminating.length > 0 && subBad.length === 0,
    subBad.slice(0, 3).join(' | ') || `${discriminating.length} 个可判别标签：${discriminating.map(([s]) => s).join(', ')}`,
  );
}


// ---- T-34 北京时间放行 + sitemap 只统计已发布文章（2026-10-20）----
// 两条断言都用**独立口径**：直接读 frontmatter，按固定 UTC+8 换算北京日历日，
// 不 import src/utils/release.ts，也不复用 astro.config.mjs 的过滤逻辑。
// 这样源码里的实现写错时，测试不会跟着一起错。
{
  const postsDir = join(ROOT, 'src/content/posts');
  const beijingDay = (value) => {
    const d = value instanceof Date ? value : new Date(value);
    return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  };
  const today = beijingDay(new Date());
  const get = (src, key) =>
    (new RegExp('^' + key + '\\s*:\\s*["\']?([^"\'\\n]+)', 'm').exec(src) || [])[1]?.trim() || '';

  const expected = [];
  const excluded = [];
  for (const f of readdirSync(postsDir)) {
    if (!f.endsWith('.md')) continue;
    const src = readFileSync(join(postsDir, f), 'utf8');
    const slug = f.replace(/\.md$/, '');
    const date = get(src, 'date');
    if (!date) continue;
    const draft = get(src, 'draft').toLowerCase() === 'true';
    // 日期写的是未来（北京日历日）或草稿 → 不应进 sitemap
    if (draft || beijingDay(date) > today) {
      excluded.push(slug);
      continue;
    }
    expected.push(`/posts/${slug}/`);
  }

  const smText = await (await fetch(`${BASE}/sitemap-0.xml`)).text();
  const actual = [...smText.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => new URL(m[1]).pathname)
    .filter((p) => /^\/posts\/[^/]+\/$/.test(p));
  const missing = expected.filter((p) => !actual.includes(p));
  const extra = actual.filter((p) => !expected.includes(p));
  check(
    'T-34 sitemap 文章集合只含已发布文章',
    expected.length > 0 && missing.length === 0 && extra.length === 0,
    `期望 ${expected.length} / 实际 ${actual.length}；缺=${missing.slice(0, 3).join(',') || '无'} 多=${extra.slice(0, 3).join(',') || '无'}；排除=${excluded.length}`,
  );

  const futureLm = [];
  for (const m of smText.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = (/<loc>([^<]+)<\/loc>/.exec(m[1]) || [])[1];
    const lastmod = (/<lastmod>([^<]+)<\/lastmod>/.exec(m[1]) || [])[1];
    if (!loc || !lastmod) continue;
    if (beijingDay(lastmod) > today) futureLm.push(`${new URL(loc).pathname}=${lastmod}`);
  }
  check(
    'T-34 sitemap 不出现未来 lastmod',
    futureLm.length === 0,
    futureLm.slice(0, 3).join(' | ') || `全部 ≤ 北京今天 ${today}`,
  );
}


// ---- T-35 每日定时 CI：未来日期文章真的能到点上线（2026-10-20）----
// 只检查触发点存在还不够：cron 是 UTC，写成 '10 8 * * *' 依然是合法 cron，
// 却会在北京时间 16:10 跑。这里把它换算成北京小时，拒绝「看起来有 schedule」的假修复。
{
  const ciSrc = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const cron = (/schedule:\s*\n\s*-\s*cron:\s*['"]([^'"]+)['"]/.exec(ciSrc) || [])[1] || '';
  check('T-35 CI 配置了每日定时触发', cron.length > 0, cron || '未找到 schedule.cron');

  const fields = cron.trim().split(/\s+/);
  let beijing = '';
  if (fields.length === 5) {
    const minute = Number(fields[0]);
    const hour = Number(fields[1]);
    if (Number.isInteger(minute) && Number.isInteger(hour)) {
      beijing = `${String((hour + 8) % 24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }
  check(
    'T-35 定时 CI 在 Asia/Shanghai 00:10 运行',
    beijing === '00:10',
    cron ? `cron=${cron} → 北京 ${beijing || '无法解析'}` : '无 cron',
  );
}


// ---- T-43 Node 版本三处对齐：package.json engines ↔ ci.yml ↔ deploy.yml（2026-10-20）----
// `npm run test:unit` 用的是 node --experimental-strip-types，该旗标 22.6.0 才加入。
// 只改 package.json 的 engines 不改 CI 的 node-version，就会变成「声明了要求但门禁跑在
// 更低版本上」——本机能跑、CI 报 unknown flag。这条断言把三处拉到一起对拍：
// 版本号写成 '22.6' / '22.6.0' / 22（数字）都能解析，但下限必须 >= engines 的下限。
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const engines = String(pkg.engines?.node ?? '');
  const enginesMin = (/\d+(?:\.\d+){0,2}/.exec(engines) || [])[0] || '';
  const toTriple = (v) => {
    const parts = String(v).replace(/^v/, '').split('.');
    while (parts.length < 3) parts.push('0');
    return parts.slice(0, 3).map((n) => Number(n) || 0);
  };
  // setup-node 的 node-version 有两种写法，语义不同，不能同一种比较：
  //   '22'    → 取 22 系列最新版（当前远高于 22.6.0），只要 major 相同就不会低于下限；
  //   '22.6'  → 钉死 22.6.x，必须逐段比较，低于 engines 下限要报红。
  // 所以先看写了几段：一段只比 major，两段及以上逐段比。
  const compare = (raw, floor) => {
    const a = String(raw).replace(/^v/, '').split('.').filter((s) => s !== '');
    const b = toTriple(floor);
    const x = toTriple(raw);
    if (a.length < 2) return { ok: x[0] === b[0] || x[0] > b[0], pinned: false };
    for (let i = 0; i < 3; i += 1) {
      if (x[i] !== b[i]) return { ok: x[i] > b[i], pinned: true };
    }
    return { ok: true, pinned: true };
  };
  check(
    'T-43 package.json engines.node 声明了下限',
    enginesMin.length > 0,
    engines || '未找到 engines.node',
  );

  for (const file of ['ci.yml', 'deploy.yml']) {
    const src = readFileSync(join(ROOT, '.github/workflows', file), 'utf8');
    const raw = (/node-version:\s*['"]?([0-9][0-9.]*)['"]?/.exec(src) || [])[1] || '';
    const res = raw && enginesMin ? compare(raw, enginesMin) : { ok: false, pinned: false };
    check(
      `T-43 ${file} 的 node-version 不低于 engines 下限`,
      res.ok,
      `${file} node-version=${raw || '未找到'}（${res.pinned ? '钉死小版本' : '取该 major 最新'}）vs engines >= ${enginesMin}`,
    );
  }
}


// ---- T-36 命令面板的 RSS 提示必须与真实订阅源对拍（2026-10-20）----
// 这条提示以前硬编码「全文 RSS，最近 30 篇」，而 feed 早已改成
// 「全量条目 + 最近 20 篇全文」。两边各自写死就一定会再次漂移，
// 所以期望值不取常量，而是数 /rss.xml 里真实的 <item> 与 <content:encoded>。
{
  const nav = await (await fetch(`${BASE}/nav.json`)).json();
  const rssTarget = nav.pages?.find((page) => page.label === 'RSS 源');
  const itemN = (rssText.match(/<item>/g) || []).length;
  const fullN = (rssText.match(/<content:encoded>/g) || []).length;
  const expectedHint = `全部 ${itemN} 篇，最近 ${fullN} 篇全文`;
  check(
    'T-36 命令面板 RSS 提示与真实订阅源一致',
    itemN > 0 && rssTarget?.hint === expectedHint,
    rssTarget ? `hint="${rssTarget.hint}" / 期望 "${expectedHint}"` : 'nav.json 中没有 RSS 源条目',
  );
}


// ---- 内容侧工程化（P1-4）：OG 图覆盖 / 图片管线 / 阅读时长 ----
// 这三项的共同点：缺失时页面照样正常，只是"悄悄变差"。
//  - 漏跑 npm run og：ogImagePath() 会回退到全站默认图，分享卡片退化但页面不报错；
//  - 有人往 public/ 塞图片：绕过 Astro 优化管线，原图直出、无 srcset、体积翻倍；
//  - 命中数/时长的统计口径写错：数字看着像真的，但没人对拍就发现不了。
// 所以全部用"与真实数据源对拍"，不用存在性判断。

// ① OG 图覆盖：og-manifest.ts 的 slug 集合必须与文章集合完全一致
{
  const manifestSrc = readFileSync(join(ROOT, 'src/data/og-manifest.ts'), 'utf8');
  const slugs = [...manifestSrc.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
  const searchIndex = await (await fetch(BASE + '/search.json')).json();
  const postSlugs = searchIndex.map((p) => p.slug).sort();
  const manifest = [...slugs].sort();
  const missing = postSlugs.filter((s) => !manifest.includes(s));
  const extra = manifest.filter((s) => !postSlugs.includes(s));
  check(
    'OG 清单与文章集合一致（漏跑 npm run og 会在这里暴露）',
    missing.length === 0 && extra.length === 0 && manifest.length > 0,
    '文章=' + postSlugs.length + ' 清单=' + manifest.length + ' 缺=' + (missing.slice(0, 3).join(',') || '无') + ' 多=' + (extra.slice(0, 3).join(',') || '无'),
  );
  // 清单里每一个 slug 都必须真有对应文件，否则 ogImagePath 会给出 404 链接
  const fs = await import('node:fs');
  const missingFiles = manifest.filter(
    (s) => !fs.existsSync(join(ROOT, 'public/og', s + '.png')),
  );
  check(
    'OG 清单每项都有对应 png 文件',
    missingFiles.length === 0,
    missingFiles.slice(0, 3).join(',') || '全部存在',
  );
}

// ② 图片不得绕过优化管线：public/ 下只允许 og.png（兜底分享图）与非图片资源
{
  const fs = await import('node:fs');
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else out.push(p);
    }
    return out;
  };
  const publicFiles = walk(join(ROOT, 'public'));
  const IMG = /\.(jpe?g|png|webp|gif|avif|bmp|tiff?)$/i;
  const offenders = publicFiles
    .map((p) => p.slice(ROOT.length + 1).replace(/\\/g, '/'))
    .filter((p) => IMG.test(p))
    .filter((p) => p !== 'public/og.png' && !p.startsWith('public/og/'));
  check(
    'public/ 下无绕过优化管线的图片（og.png 与 public/og/ 白名单除外）',
    offenders.length === 0,
    offenders.slice(0, 3).join(',') || '仅 ' + publicFiles.filter((p) => IMG.test(p)).length + ' 个白名单文件',
  );
  // 构建产物里也不应出现未压缩的 jpg/gif —— Astro 会把 src/assets 的图转成 webp
  const distImgs = walk(join(ROOT, 'dist'))
    .map((p) => p.slice(ROOT.length + 1).replace(/\\/g, '/'))
    .filter((p) => /\.(jpe?g|gif)$/i.test(p));
  check('构建产物无未压缩 jpg/gif', distImgs.length === 0, distImgs.slice(0, 3).join(',') || '0 个');
}

// ③ 归档页总阅读时长：必须等于逐篇 readingTime 之和，不能是平均值估算。
// 口径变更（T-21）：这段原先用 search.json 的 content 独立重算，但 T-21 把索引正文
// 截断到前 500 字后，两者口径不再等价（页面用 post.body 全文，search.json 只有前 500 字），
// 重算值会系统性偏小（实测 47 vs 页面 56，ratio 0.84 → 假红）。
// 改为直接读 Markdown 源文件、剥掉 frontmatter 后用同一公式重算，与页面同源。
// 前提：getPublishedPosts() 在 PROD 下会滤掉 draft 与未来日期文章；当前 32 篇全为已发布，
// 若将来出现 draft，这里会多算，届时需要同步过滤 frontmatter（届时断言会先红，是好事）。
{
  const archiveHtml = await (await fetch(BASE + '/archive/')).text();
  const m = /读完约\s*(\d+)\s*分钟/.exec(archiveHtml);
  const shown = m ? Number(m[1]) : null;

  const postsDir = join(ROOT, 'src', 'content', 'posts');
  const calc = readdirSync(postsDir)
    .filter((f) => f.endsWith('.md'))
    .reduce((n, f) => {
      const raw = readFileSync(join(postsDir, f), 'utf8');
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
      const cjk = (body.match(/[\u4e00-\u9fff]/g) ?? []).length;
      const words = (body.match(/[A-Za-z0-9]+/g) ?? []).length;
      return n + Math.max(1, Math.ceil(cjk / 400 + words / 200));
    }, 0);

  check(
    '归档页阅读时长与逐篇累计一致',
    shown !== null && shown === calc,
    '页面=' + shown + ' 独立重算=' + calc,
  );
  check('归档页阅读时长不是固定值', shown !== null && shown !== 1 && shown !== 100, String(shown));
}

// ---- 渐进增强兜底 & 结构化数据转义（T-12 / A2 的回归防线）----
// 这两类是「肉眼看不出坏」的缺陷，日常预览永远正常：
//  - JS 加载失败时正文空白（T-12），只在脚本被拦/网络异常时出现；
//  - JSON-LD 里 </script> 未转义（A2），只在标题恰好含该串时逃逸。
// 都只能靠断言守，且必须做故障注入证明断言有牙。

// ⑤ JS 加载失败时正文不得永久空白（T-12）
{
  const tabRes = await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`,
    { method: 'PUT' },
  );
  const tab = await tabRes.json();
  const cdp = connect(tab.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  // 只拦站点脚本（CSS 照常加载），精确复现「JS 挂了但样式还在」这个最坏情形。
  // 注意不要连 CSS 一起拦 —— 那样兜底反而会生效，测不出真正的问题。
  await cdp.send('Network.setBlockedURLs', {
    urls: ['*/_astro/*.js', '*/_astro/*.js?*'],
  });
  await cdp.send('Page.navigate', { url: `${BASE}/posts/blog-build-notes/` });
  await sleep(1600);
  const r = await evaluate(
    cdp,
    `(() => {
      const p = document.querySelector('.prose');
      if (!p) return { hasProse: false, opacity: null, htmlClass: '', revealReady: null };
      return {
        hasProse: true,
        opacity: getComputedStyle(p).opacity,
        htmlClass: document.documentElement.className,
        revealReady: document.documentElement.dataset.revealReady ?? null,
      };
    })()`,
  );
  check('JS 加载失败: 有正文容器', r.hasProse);
  check(
    'JS 加载失败: 正文仍可见（T-12 兜底生效）',
    r.hasProse && r.opacity === '1',
    `opacity=${r.opacity} class="${r.htmlClass}" revealReady=${r.revealReady}`,
  );
  // 兜底不只是「把一段 CSS 改回去」：它靠撤销 html 上的 .js 标记来生效。
  // 若 .js 被留下，任何一条 `.js .reveal{opacity:0}` 规则都会重新命中。
  check(
    'JS 加载失败: 已撤销 html 的 .js 标记',
    r.hasProse && !/(^|\s)js(\s|$)/.test(r.htmlClass),
    `class="${r.htmlClass}"`,
  );
  cdp.ws.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${tab.id}`);
}

// ⑥ 结构化数据（A2）：源码契约 + 构建产物双层断言
{
  // (a) 源码契约：任何产出 <script type="application/ld+json"> 的地方都必须走
  //     safeJsonLd，不许再出现裸 JSON.stringify —— 这是防「改回去」的那道闸。
  const srcFiles = [];
  const walkSrc = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walkSrc(p);
      else if (/\.(astro|ts)$/.test(e.name)) srcFiles.push(p);
    }
  };
  walkSrc(join(ROOT, 'src'));
  const allSrc = srcFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
  const rawCount = (allSrc.match(/JSON\.stringify\(jsonLd\)/g) || []).length;
  // 1 处定义 + 10 处调用（文章页/首页/标签总览/标签页/分页页/归档页/系列页/
  // 关于页/专题总览/专题详情页）。
  // 每新增一个产出 JSON-LD 的页面，这里的下限必须同步上调 —— 否则
  // 新页面完全可以用裸 JSON.stringify 而不被发现（下限是闸门，不是描述）。
  const safeCount = (allSrc.match(/safeJsonLd\(/g) || []).length;
  check('结构化数据: 无裸 JSON.stringify(jsonLd)', rawCount === 0, `${rawCount} 处`);
  check('结构化数据: safeJsonLd 覆盖定义与全部调用点', safeCount >= 11, `${safeCount} 处`);
  check(
    '结构化数据: safeJsonLd 转义 < > & U+2028 U+2029',
    /\\u003c/.test(allSrc) && /\\u003e/.test(allSrc) && /\\u0026/.test(allSrc) && /u2028/.test(allSrc) && /u2029/.test(allSrc),
  );

  // (b) 构建产物：遍历**每一篇**构建出的文章页 + 各列表页，逐块解析 JSON-LD。
  //     遍历而非抽查，是因为逃逸只在「标题恰好含 </script>」时触发 ——
  //     将来真有人写一篇讲 HTML 转义的文章，这条断言会自动把它罩住。
  const pages = [];
  for (const entry of readdirSync(join(ROOT, 'dist/posts'), { withFileTypes: true })) {
    if (entry.isDirectory()) pages.push(`/posts/${entry.name}/`);
  }
  for (const p of [
    '/',
    '/tags/',
    '/page/2/',
    '/archive/',
    '/series/astro-blog/',
    '/topics/',
    '/topics/ship-it/',
  ])
    pages.push(p);

  let badBlocks = 0;
  let totalBlocks = 0;
  const badList = [];
  for (const path of pages) {
    const res = await fetch(`${BASE}${path}`);
    if (!res.ok) continue;
    const html = await res.text();
    const blocks = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    totalBlocks += blocks.length;
    for (const b of blocks) {
      // 判据一：块内不得出现未转义的结束标签（这正是逃逸的形态）
      const escaped = !/<\/script/i.test(b);
      // 判据二：块必须是合法 JSON（逃逸时会被截断）
      let parsable = true;
      try {
        JSON.parse(b);
      } catch {
        parsable = false;
      }
      if (!escaped || !parsable) {
        badBlocks += 1;
        badList.push(`${path}(escaped=${escaped},parsable=${parsable})`);
      }
    }
  }
  check(
    '结构化数据: 全站 JSON-LD 块均可解析且无未转义 </script>',
    totalBlocks > 0 && badBlocks === 0,
    badBlocks ? badList.slice(0, 3).join(' | ') : `${pages.length} 页 / ${totalBlocks} 块`,
  );
  // 逃逸的真正后果：页面里会多出一段**可执行的**脚本。
  // 断言「ld+json 之外没有因数据注入而新增的 script」，坐实注入不成立。
  {
    const html = await (await fetch(`${BASE}/posts/blog-build-notes/`)).text();
    const ldCount = (html.match(/<script type="application\/ld\+json"/g) || []).length;
    check('结构化数据: 文章页 JSON-LD 块数为 1（未被数据撑成多块）', ldCount === 1, `${ldCount} 块`);
  }
}

// ---- T-24 SEO 真空缺（about / tags 总览 / 首页聚合语义）----
// 这一组的由来：实测 56 个真实页里，about 与 tags 总览是**仅有**两个
// 「有 canonical、未 noindex、却零结构化数据」的页面 —— 搜索引擎知道它们存在，
// 却拿不到任何实体声明；首页则有 ld 但不含 CollectionPage，与 /page/2/ 结构不一致。
// 这几条断言全部对着构建产物做，且判据是「真实渲染的条数」，不是「含某个字符串」。
{
  const ldBlocks = (html) =>
    [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

  // 解析后递归收集 @type，用于判断实体类型是否真的存在（不是文本包含）
  const collectTypes = (node, out) => {
    if (Array.isArray(node)) {
      node.forEach((n) => collectTypes(n, out));
    } else if (node && typeof node === 'object') {
      if (typeof node['@type'] === 'string') out.add(node['@type']);
      Object.values(node).forEach((n) => collectTypes(n, out));
    }
    return out;
  };

  const loadLd = async (path) => {
    const res = await fetch(`${BASE}${path}`);
    const html = await res.text();
    const blocks = ldBlocks(html);
    const parsed = [];
    for (const b of blocks) {
      try {
        parsed.push(JSON.parse(b));
      } catch {
        /* 解析失败由上面的通用断言负责计数，这里只收能解析的 */
      }
    }
    const types = new Set();
    parsed.forEach((o) => collectTypes(o, types));
    return { ok: res.ok, blocks, parsed, types, html };
  };

  // ① about：此前 0 块。AboutPage 是 WebPage 的子类型，比笼统的 WebPage 更准。
  {
    const a = await loadLd('/about/');
    check('about 页含可解析的 JSON-LD', a.ok && a.parsed.length === 1, `${a.blocks.length} 块`);
    check(
      'about 页声明 AboutPage + BreadcrumbList',
      a.types.has('AboutPage') && a.types.has('BreadcrumbList'),
      [...a.types].join(','),
    );
    // 面包屑末级即本页，按全站惯例不带 item（带了就等于自指，会多一环）
    const bc = a.parsed.flatMap((o) => o['@graph'] ?? [o]).find((n) => n['@type'] === 'BreadcrumbList');
    const last = bc?.itemListElement?.at(-1);
    check('about 面包屑末级不自指', last?.item === undefined && last?.name === '关于', JSON.stringify(last));
  }

  // ② tags 总览：这一页渲染的是标签云，不是文章列表。
  //    断言条数等于页面上真实渲染的标签数 —— 结构化数据必须与可见内容同源。
  {
    const t = await loadLd('/tags/');
    check('标签总览页含可解析的 JSON-LD', t.ok && t.parsed.length === 1, `${t.blocks.length} 块`);
    check(
      '标签总览页声明 CollectionPage + BreadcrumbList',
      t.types.has('CollectionPage') && t.types.has('BreadcrumbList'),
      [...t.types].join(','),
    );
    const cp = t.parsed.flatMap((o) => o['@graph'] ?? [o]).find((n) => n['@type'] === 'CollectionPage');
    const visibleTags = (t.html.match(/<a class="tag" href="\/tags\//g) || []).length;
    check(
      '标签总览: JSON-LD 标签数 === 页面渲染的标签数',
      cp?.mainEntity?.numberOfItems === visibleTags && visibleTags > 0,
      `ld=${cp?.mainEntity?.numberOfItems} 页面=${visibleTags}`,
    );
  }

  // ③ 首页：CollectionPage 的条数必须等于本页真实渲染的 6 篇（PER_PAGE），
  //    而不是全部 32 篇 —— 后者是「声明了页面上没有的内容」，是明确的作弊形态。
  {
    const h = await loadLd('/');
    check('首页声明 CollectionPage', h.types.has('CollectionPage'), [...h.types].join(','));
    const cp = h.parsed.flatMap((o) => o['@graph'] ?? [o]).find((n) => n['@type'] === 'CollectionPage');
    // 首页列表用 .post-row 承载每一篇（见 Archive.astro），逐个数出来比对
    const visibleRows = (h.html.match(/class="post-row /g) || []).length;
    check(
      '首页: ItemList 条数 === 页面渲染的文章行数',
      cp?.mainEntity?.numberOfItems === visibleRows && visibleRows > 0,
      `ld=${cp?.mainEntity?.numberOfItems} 页面=${visibleRows}`,
    );
    // WebSite + Person 两个老实体不能因为新增 CollectionPage 而被挤掉
    check(
      '首页仍保留 WebSite 与 Person 实体',
      h.types.has('WebSite') && h.types.has('Person'),
      [...h.types].join(','),
    );
  }

  // ④ 全站扫尾：任何「可收录（有 canonical、未 noindex）」的页面都不许零结构化数据。
  //    这条是防止将来新增页面时又漏一个 —— 单页断言照顾不到新页面。
  {
    const missing = [];
    const htmlFiles = [];
    const walkHtml = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walkHtml(p);
        else if (e.name.endsWith('.html')) htmlFiles.push(p);
      }
    };
    walkHtml(join(ROOT, 'dist'));
    for (const file of htmlFiles) {
      const html = readFileSync(file, 'utf8');
      // 重定向桩与 noindex 页不参与：它们本来就不该被收录
      if (/http-equiv=["']refresh["']/i.test(html)) continue;
      if (/name=["']robots["'][^>]*noindex/i.test(html)) continue;
      if (!/application\/ld\+json/.test(html)) missing.push(file.replace(ROOT, ''));
    }
    check('可收录页面均含结构化数据', missing.length === 0, missing.slice(0, 3).join(' | ') || `${htmlFiles.length} 个 html`);
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
    // 共享元素 morph 的载体是 **group 层**，不是 old/new：
    // group 负责把列表标题的位置/尺寸插值到文章标题。它必须真的在动，
    // 否则标题只是原地闪现，"从哪来到哪去"就没了。
    const groupStates = new Set();
    let groupAnimName = null;
    const groupBox = (tf, w, h) => {
      const m = tf && tf !== 'none' ? tf.match(/matrix\(([^)]+)\)/) : null;
      const p = m ? m[1].split(',').map(Number) : null;
      const tr = p && p.length >= 6 ? p[4] + ',' + p[5] : tf;
      return tr + '|' + w + 'x' + h;
    };
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
          const gcs = getComputedStyle(document.documentElement, '::view-transition-group(' + tn + ')');
          if (gcs.animationName && gcs.animationName !== 'none') groupAnimName = gcs.animationName;
          groupStates.add(groupBox(gcs.transform, Math.round(parseFloat(gcs.width)), Math.round(parseFloat(gcs.height))));
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
      snap.groupAnimName = groupAnimName;
      snap.groupStates = groupStates.size;
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

  // 判据 6：共享元素必须真的**飞**（group 层的 morph 不能被关掉）。
  // 这是一条曾经失守的判据：T-19 给具名元素加 transition:animate="none"
  // 省重复 CSS 时，Astro 连带输出了
  //   @layer astro { ::view-transition-group(<name>) { animation: none } }
  // 而 group 层正是"列表标题 → 文章标题"位置/尺寸插值的唯一载体。
  // 被关掉后标题直接原地闪现（实测 group 状态数 22 → 2、动画名 → none），
  // 而当时 205 条断言全绿 —— 因为没有任何一条读过 group 层。
  // 采样的是**实际计算值**而不是"有没有那条声明"，所以不会随实现方式改变而失效。
  check(
    `${label}: 共享元素真的在飞（group 层有 morph 动画）`,
    !!fwd && !!fwd.groupAnimName && !/^none$/i.test(fwd.groupAnimName),
    fwd ? `group anim: ${fwd.groupAnimName || '(none)'}` : '(null)',
  );
  check(
    `${label}: 共享元素逐帧插值（位置/尺寸在变化，非原地闪现）`,
    !!fwd && fwd.groupStates >= 5,
    fwd ? `group 状态数 ${fwd.groupStates}` : '(null)',
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

// ---- T-38 文末工具条：复制 canonical / 系统分享 ----
// ① 服务端产物：无 JS 时两块都带 hidden，且 data-url 已由服务端算好
{
  const t38Html = await (await fetch(`${BASE}/posts/blog-build-notes/`)).text();
  const canonical = (/<link rel="canonical" href="([^"]+)"/.exec(t38Html) || [])[1] || '';
  const actionsSeg = (/<div class="post-actions"[\s\S]*?<\/div>/.exec(t38Html) || [''])[0];
  const buttons = [...actionsSeg.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
  const copyTag = buttons.find((tag) => tag.includes('data-copy-link')) || '';
  const shareTag = buttons.find((tag) => /\bdata-share\b/.test(tag)) || '';
  check(
    'T-38 无 JS 时工具条与两个按钮都隐藏',
    /<div class="post-actions"[^>]*\bhidden\b/.test(actionsSeg) &&
      buttons.length === 2 &&
      buttons.every((tag) => /\bhidden\b/.test(tag)),
    `buttons=${buttons.length} hidden=${buttons.filter((t) => /\bhidden\b/.test(t)).length}`,
  );
  check(
    'T-38 服务端 data-url 就是 canonical',
    !!canonical &&
      !!copyTag &&
      !!shareTag &&
      copyTag.includes(`data-url="${canonical}"`) &&
      shareTag.includes(`data-url="${canonical}"`) &&
      !/[?#]/.test(canonical),
    canonical || '未找到 canonical',
  );
  check(
    'T-38 工具条带 aria-live 状态区',
    /data-action-status[^>]*aria-live="polite"/.test(actionsSeg) ||
      /aria-live="polite"[^>]*data-action-status/.test(actionsSeg),
    actionsSeg ? '有' : '未找到工具条',
  );
}

// ② 浏览器交互：分享 API 必须在页面脚本执行前打桩，否则按钮不会绑定监听
const t38Init = `
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: async (data) => { window.__shared = data; },
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    get: () => ({ writeText: async (text) => { window.__copied = text; } }),
  });
`;

await runPage(
  `${BASE}/posts/blog-build-notes/`,
  async (cdp, label) => {
    const initial = await evaluate(
      cdp,
      `(() => {
        const actions = document.querySelector('[data-post-actions]');
        const copy = document.querySelector('[data-copy-link]');
        const share = document.querySelector('[data-share]');
        return {
          actionsHidden: actions?.hidden,
          copyHidden: copy?.hidden,
          shareHidden: share?.hidden,
          copyTag: copy?.tagName,
          shareTag: share?.tagName,
          copyUrl: copy?.dataset.url || '',
          canonical: document.querySelector('link[rel="canonical"]')?.href || '',
          pageTitle: document.title,
          live: !!actions?.querySelector('[data-action-status][aria-live="polite"]'),
        };
      })()`,
    );
    check(
      `${label}: JS 就绪后复制按钮出现且可聚焦`,
      initial.copyHidden === false &&
        initial.actionsHidden === false &&
        initial.copyTag === 'BUTTON' &&
        initial.live,
      `actions=${initial.actionsHidden} copy=${initial.copyHidden} tag=${initial.copyTag}`,
    );
    check(
      `${label}: 支持 Web Share 时分享按钮出现`,
      initial.shareHidden === false && initial.shareTag === 'BUTTON',
      `share.hidden=${initial.shareHidden}`,
    );
    check(
      `${label}: data-url 精确等于 canonical`,
      !!initial.canonical && initial.copyUrl === initial.canonical && !/[?#]/.test(initial.copyUrl),
      initial.copyUrl,
    );

    const copied = await evaluate(
      cdp,
      `(async () => {
        const btn = document.querySelector('[data-copy-link]');
        btn.focus();
        btn.click();
        await new Promise((r) => setTimeout(r, 120));
        return {
          text: window.__copied,
          status: document.querySelector('[data-action-status]')?.textContent || '',
          label: btn.querySelector('[data-copy-label]')?.textContent.trim() || '',
          copiedClass: btn.classList.contains('copied'),
          focused: document.activeElement === btn,
        };
      })()`,
    );
    check(
      `${label}: 复制写入的文本精确等于 canonical`,
      copied.text === initial.canonical && copied.focused,
      `copied=${copied.text} focused=${copied.focused}`,
    );
    check(
      `${label}: 复制成功有 aria-live 播报与按钮反馈`,
      copied.status === '链接已复制' && copied.label === '已复制' && copied.copiedClass,
      `status=${copied.status} label=${copied.label}`,
    );

    await sleep(1700);
    const restored = await evaluate(
      cdp,
      `(() => {
        const btn = document.querySelector('[data-copy-link]');
        return {
          label: btn.querySelector('[data-copy-label]')?.textContent.trim() || '',
          copiedClass: btn.classList.contains('copied'),
        };
      })()`,
    );
    check(
      `${label}: 1.6 秒后复制按钮恢复`,
      restored.label === '复制链接' && !restored.copiedClass,
      `label=${restored.label} copied=${restored.copiedClass}`,
    );

    const shared = await evaluate(
      cdp,
      `(async () => {
        document.querySelector('[data-action-status]').textContent = '';
        document.querySelector('[data-share]').click();
        await new Promise((r) => setTimeout(r, 120));
        return {
          payload: window.__shared || null,
          status: document.querySelector('[data-action-status]')?.textContent || '',
        };
      })()`,
    );
    check(
      `${label}: 分享调用传入 {title,url}`,
      shared.payload?.url === initial.canonical &&
        shared.payload?.title === initial.pageTitle.replace(/ · Azain$/, '') &&
        shared.status === '',
      JSON.stringify(shared.payload),
    );

    const fallback = await evaluate(
      cdp,
      `(async () => {
        window.__copied = '';
        document.querySelector('[data-action-status]').textContent = '';
        Object.defineProperty(navigator, 'share', {
          configurable: true,
          value: async () => { throw new Error('share unavailable'); },
        });
        document.querySelector('[data-share]').click();
        await new Promise((r) => setTimeout(r, 150));
        return {
          text: window.__copied,
          status: document.querySelector('[data-action-status]')?.textContent || '',
        };
      })()`,
    );
    check(
      `${label}: 分享失败回退复制并播报`,
      fallback.text === initial.canonical && fallback.status.includes('分享不可用'),
      `status=${fallback.status}`,
    );

    const aborted = await evaluate(
      cdp,
      `(async () => {
        document.querySelector('[data-action-status]').textContent = '';
        window.__copied = '';
        Object.defineProperty(navigator, 'share', {
          configurable: true,
          value: async () => { throw new DOMException('cancel', 'AbortError'); },
        });
        document.querySelector('[data-share]').click();
        await new Promise((r) => setTimeout(r, 150));
        return {
          status: document.querySelector('[data-action-status]')?.textContent || '',
          copied: window.__copied || '',
        };
      })()`,
    );
    check(
      `${label}: 取消分享静默不报错`,
      aborted.status === '' && aborted.copied === '',
      `status=${aborted.status} copied=${aborted.copied}`,
    );

    const copyFailed = await evaluate(
      cdp,
      `(async () => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          get: () => ({ writeText: async () => { throw new Error('denied'); } }),
        });
        document.querySelector('[data-copy-link]').click();
        await new Promise((r) => setTimeout(r, 150));
        return document.querySelector('[data-action-status]')?.textContent || '';
      })()`,
    );
    check(
      `${label}: 复制失败播报可操作提示`,
      copyFailed === '复制失败，请从地址栏复制',
      copyFailed,
    );
  },
  '文章页分享工具条',
  { initScript: t38Init },
);

// ---- T-39 随机阅读：/random.json 与页脚「随便看看」----
// ① 数据源与 sitemap 的文章集合完全一致（draft/未来文章不得混入）
const t39Res = await fetch(`${BASE}/random.json`);
const t39Posts = await t39Res.json().catch(() => null);
const t39Sitemap = await (await fetch(`${BASE}/sitemap-0.xml`)).text();
const t39SitemapPaths = [...t39Sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
  .map((m) => new URL(m[1]).pathname)
  .filter((p) => /^\/posts\/[^/]+\/$/.test(p))
  .sort();
const t39Paths = Array.isArray(t39Posts)
  ? t39Posts.map((p) => new URL(p.href, BASE).pathname).sort()
  : [];
{
  const missing = t39SitemapPaths.filter((p) => !t39Paths.includes(p));
  const extra = t39Paths.filter((p) => !t39SitemapPaths.includes(p));
  check(
    'T-39 /random.json 与 sitemap 文章集合一致',
    t39Res.ok &&
      Array.isArray(t39Posts) &&
      t39Posts.length > 1 &&
      missing.length === 0 &&
      extra.length === 0,
    `status=${t39Res.status} 条目=${t39Paths.length}/${t39SitemapPaths.length} 缺=${missing.slice(0, 3).join(',') || '无'} 多=${extra.slice(0, 3).join(',') || '无'}`,
  );
}

// ② 无 JS 的服务端 HTML：href 是归档页，随机数据源另放在 data 属性
{
  const footerOf = async (path) => {
    const html = await (await fetch(`${BASE}${path}`)).text();
    return (/<a class="footer-random"[\s\S]*?<\/a>/.exec(html) || [''])[0];
  };
  const onPost = await footerOf(t39Posts?.[0] ? new URL(t39Posts[0].href, BASE).pathname : '/');
  const onHome = await footerOf('/');
  const ok = (tag) =>
    /href="[^"]*\/archive\/"/.test(tag) &&
    /\bdata-random-post\b/.test(tag) &&
    /data-random-src="[^"]*\/random\.json"/.test(tag);
  check(
    'T-39 页脚退路是无 JS 可用的归档页',
    ok(onPost) && ok(onHome),
    `article=${ok(onPost)} home=${ok(onHome)}`,
  );
}

// ③ 浏览器：加载时不请求；点击后不跳回当前页
const t39Start = t39Posts?.[0]
  ? new URL(t39Posts[0].href, BASE).pathname
  : '/posts/hello-world/';
const t39ExpectedTarget = t39Posts?.[1]
  ? new URL(t39Posts[1].href, BASE).pathname
  : '';
await runPage(
  `${BASE}${t39Start}`,
  async (cdp, label) => {
    const before = await evaluate(
      cdp,
      `(() => {
        const link = document.querySelector('[data-random-post]');
        return {
          href: link?.getAttribute('href') || '',
          ready: link?.dataset.ready || '',
          randomRequests: performance.getEntriesByType('resource')
            .filter((e) => e.name.includes('/random.json')).length,
        };
      })()`,
    );
    check(
      `${label}: 页面加载时不预取 random.json`,
      before.randomRequests === 0 && before.ready === '1',
      `requests=${before.randomRequests} ready=${before.ready}`,
    );

    const result = await evaluate(
      cdp,
      `(async () => {
        Math.random = () => 0;
        document.querySelector('[data-random-post]').click();
        for (let i = 0; i < 40; i++) {
          if (location.pathname !== ${JSON.stringify(t39Start)}) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        await new Promise((r) => setTimeout(r, 900));
        return {
          path: location.pathname,
          randomRequests: performance.getEntriesByType('resource')
            .filter((e) => e.name.includes('/random.json')).length,
          hasArticle: !!document.querySelector('.post-title'),
        };
      })()`,
    );
    check(
      `${label}: 点击后随机到另一篇文章`,
      result.path === t39ExpectedTarget && result.hasArticle,
      `${result.path}（期望 ${t39ExpectedTarget}）`,
    );
    check(
      `${label}: 只有点击后才请求 random.json`,
      result.randomRequests >= 1,
      `requests=${result.randomRequests}`,
    );
  },
  '随机阅读-点击',
);

// ④ 清单拉取失败：退回归档页
await runPage(
  `${BASE}${t39Start}`,
  async (cdp, label) => {
    await evaluate(
      cdp,
      `(() => {
        window.fetch = () => Promise.reject(new Error('offline'));
        document.querySelector('[data-random-post]').click();
        return true;
      })()`,
    );
    // 退路是 location.assign()，整页导航会让当前执行上下文失效；
    // 必须在 Node 侧等新文档加载完，再单独取一次 location.pathname。
    await sleep(2500);
    const result = await evaluate(
      cdp,
      `({ path: location.pathname, hasArchive: !!document.querySelector('.archive, .archive-list, main') })`,
    );
    check(
      `${label}: fetch 失败落到归档页`,
      result.path === '/archive/' && result.hasArchive,
      result.path,
    );
  },
  '随机阅读-失败退路',
);

// ---- T-37 打印样式：只留正文，深色主题也印浅色 ----
// 用 CDP 切换 print 媒体读取计算样式。关键在**恢复 screen**：
// 不恢复的话后续断言会全部跑在打印版面上，得到一堆假红/假绿。
await runPage(
  `${BASE}/posts/blog-build-notes/`,
  async (cdp, label) => {
    // 屏幕端：打印专用 URL 必须不可见（它是隐藏元素，不是靠颜色藏）
    const screenState = await evaluate(
      cdp,
      `(() => ({
        urlDisplay: getComputedStyle(document.querySelector('.print-url')).display,
        canonical: document.querySelector('link[rel="canonical"]')?.href || '',
        dark: document.documentElement.classList.contains('dark'),
      }))()`,
    );
    check(
      `${label}: 打印专用 URL 在屏幕端隐藏`,
      screenState.urlDisplay === 'none' && !!screenState.canonical,
      `display=${screenState.urlDisplay} canonical=${screenState.canonical ? '有' : '无'}`,
    );

    await cdp.send('Emulation.setEmulatedMedia', {
      media: 'print',
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });

    const printed = await evaluate(
      cdp,
      `(() => {
        const hiddenSelectors = [
          '.site-header', '.site-footer', '.skip-link', '.post-back',
          '.toc-toggle', '.toc-rail', '.toc-backdrop', '.related',
          '.post-series-nav', '.post-nav', '.post-footer .back',
          '.post-actions', '.code-copy',
        ];
        const shownSelectors = ['.prose', '.post-title', '.post-meta', '.post-revision'];
        const state = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const s = getComputedStyle(el);
          return { display: s.display, visibility: s.visibility, opacity: s.opacity };
        };
        const hiddenBad = hiddenSelectors
          .map((sel) => ({ sel, s: state(sel) }))
          .filter(({ s }) => !s || s.display !== 'none')
          .map(({ sel, s }) => sel + '=' + (s ? s.display : 'missing'));
        const shownBad = shownSelectors
          .map((sel) => ({ sel, s: state(sel) }))
          .filter(({ s }) => !s || s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0')
          .map(({ sel, s }) => sel + '=' + (s ? s.display + '/' + s.visibility + '/' + s.opacity : 'missing'));

        const body = getComputedStyle(document.body);
        const url = document.querySelector('.print-url');
        const urlStyle = url ? getComputedStyle(url) : null;

        // 代码块里取一个真实 span，与 --shiki-light / --shiki-dark 的解析值对比。
        // 探针必须挂在 span 内部：两个变量是 Shiki 写在 span 的行内样式上的，
        // 挂到 body 上会解析失败，得到两个相同的继承色，断言就失去判别力。
        const span = document.querySelector('.prose .astro-code span');
        const probe = document.createElement('i');
        probe.style.cssText = 'position:absolute;left:-9999px';
        let light = '';
        let dark = '';
        if (span) {
          span.appendChild(probe);
          probe.style.color = 'var(--shiki-light)';
          light = getComputedStyle(probe).color;
          probe.style.color = 'var(--shiki-dark)';
          dark = getComputedStyle(probe).color;
          probe.remove();
        }
        const codeColor = span ? getComputedStyle(span).color : '';
        const codeBg = span ? getComputedStyle(span).backgroundColor : '';

        // 外链补 URL：临时插入一个正文外链与一个图片链接，读 ::after 后立刻移除
        const prose = document.querySelector('.prose');
        const a = document.createElement('a');
        a.href = 'https://example.com/print-probe';
        a.textContent = '外部链接';
        prose.appendChild(a);
        const linkAfter = getComputedStyle(a, '::after').content;
        const imgA = document.createElement('a');
        imgA.href = 'https://example.com/print-image';
        imgA.innerHTML = '<img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
        prose.appendChild(imgA);
        const imgAfter = getComputedStyle(imgA, '::after').content;
        a.remove();
        imgA.remove();

        return {
          hiddenBad, shownBad,
          bodyBg: body.backgroundColor, bodyColor: body.color,
          dark: document.documentElement.classList.contains('dark'),
          urlDisplay: urlStyle?.display ?? 'missing',
          urlText: url?.textContent.trim() ?? '',
          canonical: document.querySelector('link[rel="canonical"]')?.href || '',
          hasCode: !!span,
          codeColor, codeBg, light, darkColor: dark,
          linkAfter, imgAfter,
        };
      })()`,
    );

    check(
      `${label}: 打印时隐藏页头、目录、相关文章与操作控件`,
      printed.hiddenBad.length === 0,
      printed.hiddenBad.slice(0, 4).join(' | ') || '全部 display:none',
    );
    check(
      `${label}: 打印时保留正文与元信息`,
      printed.shownBad.length === 0,
      printed.shownBad.slice(0, 4).join(' | ') || '正文/标题/元信息/修订记录均可见',
    );
    check(
      `${label}: 打印 URL 可见且等于 canonical`,
      printed.urlDisplay === 'block' && printed.urlText === `原文：${printed.canonical}`,
      `display=${printed.urlDisplay} text=${printed.urlText.slice(0, 90)}`,
    );
    check(
      `${label}: 深色主题打印强制浅底深字与 Shiki light`,
      printed.dark &&
        printed.bodyBg === 'rgb(255, 255, 255)' &&
        printed.bodyColor === 'rgb(17, 17, 17)' &&
        printed.hasCode &&
        printed.codeColor === printed.light &&
        printed.codeColor !== printed.darkColor,
      `dark=${printed.dark} bg=${printed.bodyBg} ink=${printed.bodyColor} code=${printed.codeColor} light=${printed.light} dark=${printed.darkColor} bg=${printed.codeBg}`,
    );
    check(
      `${label}: 打印时正文外链补 URL、图片链接不补`,
      printed.linkAfter.includes('https://example.com/print-probe') &&
        !printed.imgAfter.includes('https://example.com/print-image'),
      `a::after=${printed.linkAfter.slice(0, 70)} img::after=${printed.imgAfter.slice(0, 40)}`,
    );

    // 必须恢复屏幕媒体，否则后面所有断言都会在打印版面上跑
    await cdp.send('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });
    const restored = await evaluate(
      cdp,
      `(() => ({
        header: getComputedStyle(document.querySelector('.site-header')).display,
        url: getComputedStyle(document.querySelector('.print-url')).display,
      }))()`,
    );
    check(
      `${label}: 打印断言后恢复 screen 且无样式泄漏`,
      restored.header !== 'none' && restored.url === 'none',
      `header=${restored.header} print-url=${restored.url}`,
    );
  },
  '文章页打印',
  { dark: true },
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
