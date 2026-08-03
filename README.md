# 山月 · 个人博客

一个基于 Astro 的个人博客：纯静态输出、零运行时 JS、自带深色模式、RSS 与站点地图。

## 本地开发

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # 输出到 dist/
npm run preview  # 预览构建结果
```

## 写文章

在 `src/content/posts/` 下新建一个 Markdown 文件即可，frontmatter 格式：

```md
---
title: "文章标题"
description: "文章摘要，会显示在列表页和 SEO 元信息里"
date: 2026-08-03
tags: ["标签一", "标签二"]
draft: false
---

正文内容……
```

`draft: true` 的文章不会出现在站点上。日期格式错误或字段缺失时，构建会直接报错。

## 个性化修改

所有站点配置集中在一个文件里：[`src/consts.ts`](src/consts.ts)

- 站点名称、作者、简介、邮箱
- 部署后把 `url` 改成真实域名（影响 RSS 和站点地图）
- 站点名称同时在 [`src/components/Header.astro`](src/components/Header.astro) 的 wordmark 里
- 页面里的示例内容（关于页、示例文章）按需替换

## 部署

项目已内置三套部署配置：

### Vercel（推荐，最快）

```bash
npm i -g vercel
vercel login
vercel --prod
```

自动识别 Astro 项目，无需额外配置。

### Netlify

导入仓库时构建命令填 `npm run build`，发布目录填 `dist`（已写入 `netlify.toml`）。

### GitHub Pages

1. 把项目推到 GitHub 仓库（建议仓库名即站点名）；
2. 仓库 Settings → Pages → Source 选 **GitHub Actions**；
3. 推送 `main` 分支即自动构建发布（已内置 `.github/workflows/deploy.yml`）。

> 注意：GitHub Pages 的项目站点运行在 `/仓库名/` 子路径下，需要在
> `astro.config.mjs` 里补 `base: '/仓库名/'`；用户名站点（`用户名.github.io`）则不需要。

## 技术栈

- [Astro](https://astro.build) 静态站点框架
- Content Collections 内容集合 + Zod 校验
- 自托管可变字体：Geist（界面）、Source Serif 4（标题）
- Phosphor Icons 图标
- 手写 CSS 设计令牌，支持深浅两套主题
