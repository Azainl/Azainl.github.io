---
title: "用 Vite 自带的构建产物分析定位包体积问题"
description: "不装额外插件也行，先用构建输出的模块体积清单定位大头，再决定怎么优。"
date: 2026-08-26
tags: ["前端", "性能优化"]
---

前端包体积膨胀，第一步不是盲目上各种优化，而是先搞清楚**体积都被谁占了**。Vite 构建时本来就会输出模块体积清单，从它入手最直接。

## 先看构建输出

```
npm run build
```

构建结束时，终端会列出产物的文件大小。一眼就能看出有没有异常大的 chunk。真正的"大头"往往是一两个库。

## 用可视化插件确认来源

想看得更清楚，可以临时加一个分析插件（`vite-plugin-visualizer` 或 `rollup-plugin-visualizer`），构建后生成一张看得到每个模块占比的可视化图。看清楚了再优化，避免瞎猜。

```js
// vite.config
import { visualizer } from 'rollup-plugin-visualizer';
export default {
  plugins: [visualizer({ gzipSize: true })],
};
```

## 常见的几个占体积主因

- 按需引入了其实没用的模块（`import * as lib` 变成 `import { use }`）
- 一个库的整包被打进来，其实只用了几个函数
- 重复打包：同一个库出现在不同 chunk 里

对应处理分别是改用具名导入、改用按需子路径、配置 `manualChunks` 或确认依赖版本去重。

## 优化后记得核验

> 优化的目标是让构建产物真正变小，而不是让分析图变好看。

改完重新构建，对比前后的总大小和首屏 chunk。数字下降，方向才对。

这套流程对静态站、单页应用都成立：先测量，再定位，最后才动手。
