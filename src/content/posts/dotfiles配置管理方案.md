---
title: "我的 dotfiles 管理方案：一键同步终端配置"
description: "分享一套可跨 Windows、macOS 同步 PowerShell /zsh/ 编辑器配置的 dotfiles 管理思路，告别换电脑重配环境。"
date: 2026-08-04
tags: ["工具", "效率", "终端"]
---

换电脑、重装系统最麻烦的不是装软件，而是各类终端、编辑器、Shell 的配置文件。之前零散存配置，每次迁移都要复制粘贴，后来整理了一套 git 托管 dotfiles 的方案，全平台通用。

## 仓库结构设计

单独新建私有 git 仓库存放所有配置，目录分层区分系统：

```
dotfiles/
├── windows/     # PowerShell、Windows Terminal
├── mac/         # zsh、iTerm2
├── editor/      # VSCode settings、插件列表
└── scripts/     # 一键部署脚本
```

不直接软链接到系统目录，用部署脚本自动映射，避免污染仓库。

## Windows PowerShell 配置同步

核心脚本批量复制配置到 `Documents\WindowsPowerShell`，把之前文章里的批量重命名、端口查询命令全部封装成自定义函数。

```
# 示例自定义函数，存入 profile
function Find-LargestFile {
    Get-ChildItem -Recurse -File |
        Sort-Object Length -Descending |
        Select-Object -First 10 FullName, @{N='SizeMB'; E={[math]::Round($_.Length/1MB,1)}}
}
```

打开终端直接输入 `Find-LargestFile` 即可调用，不用每次复制长命令。

## VSCode 配置同步

导出插件清单，搭配 settings.json 统一托管：

```
# 导出已安装插件列表
code --list-extensions > editor/extensions.txt
# 新机器一键批量安装
cat editor/extensions.txt | xargs -L 1 code --install-extension
```

## 部署原则

1.配置与系统分离，所有自定义逻辑放进 dotfiles，不修改系统原生文件

2.脚本兼容多系统，自动判断 Windows/macOS 执行对应逻辑

3.定期提交更新，每次优化终端命令都同步到仓库

以后重装系统，拉取仓库运行部署脚本，五分钟恢复完整开发环境。
