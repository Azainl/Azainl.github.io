/**
 * 换页时的滚动位置守卫。
 *
 * 本项目有三个独立但同源的故障，都表现为「换页后视口被莫名拉到页面底部」：
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
 * 3) 同上，但焦点在任何**非** persist 容器里的链接上——只要点击那一刻
 *    页面上有平滑滚动动画在飞（滚到底后点页头品牌、点首页主题标签、
 *    点文章里的标签……都算），偏移量就会在 `astro:page-load` **之后**
 *    的一帧才落下来。实测时间线（/posts/docs-for-strangers/ 滚到底后点
 *    .wordmark）：before-swap 内 router 已 scrollTo(0)，page-load 时 y=0，
 *    再过 9ms 的下一帧变成 y=104，且不是任何脚本发出的 scrollTo。
 *    已排除的猜想：html 上的 smooth（关掉仍偏）、overflow-anchor
 *    滚动锚定（关掉仍偏）、before-swap 里提前取消动画（仍偏）。
 *
 * 对策分三段，各治一段：
 * - before-swap：取消 persist 容器内 activeElement 的焦点，让 restoreFocus
 *   无处可还（治 1）；
 * - focusin 捕获阶段：把**视口外**的聚焦元素用 behavior:'instant' 滚进来，
 *   提前把平滑动画消化掉，从根上少产生「动画与换页重叠」的竞态（治 2）；
 * - page-load 之后：对「跨页 push/replace 且目标无 hash」的导航，在随后
 *   两帧内把 scrollY 钳回 0（治 3，也是治 2 的兜底——动画一旦真的飞起来，
 *   blur 与 instant 滚入都拦不住残余量）。
 *
 * 为什么不直接删全局 `scroll-behavior: smooth`：归档页的年份跳转依赖它
 * （见 archive.astro 里对年份锚点的说明）。实测关掉后故障 1、2 都会消失，
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

// page-load 之后钳制几帧。偏移实测落在 page-load 的下一帧（+9ms），
// 两帧足够覆盖，又不至于和用户真正的滚动抢控制权。
const CLAMP_FRAMES = 2;

let quietUntil = 0;

// 本次导航的性质，在 before-swap 里记下、page-load 里消费。
// 不能用 page-load 的事件对象：那几个事件只有 isTrusted，没有 detail。
let pendingNav: { traverse: boolean; hash: string } | null = null;

// 监听器直接注册在模块作用域，不走 onPageLoad：
// document 跨换页是同一个对象，注册一次就够；
// 放进 onPageLoad 会每次换页再叠一份，越翻越重。
document.addEventListener('astro:before-swap', (event) => {
  quietUntil = performance.now() + SWAP_WINDOW_MS;

  // 前进/后退要保留 history.state 里的滚动位置（router 会照着还原），
  // 跨页带锚点（如 /archive/#2026）目标是那个锚点——这两种都不能钳。
  pendingNav = {
    traverse: event.navigationType === 'traverse',
    hash: event.to.hash,
  };

  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return;
  if (!active.closest(PERSIST_SELECTOR)) return;
  active.blur();
});

document.addEventListener('astro:page-load', () => {
  quietUntil = performance.now() + LOAD_WINDOW_MS;

  const nav = pendingNav;
  pendingNav = null;
  // 首次加载（整页加载）没有 before-swap，不该动它
  if (!nav || nav.traverse || nav.hash) return;

  // 偏移在 page-load 之后的一帧才落下来，用 rAF 追两帧把它钉住。
  // 这里只写 scrollTo，不碰焦点，避免和 restoreFocus 打架。
  let frames = 0;
  const clamp = (): void => {
    if (window.scrollY !== 0) {
      window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
    }
    frames += 1;
    if (frames < CLAMP_FRAMES) requestAnimationFrame(clamp);
  };
  requestAnimationFrame(clamp);
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
