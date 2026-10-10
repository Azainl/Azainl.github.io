/**
 * 文章页标题上方的返回按钮：回到**来源页面**，而不是浏览器历史的上一条条目。
 *
 * 问题背景
 * --------
 * 正文目录（TOC）的锚点链接会让浏览器压入**同页的新历史条目**（仅 hash 不同）。
 * 实测：文章页 index=1，点两个目录锚点后 index 增到 3、history.length 由 3 增至 5。
 * 此时 history.back() 只退**一条**，落在上一个锚点（正文中间），表现为
 * 「点过目录再返回，回到了点目录时的位置」—— 违背常规返回语义。
 *
 * 判定依据
 * --------
 * Astro 的客户端路由在 history.state 上维护了**单调递增**的 index
 * （router.js: `index: ++currentHistoryIndex`，并据此判定 forward/back）。
 * 本页加载时记下自己的条目索引 indexAtLoad，点击返回时按它推算步长：
 *
 *   · indexAtLoad <= 0 → 本页是该标签页的第一个条目，**没有来源页** → 回首页
 *     （直接打开文章 URL 就属于这种情况；不依赖 sessionStorage 是否被污染）
 *   · 否则来源页条目在本页条目之下一条，即 indexAtLoad - 1，
 *     故 hops = indexNow - (indexAtLoad - 1)；无锚点跳转时 hops = 1，
 *     与原来的 history.back() 等价。
 *
 * index 不可用时（例如 View Transitions 被禁用）退回站内路径栈判断。
 */
// 站内返回栈：仅在 history 索引不可用时作为兜底
import { isHome, url } from '../utils/url';
import { onPageLoad } from './lifecycle';

const STACK_KEY = 'blog-back-stack';
const MAX_STACK = 20;

/**
 * 本次页面加载时所在的 history 条目索引（本页自己的条目）。
 * 只在 astro:page-load 刷新；同页锚点跳转不触发该事件，
 * 因此它始终标记"本页顶层条目"，不会被锚点跳转带偏。
 */
let indexAtLoad: number | null = null;

/** 读取 Astro 写在 history.state 上的单调索引（不存在时返回 null） */
function readHistoryIndex(): number | null {
  const state = window.history.state as { index?: unknown } | null;
  const index = state?.index;
  return typeof index === 'number' && Number.isFinite(index) ? index : null;
}

function readStack(): string[] {
  try {
    const raw = sessionStorage.getItem(STACK_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function writeStack(stack: string[]): void {
  try {
    sessionStorage.setItem(STACK_KEY, JSON.stringify(stack.slice(-MAX_STACK)));
  } catch {}
}

function recordCurrent(): void {
  const path = window.location.pathname + window.location.search;
  const stack = readStack();
  if (stack[stack.length - 1] !== path) {
    stack.push(path);
    writeStack(stack);
  }
}

/** 回首页：优先点刊头链接，走客户端路由与过渡 */
function goHome(): void {
  const home = document.querySelector('.wordmark') as HTMLAnchorElement | null;
  if (home) home.click();
  else window.location.href = url('/');
}

/**
 * 回到来源页。
 * @returns true  = 已按索引跨过同页锚点条目
 *          false = 索引不可用，调用方需自行决定兜底方式
 */
function goBackToSource(): boolean {
  const indexNow = readHistoryIndex();
  if (indexNow === null || indexAtLoad === null) return false;

  // 本页是标签页的第一个条目 → 没有来源页
  if (indexAtLoad <= 0) {
    goHome();
    return true;
  }

  // 来源页条目 = 本页条目之下一条
  const hops = indexNow - indexAtLoad + 1;
  if (hops > 1) {
    // 一次跨过所有同页锚点条目，直接回到来源页
    window.history.go(-hops);
  } else {
    // 无锚点跳转（或索引异常回退），等价于原来的行为
    window.history.back();
  }
  return true;
}

// 每次页面就绪后：记录路径、绑定返回按钮
function initBackButton(): void {
  const btn = document.getElementById('back-button');
  if (!btn || btn.dataset.inited) return;
  btn.dataset.inited = 'true';

  // 首页不显示返回按钮（回到站点根时没有上一层）
  btn.hidden = isHome(window.location.pathname);

  btn.addEventListener('click', () => {
    if (goBackToSource()) return;

    // 兜底：索引不可用时按站内路径栈判断是否存在来源页
    const stack = readStack();
    const cur = window.location.pathname + window.location.search;
    if (stack.some((p) => p !== cur)) {
      window.history.back();
      return;
    }
    goHome();
  });
}

// 客户端切换页面后，记录当前路径进栈（用于兜底判断）并重新绑定按钮
onPageLoad(() => {
  recordCurrent();
  // 换页后 history.state 已指向本页条目，此时读取才准确
  indexAtLoad = readHistoryIndex();
  initBackButton();
});
