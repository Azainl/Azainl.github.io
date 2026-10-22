# Azain · 个人博客

一个基于 Astro 的个人博客：纯静态输出、零客户端框架、自带深色模式。

**功能一览**

| 类别 | 能力 |
|---|---|
| 内容 | 35 篇文章 · 12 个标签 · 1 个系列 · 4 个专题（人工编排的跨标签阅读线）· 归档页（按年月分组）· 修订记录（`updated`） |
| 发现 | 全站搜索（构建期索引）· 命令面板（`Ctrl/Cmd + K`）· 随机阅读 · 标签页 · 系列页 · 专题页 · 首页翻页 |
| 阅读 | 目录（滚动高亮 + 阅读进度）· 代码复制 · 阅读时长 · 上下篇 · 相关文章 · 打印样式 · 复制链接 / 系统分享 |
| 分发 | 主 RSS（全文只给最近 20 篇）· 12 个标签 + 1 个系列子 feed · JSON Feed 1.1 · sitemap · OG 卡片 · JSON-LD |
| 工程 | 413 条浏览器断言 · 5 道质量闸 · CI 全绿才部署 · 每日定时构建（让未来日期到点上线） |

> 📖 完整的操作文档见 [docs/操作文档.md](docs/操作文档.md)：
> 写文章、改配置、改设计、部署发布、常见问题全都有。
>
> 🧭 接手这个项目请先读 [docs/开发交接文档.md](docs/开发交接文档.md)：
> 现在是什么样、哪些坑不能踩、第一周该干什么。

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
description: "文章摘要，会显示在列表页、分享卡片和 SEO 元信息里"
date: 2026-08-03
tags: ["标签一", "标签二"]
draft: false
featured: false          # 可选：true 在列表里显示「推荐」角标（当前 3 篇；没有独立的精选区块）
updated: 2026-08-10      # 可选：最后修订日期，不能早于 date；填了会在文章页显示「更新于」，
                         # 并进入 sitemap lastmod / JSON-LD dateModified / RSS lastBuildDate
---

正文内容……
```

`draft: true` 的文章不会出现在生产站点上（**开发环境不过滤**，方便预览）。
日期格式错误或字段缺失时，构建会直接报错。

**关于日期语义**：`date` 按 **Asia/Shanghai** 解释，当天 00:00 起算（不是 UTC 零点）。
配合每日 00:10 的定时构建，写未来日期就等于**预约发布**。细节见
[docs/操作文档.md](docs/操作文档.md) 的「发布与定时」一节。

## 个性化修改

所有站点配置集中在一个文件里：[`src/consts.ts`](src/consts.ts)

- 站点名称、作者、简介、邮箱
- 部署后把 `astro.config.mjs` 的 `site` 改成真实域名（RSS、站点地图、canonical 都由它派生；`consts.ts` 里不再有 `url` 字段）
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

- [Astro](https://astro.build) 7 静态站点框架（`output: 'static'`，**无 adapter、无 SSR**）
- Content Collections 内容集合 + Zod 校验
- 自托管可变字体：Geist（界面）、Source Serif 4（正文与标题），两条 `preload` 实测优于按页面类型分化
- Phosphor 内联 SVG 图标（零字体请求）
- 手写 CSS 设计令牌，7 个分片，支持深浅两套主题 + 打印版式
- 客户端全部原生 TypeScript（6 个模块），**没有任何 UI 框架运行时**
- Shiki 代码高亮（深浅双主题）
- 部署：GitHub Actions → GitHub Pages（`netlify.toml` / `vercel.json` 是历史遗留，未使用）

## 质量门禁

```bash
npm run typecheck   # tsc 类型检查
npm run test:unit   # node:test 单元测试（发布时间语义等纯函数）
npm run build       # 构建 62 个真实页
npm run preview     # 起本地预览（check 必须先起 preview）
npm run check       # 413 条浏览器断言（约 2 分钟）
```

新增断言**必须先做故障注入**（人为破坏 `dist/` 产物，确认由绿转红、FAIL 精确落在注入点，再恢复并复跑）
——不做这一步的断言可能永远为真。见 [docs/开发交接文档.md](docs/开发交接文档.md) §6.3。
