import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import icon from 'astro-icon';

export default defineConfig({
  site: 'https://azainl.github.io',
  integrations: [sitemap(), icon()],
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
  markdown: {
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
