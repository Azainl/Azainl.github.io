---
title: "我的 PowerShell 常用工具箱"
description: "几个日常高频使用的 PowerShell 小技巧：批量重命名、查找大文件、清理磁盘、查看进程。"
date: 2026-08-01
tags: ["工具", "效率"]
---

Windows 上我大部分时间在用 PowerShell，时间久了攒下几个高频使用的命令片段，整理出来备用。

## 批量重命名文件

给一组文件加前缀：

```powershell
Get-ChildItem -Filter *.md | ForEach-Object {
  Rename-Item $_.FullName -NewName ("draft-" + $_.Name)
}
```

注意 `-LiteralPath` 优先于 `-Path`：文件名里带方括号时，`-Path` 会把它当成通配符，导致找不到文件。

## 找出目录里最大的文件

```powershell
Get-ChildItem -Recurse -File |
  Sort-Object Length -Descending |
  Select-Object -First 10 FullName, @{N='SizeMB'; E={[math]::Round($_.Length/1MB,1)}}
```

排查磁盘空间被什么占掉时，这条命令能直接给出答案。

## 查看占用端口的进程

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen |
  ForEach-Object { Get-Process -Id $_.OwningProcess }
```

开发时端口被占是最常见的问题，这条命令比打开任务管理器快得多。

## 把结果导出成 CSV

PowerShell 的对象管道可以直接导出：

```powershell
Get-Process | Select-Object Name, CPU, WorkingSet |
  Export-Csv -Path process.csv -NoTypeInformation -Encoding UTF8
```

## 一个原则

> 能管道，就不要循环。

PowerShell 的哲学是把对象交给管道，让后续命令自己处理。手写 `foreach` 循环通常意味着有更 PowerShell 的写法。

这些片段都在我的 dotfiles 仓库里维护，遇到新的好用的会继续补充。
