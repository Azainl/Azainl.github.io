/**
 * 发布时间的唯一口径：Asia/Shanghai 日历日，当天 00:00 放行。
 *
 * 为什么需要这个模块：frontmatter 的 `date: YYYY-MM-DD` 会被 `z.coerce.date()`
 * 解析成 **UTC 零点**。如果直接拿它和 `new Date()` 比较，北京时间的当天文章
 * 要等到 08:00 才放行；定时 CI 在 00:10 构建时会漏掉当天内容。
 *
 * 约定：`date` 是**日期**，不是时刻。页面、sitemap、RSS、JSON-LD 仍用
 * 「UTC 零点的同一天」作为稳定的机器表示；只有「哪天算发布」按北京时间判断。
 * 因此这里的纯函数不修改日期对象本身，只回答「这个日期属于北京哪一天」和
 * 「北京当天零点对应哪个时刻」。
 *
 * 用 `formatToParts()` 而不是 `format()` 的字符串：不同 Node / ICU 版本对
 * 中文、en-CA 等 locale 的输出顺序并不一致，拼字符串会得到 `2026/10/20`
 * 或带日期前缀的变体。按 part 取值是唯一稳定的写法。
 */
export const TZ = 'Asia/Shanghai';

let dayFormatter: Intl.DateTimeFormat | undefined;

function getDayFormatter(): Intl.DateTimeFormat {
  // 延迟创建：这个模块也会被客户端脚本（搜索日期格式化）导入，
  // 只取 TZ 时不该在模块求值阶段就构造 Intl 实例。
  dayFormatter ??= new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return dayFormatter;
}

/** 取某个日期在 Asia/Shanghai 的日历日，格式固定为 YYYY-MM-DD */
export function dateKeyInTz(date: Date): string {
  const parts = getDayFormatter().formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** 该日期在北京时间当天 00:00 对应的绝对时刻 */
export function releaseAt(date: Date): Date {
  return new Date(`${dateKeyInTz(date)}T00:00:00+08:00`);
}

/** 到 now 为止，这篇文章是否已经按北京时间放行 */
export function isReleased(date: Date, now: Date = new Date()): boolean {
  return releaseAt(date).getTime() <= now.getTime();
}
