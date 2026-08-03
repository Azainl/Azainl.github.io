// 临时验证脚本：用无头 Chrome + CDP 截取页面，支持浅色/深色与移动端视口。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const CHROME =
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:4321';
const PORT = 9222;
const OUT = 'D:/Code/blog/.shots';

mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=D:/Code/blog/.chrome-tmp',
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

chrome.kill();
console.log('done');
