// frontmatter 里的 YYYY-MM-DD 会被解析成 UTC 午夜，渲染时必须固定时区，
// 否则同一份源码在 UTC 的 CI 和 UTC+8 的本地会渲染出相差一天的日期。
const TZ = 'Asia/Shanghai';

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: TZ,
  }).format(date);
}

/** 例如：9月3日 */
export function formatDateShort(date: Date): string {
  // 不用 getMonth()/getDate()，那两个取的是运行时本地时区
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    timeZone: TZ,
  }).format(date);
}
