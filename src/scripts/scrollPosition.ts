/**
 * 滚动位置记忆：记录离开每个路径时的滚动位置，
 * 重新进入该路径时（例如从文章返回首页）恢复到原位置，
 * 实现"从哪来回到哪去"。
 */
const SESSION_KEY = 'blog-scroll-positions';

function readAll(): Record<string, number> {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, number>): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(map));
  } catch {
    /* 忽略配额/存储不可用 */
  }
}

const currentPath = () => window.location.pathname + window.location.search;

// 导航动画开始前，把当前滚动位置记到当前路径名下
document.addEventListener('astro:before-preparation', () => {
  const y = window.scrollY;
  if (y > 0) {
    const map = readAll();
    map[currentPath()] = y;
    writeAll(map);
  }
});

// 页面就绪后，恢复目标路径上次离开时的位置
document.addEventListener('astro:page-load', () => {
  const key = currentPath();
  const map = readAll();
  const y = map[key];
  if (typeof y === 'number' && y > 0) {
    delete map[key];
    writeAll(map);
    // 等首帧渲染完成后再滚动，保证目标元素/高度已就位
    requestAnimationFrame(() => {
      window.scrollTo(0, y);
    });
  }
});
