// 临时验证脚本：用无头 Chrome + CDP 截取页面，支持浅色/深色与移动端视口。
// 用法：先在另一个终端跑 `npm run dev`（或 `npm run preview`），再执行 `npm run screenshot`
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// 注意：不要写成 dirname(fileURLToPath(new URL('..', import.meta.url)))——
// fileURLToPath 会保留结尾的反斜杠（"…\blog\"），dirname 再吃掉一层就变成
// 上一级目录，导致 .chrome-tmp* / .shots 落到项目外面。
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// 可用 CHROME_BIN 环境变量覆写 Chrome 路径，否则用默认安装位置
const CHROME =
  process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE_URL || 'http://localhost:4321';
const PORT = 9222;
const OUT = `${ROOT}/.shots`;

mkdirSync(OUT, { recursive: true });


// Chrome 被强杀后会在 profile 目录里留下 SingletonLock 等文件。下一个实例看到锁，
// 会认为已有实例在运行，于是把请求「移交」过去并**自己立刻 exit 0** ——
// 表现为「启动后立即退出」，且不打印任何输出，极难排查（本项目实际踩到过）。
// 每次运行前把 profile 目录清掉，从根上避免。
const PROFILE_DIR = `${ROOT}/.chrome-tmp`;
try {
  rmSync(PROFILE_DIR, { recursive: true, force: true });
} catch { /* 上一个实例可能还占着，删不掉不致命 */ }

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${ROOT}/.chrome-tmp`,
  'about:blank',
]);

/**
 * 结束 Chrome 及其**整棵进程树**。
 *
 * Windows 上 `chrome.kill()` 只终止主进程，渲染进程会残留并继续占着
 * `--user-data-dir` 与 `--remote-debugging-port`；下一次运行就会卡在
 * 「Chrome DevTools 端口未就绪」（实测残留过 8 个进程）。用 taskkill /T 连子树一起结束。
 */
const PROFILE_TAG = PROFILE_DIR.slice(PROFILE_DIR.lastIndexOf('/') + 1);

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
    // 收尾失败不该影响截图结果
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

async function newTab(url) {
  const res = await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
  );
  return res.json();
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

async function shot(tab, name, { width, height, dark }) {
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
  await cdp.send('Page.navigate', { url: tab.url });
  await sleep(1200);
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
  cdp.ws.close();
  console.log(`saved ${name}.png`);
}

await waitForDebugger();

const targets = [
  ['index-light', `${BASE}/`, { width: 1440, height: 1000, dark: false }],
  ['index-dark', `${BASE}/`, { width: 1440, height: 1000, dark: true }],
  ['post-light', `${BASE}/posts/blog-build-notes/`, { width: 1440, height: 1000, dark: false }],
  ['about-light', `${BASE}/about/`, { width: 1440, height: 1000, dark: false }],
  ['tags-light', `${BASE}/tags/`, { width: 1440, height: 1000, dark: false }],
  ['index-mobile', `${BASE}/`, { width: 390, height: 844, dark: false }],
];

for (const [name, url, opts] of targets) {
  const tab = await newTab(url);
  await shot(tab, name, opts);
  await fetch(`http://127.0.0.1:${PORT}/json/close/${tab.id}`);
}

killChromeTree();
console.log('done');
