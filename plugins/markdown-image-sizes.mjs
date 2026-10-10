/**
 * 给 Markdown 里的图片补一个**正确的 sizes**。
 *
 * 为什么需要：Astro 的 `image.layout: 'constrained'` 生成的 sizes 是
 * `(min-width: {原图宽}px) {原图宽}px, 100vw` —— 用的是**图片自身的像素宽度**。
 * 但本站正文图在 CSS 里被限制为 `max-width: min(100%, 36rem)`，
 * 桌面端实际只显示 **576px**（36rem × 16px）。于是 DPR1 的桌面浏览器
 * 按 sizes 判断需要 1152px，白下了约 2 倍的字节。
 *
 * 实测（checks-1.jpg，原图 1152×648 → webp）：
 *   srcset 各档  640w→15.4KB  750w→18.6KB  828w→21.1KB  1080w→28.2KB  1152w→31.1KB
 *   修好之前 DPR1 桌面（display 576px）取 1152w = 31.1 KB
 *   修好之后应取 828w ≈ 21.1 KB（576 × 1.44 的取整档）
 *
 * 为什么是 satteri hastPlugin 而不是 markdown.rehypePlugins：
 * Astro 7 的默认 Markdown 处理器是 Sätteri，而 `markdown.rehypePlugins` 走
 * `@astrojs/markdown-remark` 的 unified 通路 —— 用它就得装回那个包并**把整个
 * 处理器退回 unified**，代价过大。Sätteri 原生支持 hastPlugins，且用户的插件
 * 排在 Astro 自己的 `image-marker` **之前**执行，所以在这里写的 sizes 会被
 * image-marker 一并收进 `__ASTRO_IMAGE_` 标记、最终传给 getImage()，
 * 从而覆盖掉 Astro 按原图宽度算出的默认值（其内部是 `sizes ||= ...`）。
 *
 * ⚠️ 36rem 来自 `src/styles/pages.css` 的 `.prose img`，改那里时要同步这里。
 */
const MAX_DISPLAY_PX = 36 * 16; // 576px

export default function markdownImageSizes() {
  // 每篇正文只把**第一张**图设为即时加载（LCP 候选），其余保持懒加载。
  //
  // 计数必须按**文档**重置。曾经用工厂闭包里的计数器，结果整次构建只认第一篇
  // ——「第一张图」变成"全站第一张图"（实测只有 cli-find-with-rg-fzf 生效）。
  // Sätteri 的 `before` 钩子每次编译运行一次，正好是文档边界，故在那里清零。
  let seenImages = 0;

  return {
    name: 'markdown-image-sizes',
    before() {
      seenImages = 0;
    },
    element: {
      filter: ['img'],
      visit(node, ctx) {
        const props = node.properties ?? {};
        const isFirst = seenImages === 0;
        seenImages += 1;

        // 只补、不覆盖：作者显式写了 sizes 就尊重作者
        if (!props.sizes) {
          ctx.setProperty(
            node,
            'sizes',
            `(min-width: ${MAX_DISPLAY_PX}px) ${MAX_DISPLAY_PX}px, 100vw`,
          );
        }

        // 首图：立即加载并抬高抓取优先级，让它能成为 LCP 元素。
        //
        // 必须用 Astro 自己的 `priority` 开关，不能直接写 loading/fetchpriority：
        // 实测直接写会被图片管线忽略（基线里 loading 恒为 lazy）。
        // astro/dist/assets/internal.js:
        //   if (resolvedOptions.priority) { loading ??= 'eager'; decoding ??= 'sync'; fetchpriority ??= 'high' }
        // width/height 与 srcset 由 image-marker 负责，不受影响，故 CLS 不回退。
        if (isFirst) {
          ctx.setProperty(node, 'priority', true);
        }
      },
    },
  };
}
