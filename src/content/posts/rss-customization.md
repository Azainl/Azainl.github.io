---
title: "自定义 Astro RSS：让订阅源更完整"
description: "博客的 rss.xml 是怎么生成的：完整摘要、标签分类、标准时间格式，以及构建时自动更新。"
date: 2026-08-06
tags: ["Astro", "写作", "SEO"]
---

Astro 自带 `@astrojs/rss`，默认就能生成订阅源，但开箱即用的输出偏简陋。这个站点在它基础上补了几处，让主流阅读器（Feedly、Inoreader 等）的体验更完整。

## 生成逻辑

RSS 在 `src/pages/rss.xml.js` 里，读取"已发布"文章集合后逐条生成条目：

```js
import rss from '@astrojs/rss';
import { SITE } from '../consts';
import { getPublishedPosts } from '../utils/posts';

export async function GET(context) {
  const posts = await getPublishedPosts();
  return rss({
    title: SITE.title,
    description: SITE.description,
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      pubDate: post.data.date,
      description: post.data.description,
      link: new URL(`/posts/${post.slug}/`, context.site).href,
      categories: post.data.tags,
    })),
    customData: '<language>zh-cn</language>',
    lastBuildDate: new Date(),
  });
}
```

## 几处关键处理

- **链接用绝对地址**。`new URL('/posts/.../', context.site)` 拼出完整 URL，避免阅读器里点不开。
- **标签进 `categories`**。这样阅读器能按标签归类，和文章 frontmatter 的 `tags` 对齐。
- **时区与语言**。`pubDate` 直接用 frontmatter 的 `date`（已是固定时区的 `Date`），再补 `<language>zh-cn</language>` 和 `lastBuildDate`，显示更稳。
- **只发已发布文章**。`getPublishedPosts` 会过滤掉 `draft` 和未来日期的文章，草稿不会泄露进订阅流。

## 自动更新

构建时 `rss.xml.js` 自动重新生成，不需要手动维护。每发布一篇新文章，订阅源跟着更新。首页和文章页底部都放了订阅入口，读者一键就能关注。
