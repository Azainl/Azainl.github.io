/**
 * 换页时的滚动位置守卫。
 *
 * 本项目有两个独立但同源的故障，都表现为「换页后视口被莫名拉到页面底部」：
 *
 * 1) 页脚带 `transition:persist`（见 Footer.astro），跨页保留在文档最底部。
 *    点页脚里的链接后，Astro 的 saveFocus/restoreFocus 会把焦点还给那个
 *    **仍留在文档最底部**的链接；浏览器为了保持聚焦元素可见，会在 router
 *    归零之后把视口重新拉到底。实测：任一页面点页脚「RSS 订阅」，100% 落在
 *    /subscribe/ 的最底部（y=832/832）。
 * 2) 键盘聚焦页面底部的翻页按钮后立刻按 Enter：浏览器为了让聚焦元素可见
 *    启动平滑滚动（html 上有 `scroll-behavior: smooth`），换页时动画还没跑完，
 *    残余动画在 router 的 scrollTo(0) 之后继续推进，把新页滚偏。
 *    实测：首页 → /page/2/ 落在 y=129（基线在 15–229 之间随机抖）。
 *
 * 对策分三段，各治一段：
 * - before-swap：取消 persist 容器内 activeElement 的焦点，让 restoreFocus
 *   无处可还（治 1）；
 * - focusin 捕获阶段：把**视口外**的聚焦元素用 behavior:'instant' 滚进来，
 *   提前把平滑动画消化掉，从根上不产生「动画与换页重叠」的竞态（治 2）；
 * - 换页窗口内（before-swap 后、page-load 后各一段时间）不响应 focusin，
 *   免得 restoreFocus 触发的 focusin 反过来又把视口滚下去。
 *
 * 为什么不直接删全局 `scroll-behavior: smooth`：归档页的年份跳转依赖它
 * （见 archive.astro 里对年份锚点的说明）。实测关掉后两条故障都会消失，
 * 但页内锚点的平滑滚动也一起没了，属于用错工具。
 */

// 换页窗口：这段时间内到达的 focusin 一律不处理。
// 1200ms 覆盖 before-swap → page-load 之间（含过渡动画）；
// 600ms 覆盖 page-load 之后 restoreFocus 与首帧布局的余波。
const SWAP_WINDOW_MS = 1200;
const LOAD_WINDOW_MS = 600;

// 页头与页脚都用 transition:persist，判据用属性而不是具体元素，
// 以后再加 persist 区块也自动覆盖。
const PERSIST_SELECTOR = '[data-astro-transition-persist]';

let quietUntil = 0;

// 监听器直接注册在模块作用域，不走 onPageLoad：
// document 跨换页是同一个对象，注册一次就够；
// 放进 onPageLoad 会每次换页再叠一份，越翻越重。
document.addEventListener('astro:before-swap', () => {
  quietUntil = performance.now() + SWAP_WINDOW_MS;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return;
  if (!active.closest(PERSIST_SELECTOR)) return;
  active.blur();
});

document.addEventListener('astro:page-load', () => {
  quietUntil = performance.now() + LOAD_WINDOW_MS;
});

function keepFocusVisible(event: FocusEvent): void {
  if (performance.now() < quietUntil) return;
  const el = event.target;
  if (!(el instanceof Element)) return;
  const rect = el.getBoundingClientRect();
  // 已在视口内：浏览器本来也不会滚，别做无谓的写入
  if (rect.top >= 0 && rect.bottom <= window.innerHeight) return;
  el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
}

document.addEventListener('focusin', keepFocusVisible, true);
