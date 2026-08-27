/**
 * 悬浮返回按钮：右下角圆钮，样式不占用顶部栏，顶部栏布局恒定。
 * 仅非首页显示；有站内历史则返回上一路径，否则回首页。
 * 通过合成的站内链接触发客户端路由，保留页面切换动画。
 */
import './scrollPosition';

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
    let target: string | null = null;
    while (stack.length) {
      const candidate = stack.pop();
      if (candidate !== window.location.pathname + window.location.search) {
        target = candidate;
        break;
      }
    }
    writeStack(stack);
    if (target) {
      // 用合成的站内链接点击触发客户端路由，确保带页面切换动画
      const link = document.createElement('a');
      link.href = target;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
    } else {
      const home = document.querySelector('.wordmark') as HTMLAnchorElement | null;
      if (home) home.click();
      else window.location.href = '/';
    }
  });
}

// 客户端切换页面后，记录当前路径进栈（用于返回）并重新绑定按钮
document.addEventListener('astro:page-load', () => {
  recordCurrent();
  initBackButton();
});

export {};
