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

## 让返回值自动推断

函数返回什么类型，能让 TS 推断就别手写。这样改了内部逻辑，返回类型跟着变，少一处要同步维护的地方：

```ts
function parseTime(input: string) {
  const [h, m] = input.split(':').map(Number);
  return { h, m }; // 返回类型被推断为 { h: number; m: number }
}

const t = parseTime('09:30'); // t 的类型自动是 { h: number; m: number }
```

手写 `: { h: number; m: number }` 不仅多余，改了返回结构还得记得一起改——推断替你省了这道工序。

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
