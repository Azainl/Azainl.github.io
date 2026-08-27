/**
 * 悬浮返回按钮：右下角圆钮，样式不占用顶部栏，顶部栏布局恒定。
 * 仅非首页显示；点击走 history.back()（浏览器历史），让 Astro 的 View
 * Transitions 恢复原滚动位置并以 back 方向运行动画，真正"从哪来回哪去"。
 *
 * 滚动位置的"从哪来回哪去"由 Astro 自带的 View Transitions 滚动保留
 * （history.state.scrollX/scrollY）负责，这里不再需要手动保存/恢复。
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

// 每次页面就绪后：记录路径、绑定悬浮按钮
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
