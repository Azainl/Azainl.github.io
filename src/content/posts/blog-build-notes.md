---
title: "从零搭建这个博客：技术选型记录"
description: "本站从零搭建的完整记录：为什么选 Astro、内容集合怎么用、字体如何自托管、部署到哪。"
date: 2026-07-25
tags: ["前端", "Astro", "写作"]
---

这个博客是 2026 年 7 月从零搭起来的，从选型到上线大约花了一个周末。这篇记录一下做了哪些决定，以及为什么。

## 为什么是 Astro

个人博客的需求很明确：内容以 Markdown 为主，要求加载快、SEO 好、部署简单。比较过几个方案：

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| Astro | 纯静态输出、内容集合好用、几乎没有运行时 JS | 生态比 Next.js 小 |
| Next.js | 生态大、能力全面 | 对纯博客来说偏重 |
| Hexo / Hugo | 上手快、主题多 | 定制自由度低 |

最后选了 Astro。它的内容集合（Content Collections）对博客场景几乎是量身定做的，而且默认零 JS，性能起点很高。

## 内容集合

文章放在 `src/content/posts/` 下，每篇带 frontmatter，用 Zod 定义 schema 做校验：

```ts
// src/content.config.ts
import { defineCollection, z } from 'astro:content';

const posts = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

export const collections = { posts };
```

写错了日期格式、漏了字段，构建时会直接报错，不会带着坏数据上线。

## 字体自托管

英文用了两个可变字体：正文界面用 Geist，文章标题用 Source Serif 4，都通过 `@fontsource` 包自托管，不依赖 Google Fonts 的在线链接。中文字体体积太大，直接用系统字体栈回退，中文正文用 PingFang / 微软雅黑，标题在支持的系统上回退到宋体系列。

## 主题切换

深色模式用 CSS 自定义属性实现，`<html>` 上加一个 `dark` class 就切换整套令牌。为了防止刷新时闪白，主题初始化脚本放在 `<head>` 里同步执行，先读 `localStorage`，没有记录就跟随系统偏好。

## 部署

静态站点部署的选择非常多。Vercel、Netlify、Cloudflare Pages 都能一键识别 Astro 项目；GitHub Pages 也可以，用 Actions 构建后发布到 Pages。最终选了哪个平台，见 README 里的部署章节。

## 一些心得

从零搭建的好处是每一行样式都知道为什么存在，代价是要自己维护的东西多了不少。好在个人博客的页面类型有限，核心其实只有三个：首页的文章列表、文章详情页、关于页。把这三类页面的排版做扎实，站点就立住了。
