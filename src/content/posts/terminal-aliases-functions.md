---
title: "终端里的效率，从少量别名和函数开始"
description: "别急着武装到牙齿，先给最高频的几个操作加别名。几个我在 PowerShell 里每天用的片段。"
date: 2026-08-18
tags: ["终端", "效率"]
---

很多人的终端配置很豪华，但也有人跟我一样，只想让每天敲几百次的几个操作更省事。别名和简单函数就够了。

## 给最高频命令加别名

先统计自己每天在敲什么，再给它们加别名。别一次加五十个，用不上几个反而记不住。

```powershell
Set-Alias ll  Get-ChildItem
Set-Alias gs  git status
Set-Alias ga  git add
Set-Alias gc  git commit
```

别名记不住也是一种浪费，宁可少而精。

## 写成一个函数而非多行命令

当一件事需要两条以上命令组合，就封装成一个函数，放进 profile：

```powershell
function Find-PortProcess($port) {
  Get-NetTCPConnection -LocalPort $port -State Listen |
    ForEach-Object { Get-Process -Id $_.OwningProcess }
}
```

之后输入 `Find-PortProcess 3000`，一次调用，省去每次回忆那条长命令。

## 少打字 vs 好记忆

> 别名省的是每次敲击，函数省的是每次回忆。

别名的收益是"打字变短"，函数的收益是"不用记命令怎么写"——后者通常更值钱。

## 一条铁律

刚加完别名/函数的那一周，如果发现自己从没用过，就删掉。终端配置的目标是让操作更快，不是让配置看上去很专业。

这些片段我都放进 dotfiles 仓库托管，换机器拉下来即可用。
