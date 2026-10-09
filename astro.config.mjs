import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import icon from 'astro-icon';
import { readdirSync, readFileSync } from 'node:fs';
import { satteri } from '@astrojs/markdown-satteri';
import markdownImageSizes from './plugins/markdown-image-sizes.mjs';

/**
 * 构建期读一遍文章的 frontmatter，给 sitemap 提供 `lastmod`。
 *
 * 为什么要在这里读文件：`@astrojs/sitemap` 的 `serialize` 在配置加载期就要
 * 拿到日期，而 Content Collections 要等 Astro 运行时才有。这里只解析
 * frontmatter 里的 date / updated / tags 三个字段，够用且不必引入运行时依赖。
 */
function readPosts() {
  const dir = new URL('./src/content/posts/', import.meta.url);
  const posts = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const text = readFileSync(new URL(name, dir), 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
    const pick = (key) =>
      new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, 'm').exec(fm)?.[1] ?? '';
    // 有 updated 就用 updated —— 与文章页「更新于」、RSS lastBuildDate 同一口径
    const date = pick('updated') || pick('date');
    if (!date) continue;
    let tags = [];
    try {
      tags = JSON.parse(pick('tags') || '[]');
    } catch {}
    posts.push({ slug: name.replace(/\.md$/, ''), date, tags });
  }
  return posts;
}

/** 标签名 → slug 映射（与 src/data/tags.ts 保持同源；这里只做正则提取，不 import .ts） */
function readTagSlugs() {
  const src = readFileSync(new URL('./src/data/tags.ts', import.meta.url), 'utf8');
  const map = new Map();
  for (const m of src.matchAll(/\{\s*name:\s*'([^']+)',\s*slug:\s*'([^']+)'/g)) {
    map.set(m[2], m[1]); // slug -> 展示名
  }
  return map;
}

const POSTS = readPosts();
const TAG_SLUGS = readTagSlugs();
const NEWEST = POSTS.reduce((acc, p) => (p.date > acc ? p.date : acc), '');

/** 某标签下最新一篇的日期 */
function newestForTag(name) {
  return POSTS.filter((p) => p.tags.includes(name)).reduce(
    (acc, p) => (p.date > acc ? p.date : acc),
    '',
  );
}

export default defineConfig({
  site: 'https://azainl.github.io',
  integrations: [
    sitemap({
      // noindex 的页面不该同时出现在 sitemap 里 —— 那是自相矛盾的信号。
      // 目前只有站内搜索页：它是工具而非内容，初始状态下没有独有信息。
      filter: (page) => !page.endsWith('/search/'),
      // 不输出 lastmod 的话，搜索引擎无法判断页面新鲜度 —— 而我们明明有每篇的
      // date / updated。这里按页面类型分别给：文章用自身日期，列表类用最新文章日期，
      // 关于页/搜索页没有可靠的时间语义，就不给（宁可缺，也不要给假的）。
      serialize(item) {
        const path = new URL(item.url).pathname;
        let lastmod;

        const post = POSTS.find((p) => path === `/posts/${p.slug}/`);
        if (post) lastmod = post.date;
        else if (path === '/' || path === '/tags/' || /^\/page\/\d+\/$/.test(path)) lastmod = NEWEST;
        else {
          const tag = /^\/tags\/([^/]+)\/$/.exec(path);
          if (tag && TAG_SLUGS.has(tag[1])) lastmod = newestForTag(TAG_SLUGS.get(tag[1]));
        }

        if (lastmod) item.lastmod = lastmod;
        return item;
      },
    }),
    icon(),
  ],
  // 旧的文章 URL（汉字/空格文件名）重定向到新的 kebab-case 文件名，避免已发出的 RSS / 外链 404
  redirects: {
    '/posts/Astro 博客图片优化实践/': '/posts/astro-image-optimization/',
    '/posts/RSS 订阅文件自定义配置/': '/posts/rss-customization/',
    '/posts/VSCode 高效编码习惯与插件清单/': '/posts/vscode-workflow/',
    '/posts/dotfiles配置管理方案/': '/posts/dotfiles-management/',
    '/posts/博客草稿管理与发布流程规范/': '/posts/draft-publish-workflow/',
    // 标签 URL 从中文原文改成英文 slug
    '/tags/前端/': '/tags/frontend/',
    '/tags/效率/': '/tags/productivity/',
    '/tags/工具/': '/tags/tools/',
    '/tags/写作/': '/tags/writing/',
    '/tags/性能优化/': '/tags/performance/',
    '/tags/思考/': '/tags/thinking/',
    '/tags/随笔/': '/tags/essays/',
    '/tags/阅读/': '/tags/reading/',
    '/tags/终端/': '/tags/terminal/',
    '/tags/流程规范/': '/tags/workflow/',
    // 注意：不要为「仅大小写不同」的 ASCII 标签（Astro→astro、SEO→seo）加重定向。
    // 在大小写不敏感的文件系统（Windows / macOS 默认）上，旧路径 /tags/Astro/ 与
    // 新路径 /tags/astro/ 是同一个文件，重定向桩会覆盖真实标签页，
    // 结果访问时自我重定向、无限刷新且没有内容。这两个 URL 从未对外发布，直接废弃。
  },
  prefetch: {
    // 只预取进入视口的链接：文章多时不会在首页把全站都拉一遍
    prefetchAll: true,
    defaultStrategy: 'viewport',
  },
  image: {
    // 正文图最大显示宽度是 36rem = 576px（见 pages.css 的 .prose img），
    // 而原图是 1152px —— 1x 屏白下了一倍的字节。constrained 会按布局生成
    // srcset/sizes，让不同 DPR 与视口各取所需；responsiveStyles 注入配套 CSS。
    layout: 'constrained',
    responsiveStyles: true,
    // 只输出 webp：avif 需另装 @astrojs/… 才能进响应式集合，且体积优势有限
    // （实测 46.2 KB → webp 31.1 / avif 20.2，但要付出构建时间与兼容成本）
    // 需要时可加 'avif'，astro 会自动生成 <picture> 回退链。
  },
  markdown: {
    // Markdown 图片的 sizes 默认按原图宽度生成，与 CSS 的 36rem 上限不符，
    // 会让桌面端白下约一倍字节。用 Sätteri 的原生 hastPlugin 改成真实显示宽度
    //（不能用 markdown.rehypePlugins —— 那会要求装回 @astrojs/markdown-remark
    //  并把整个处理器退回 unified，见插件内注释）。
    processor: satteri({ hastPlugins: [markdownImageSizes()] }),
    shikiConfig: {
      // 注意：双主题的键名是 themes（复数）；写成 theme 会静默回退到 Shiki 默认主题
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
      // 关掉 Shiki 默认的 prefers-color-scheme 输出，改由 global.css 里的
      // .dark 类驱动（本站主题是手动切换的，跟系统偏好不一定一致）
      defaultColor: false,
      // 长代码换行，避免移动端横向滚动
      wrap: true,
    },
  },
});
