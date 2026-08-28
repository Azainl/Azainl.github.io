---
title: "TypeScript：日常写代码最常用的几个类型技巧"
description: "不求类型体操，只把几个高频的类型写法记下来：字面量联合、推断、工具类型、守卫。"
date: 2026-08-15
tags: ["前端", "思考"]
---

TypeScript 的价值不在写多复杂的类型，而在让日常代码更稳。下面几个是我实际项目里最常用的，简单但实用。

## 用字面量联合代替字符串

状态、方向这类"就几种可能"的值，别用 `string`，用联合类型。写错一个拼写，编译器直接报错：

```ts
type Status = 'draft' | 'published' | 'archived';

function publish(s: Status) {
  // ...
}
```

## 让工具类型替你写重复的类型

`Pick`、`Omit`、`Partial` 这几个内置工具类型，能把重复的手写类型省掉：

```ts
interface Post {
  id: number;
  title: string;
  content: string;
  tags: string[];
}

type PostSummary = Pick<Post, 'id' | 'title' | 'tags'>;
type NewPost = Omit<Post, 'id'>;
```

## 利用返回类型推断

函数的返回值能自动推断时，别再手写一遍几乎一样的类型。改参数，返回类型跟着变，少一处维护：

```ts
// 不需要: const map: Record<number, string> = ...
const map = new Map();
```

## 用类型守卫收窄

从 `any` 或联合类型里安全取值的常用写法：

```ts
function isPost(x: unknown): x is Post {
  return typeof x === 'object' && x !== null && 'title' in x;
}
```

配合 `unknown` 而不是 `any`，让取值在类型层面被强制检查。

## 一个建议

> 类型是约束，不是装饰。它应该帮你提前发现错误，而不是写出来证明你很懂类型系统。

先把这几个高频技巧用熟，比硬记一整套高阶类型有用得多。
