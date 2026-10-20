/**
 * 页脚「随便看看」：点击时才拉取文章清单，随机打开一篇。
 *
 * 三条约束：
 * 1. **不在加载时请求** —— 大多数访问不会点它，预取只是白花一次请求；
 * 2. **不跳回当前页** —— 在文章页上点「随便看看」却原地不动，会像坏了；
 * 3. **任何一步失败都回归档页** —— 链接的 href 本来就是 /archive/，
 *    这里只是用 JS 升级体验，不能把无 JS 的退路弄丢。
 *
 * 页脚带 transition:persist，模块只会在首次加载时执行一次，
 * 监听器因此能跨页面保留；dataset.ready 仍作防重复绑定的保险。
 */
import { navigate } from 'astro:transitions/client';
import { onPageLoad } from './lifecycle';

interface RandomPost {
  id: string;
  title: string;
  href: string;
}

let cache: RandomPost[] | null = null;
let pending: Promise<RandomPost[]> | null = null;

function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

async function loadPosts(src: string): Promise<RandomPost[]> {
  if (cache) return cache;
  if (!pending) {
    pending = fetch(src, { headers: { Accept: 'application/json' } })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<unknown>;
      })
      .then((data) => {
        if (!Array.isArray(data)) throw new Error('invalid payload');
        cache = data as RandomPost[];
        return cache;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

async function openRandom(link: HTMLAnchorElement): Promise<void> {
  const fallback = link.href;
  const src = link.dataset.randomSrc;
  if (!src) {
    window.location.assign(fallback);
    return;
  }

  try {
    const posts = await loadPosts(src);
    const current = normalizePath(window.location.pathname);
    const pool = posts.filter((post) => {
      try {
        return normalizePath(new URL(post.href, window.location.origin).pathname) !== current;
      } catch {
        return false;
      }
    });
    if (!pool.length) throw new Error('empty pool');

    const target = pool[Math.floor(Math.random() * pool.length)];
    try {
      await navigate(target.href);
    } catch {
      window.location.assign(target.href);
    }
  } catch {
    // 清单拉不到、格式不对或没有别的文章：退回无 JS 时的归档页
    window.location.assign(fallback);
  }
}

function initRandomPost(): void {
  const link = document.querySelector<HTMLAnchorElement>('[data-random-post]');
  if (!link || link.dataset.ready) return;
  link.dataset.ready = '1';

  link.addEventListener('click', (event) => {
    // 修饰键 / 中键是「新标签打开」的明确意图，交还浏览器
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void openRandom(link);
  });
}

onPageLoad(initRandomPost);
