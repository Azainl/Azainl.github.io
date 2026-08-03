---
title: "自定义 Astro RSS：完善摘要、标签、阅读友好订阅源"
description: "修改博客 rss.xml 模板，实现完整文章摘要、标签分类、发布时间格式化，适配各类阅读器。"
date: 2026-08-06
tags: ["Astro", "写作", "SEO"]
---

Astro 自带简易 RSS 生成，但默认输出内容简陋，阅读器显示体验差。本文记录如何自定义 RSS 模板，打造完整可用的订阅源。

## 默认 RSS 的痛点

1. 仅输出文章标题链接，无 description 摘要
2. 标签、发布时间格式不统一
3. 缺少作者、站点简介等基础元数据
4. 不支持部分 RSS 阅读器的封面展示

## 自定义 rss.xml 模板实现

在项目根目录新建 `src/pages/rss.xml.astro`，读取 posts 内容集合批量生成条目：

```astro
import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
export async function GET(context) {
  const posts = await getCollection('posts', p => !p.data.draft);
  return rss({
    title: '山月 | 个人博客',
    description: '技术笔记、读书笔记与随笔记录',
    site: context.site,
    items: posts.map(post => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.date,
      tags: post.data.tags,
      link: `/posts/${post.slug}/`,
    })),
  });
}
```

## 阅读器适配优化

1. 摘要完整复用 frontmatter 的 description，不截取正文
2. 时间统一转为标准 RFC-2822 格式，解决时区错乱
3. 填充站点简介、作者信息，Feedly、Inoreader 识别更完整
4. 过滤 draft: true 的草稿文章，不会出现在订阅流

## 使用与更新

构建时自动重新生成 `/rss.xml`，无需手动维护；每发布一篇新文章，订阅源会同步更新。博客首页、文章底部放置订阅链接，方便读者一键关注。
