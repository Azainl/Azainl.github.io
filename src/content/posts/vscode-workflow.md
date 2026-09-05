---
title: "日常开发 VSCode 插件与工作流整理"
description: "前端、脚本写作通用 VSCode 配置，包含 Astro、Markdown、PowerShell 配套插件与高效操作习惯。"
date: 2026-08-07
tags: ["工具", "效率", "前端"]
---

日常写 Astro 博客、PowerShell 脚本、Markdown 笔记都依赖 VSCode，长期使用筛选出无冗余、真正提升效率的插件与操作习惯。

## 必备插件分类

### 博客 / Markdown 写作

1. Markdown All in One：目录、格式化、快捷键批量处理
2. Markdown Preview Enhanced：本地预览、表格自动格式化
3. Astro：官方语法高亮、自动补全、错误提示

### 脚本与终端

1. PowerShell：语法提示、脚本调试
2. EditorConfig：统一多项目缩进、换行规范

### 通用效率工具

1. Error Lens：行内直接展示报错，不用 hover 查看
2. Prettier：代码、Markdown 一键格式化

## 自定义快捷键优化

修改快捷键绑定，适配写作场景：

- `Ctrl + Shift + I` 全局格式化 Markdown 与代码
- 自定义一键插入文章 frontmatter 片段，新建文章不用手动复制模板

## 工作流习惯

1. 区分工作区：单独创建博客专属 VSCode 工作区，只加载 Astro 相关插件
2. 写作时关闭无关扩展，减少软件卡顿
3. 统一使用 Prettier 格式化规则，提交代码前自动格式化，避免格式冲突

## 配置托管

所有插件清单、settings.json 存入之前提到的 dotfiles，换设备一键恢复完整编码环境，不用逐个重新安装插件。
