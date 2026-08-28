/**
 * 文章页标题上方的返回按钮：点击走 history.back()（浏览器历史），让 Astro 的
 * View Transitions 恢复原滚动位置并以 back 方向运行动画 —— "从哪来回哪去"。
 */
// 站内返回栈：记录每次访问的路径，返回按钮据此导航
const STACK_KEY = 'blog-back-stack';
const MAX_STACK = 20;

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

// 每次页面就绪后：记录路径、绑定返回按钮
function initBackButton(): void {
  const btn = document.getElementById('back-button');
  if (!btn || btn.dataset.inited) return;
  btn.dataset.inited = 'true';

  // 首页不显示返回按钮（回到站点根时没有上一层）
  btn.hidden = window.location.pathname === '/';

  btn.addEventListener('click', () => {
    const stack = readStack();
    const cur = window.location.pathname + window.location.search;
    // 存在可返回的站内上一条路径时，用 history.back() 走浏览器历史：
    // Astro 的 View Transitions 会据此恢复原滚动位置并以 back 方向运行动画。
    const hasBackTarget = stack.some((p) => p !== cur);
    if (hasBackTarget) {
      window.history.back();
      return;
    }
    // 无站内历史（例如直接进入文章页）：回首页
    const home = document.querySelector('.wordmark') as HTMLAnchorElement | null;
    if (home) home.click();
    else window.location.href = '/';
  });
}

// 客户端切换页面后，记录当前路径进栈（用于返回）并重新绑定按钮
document.addEventListener('astro:page-load', () => {
  recordCurrent();
  initBackButton();
});

export {};
