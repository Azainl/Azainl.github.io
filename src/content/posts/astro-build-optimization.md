---
title: "Astro 静态博客的几处构建优化"
description: "从首屏到全站，记录我对这个博客做的几处提速：字体子集、按需图标、滚动位置交给框架。"
date: 2026-08-12
tags: ["Astro", "性能优化"]
---

这个博客是纯静态的，没有后端，理论上应该很快。但"快"从来不靠理论，靠的是把每一个多余字节都抠掉。

## 字体：只引拉丁子集

博客的界面字体和标题字体用的都是可变字体，一个文件可能上兆。如果整包下载，对首屏是很大负担。

做法是在 `BaseLayout` 里只引入拉丁子集的可变字体，中文交给系统字体回退：

```js
import geistUrl from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url';
```

内联 `@font-face` 并预加载，避免首屏字体跳动（FOUT）。

## 图标：换成按需内联

早期我用一个集中式的图标组件，把用到的 SVG 全部打包进了页面。后来换成 astro-icon，把图标文件放进 `src/icons/`，由它构建时只内联实际用到的那个：

```jsx
<Icon name="magnifying-glass" />
```

页面上有几枚图标，就打几次内联，不再一锅端。图标是 `currentColor`，深浅主题下自动跟随文字颜色。

## 滚动位置：交给框架

页面切换的滚动恢复，我一度自己用 `sessionStorage` 记滚动位置，结果在翻页场景里和 View Transitions 的机制打架，出现返回回不到原位置的 bug。

后来想明白：Astro 的 View Transitions 本身就靠 `history.state` 保存滚动，我只要保证**翻页时不清空 state** 就好。

```js
history.replaceState(
  { ...(history.state ?? {}), scrollX: window.scrollX, scrollY: window.scrollY },
  '',
  url,
);
```

原则：框架已经做好的事，别自己再造一套。

## 小结

优化这个静态博客，最有效的不一定是某个大招，而是几处小事的叠加：更少的字体、按需的图标、不重复实现的滚动。每一处节省都是首屏时间的净收益。
