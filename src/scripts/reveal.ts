/** 滚动进入视口时渐显（stagger），JS 不可用时内容保持可见 */
import { onPageLoad } from './lifecycle';

function initReveal() {
  const elements = [...document.querySelectorAll('.reveal:not(.is-visible)')];
  if (!elements.length) return;

  // 已在视口内的元素立即显示，避免页面切换时内容空白
  const visible: Element[] = [];
  const rest: Element[] = [];
  for (const el of elements) {
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) visible.push(el);
    else rest.push(el);
  }
  visible.forEach((el) => el.classList.add('is-visible'));

  if (!rest.length) return;
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' },
    );
    rest.forEach((el) => io.observe(el));
  } else {
    rest.forEach((el) => el.classList.add('is-visible'));
  }
}

onPageLoad(initReveal);
