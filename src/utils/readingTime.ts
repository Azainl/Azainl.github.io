/** 简单估算阅读时长：中文按 400 字/分钟，英文按 200 词/分钟 */
export function readingTime(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const words = (text.match(/[A-Za-z0-9]+/g) ?? []).length;
  return Math.max(1, Math.ceil(cjk / 400 + words / 200));
}
