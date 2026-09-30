// 项目类型检查：直接用 TypeScript 编译器 API 跑一遍 tsconfig.json，
// 不引入任何新依赖（typescript 由 astro 传递带入），也不需要启动子进程。
//
// 用法：
//   npm run sync       # 先同步内容集合类型（.astro/ 被 gitignore，CI 上是空的）
//   npm run typecheck
//
// 有类型错误时以非 0 退出码结束，可直接作为 CI 门禁。
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve } from 'node:path';

// 注意：不要写成 dirname(fileURLToPath(new URL('..', import.meta.url)))——
// fileURLToPath 会保留结尾的反斜杠（"…\blog\"），dirname 再吃掉一层就变成
// 上一级目录，导致 .chrome-tmp* / .shots 落到项目外面。
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

let ts;
try {
  ts = require('typescript');
} catch {
  console.error(
    '找不到 typescript。它通常由 astro 传递依赖带入，请确认已执行 npm install。',
  );
  process.exit(2);
}

const configPath = resolve(ROOT, 'tsconfig.json');
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  console.error(
    'tsconfig.json 解析失败：' +
      ts.flattenDiagnosticMessageText(configFile.error.messageText, ' '),
  );
  process.exit(2);
}

const parsed = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  ROOT,
);

// .astro/ 由 `astro sync` 生成且不进版本库，缺失时先明确提示，
// 否则会变成一堆莫名其妙的 "找不到模块 astro:content"
const hasAstroTypes = parsed.fileNames.some((f) => f.includes(`.astro`));
if (!hasAstroTypes) {
  console.warn(
    '提示：未找到 .astro/types.d.ts，请先执行 npm run sync 生成内容集合类型。',
  );
}

const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = ts
  .getPreEmitDiagnostics(program)
  .filter((d) => d.category === ts.DiagnosticCategory.Error);

if (diagnostics.length === 0) {
  console.log(`类型检查通过（${parsed.fileNames.length} 个文件，0 错误）`);
  process.exit(0);
}

for (const d of diagnostics) {
  const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
  if (d.file && typeof d.start === 'number') {
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    console.log(
      `${relative(ROOT, d.file.fileName)}:${line + 1}:${character + 1}  ${message}`,
    );
  } else {
    console.log(message);
  }
}
console.error(`\n类型检查失败：${diagnostics.length} 个错误`);
process.exit(1);
