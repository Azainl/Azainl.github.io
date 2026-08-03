/** 滚动进入视口时渐显（stagger），JS 不可用时内容保持可见 */
const elements = document.querySelectorAll('.reveal');

if (elements.length) {
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
    elements.forEach((el) => io.observe(el));
  } else {
    elements.forEach((el) => el.classList.add('is-visible'));
  }
}
