#!/usr/bin/env node
/**
 * 把工作区级技能目录链接到本仓库，使**在 blog/ 下开会话时技能仍可被发现**。
 *
 * 背景（T-10）：DSH 的技能发现根由会话 **cwd** 决定：
 * 从 cwd 向上找 .git，找到就用它；找不到就返回 cwd 本身。
 *
 *   cwd = D:\Code\Deepseek        （无 .git）→ 返回 D:\Code\Deepseek  ← 技能在这里，可见
 *   cwd = D:\Code\Deepseek\blog   （有 .git）→ 返回 blog              ← 看不到上一级，技能全部消失
 *
 * 于是"换个目录开会话，技能就不见了"。修法是在 blog/ 下放一个 junction
 * 指回工作区的技能目录；DSH 会发现 blog/.agents/skills，行为与工作区一致。
 *
 * ⚠️ junction 必须留在版本控制之外（见 .gitignore）：git 会**跟随** junction
 * 把 15 个技能的全部文件复制进仓库。用 --check 可随时验证两侧状态。
 *
 * 用法：
 *   node scripts/link-skills.mjs          创建/修复链接并校验
 *   node scripts/link-skills.mjs --check  只检查，不修改（退出码反映结果）
 */
import { existsSync, readdirSync, statSync, mkdirSync, rmSync, symlinkSync, lstatSync, readlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // blog/
const CHECK_ONLY = process.argv.includes('--check');

// 工作区级技能目录：blog 的上一级
const SOURCE = resolve(ROOT, '..', '.agents', 'skills');
const LINK_DIR = join(ROOT, '.agents');
const LINK = join(LINK_DIR, 'skills');

function listSkills(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isDirectory())
    .sort();
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink() || (lstatSync(p).isDirectory() && lstatSync(p).isSymbolicLink());
  } catch {
    return false;
  }
}

function linkTarget(p) {
  try {
    const l = lstatSync(p);
    if (l.isSymbolicLink()) return readlinkSync(p);
    // Windows junction 不是 symbolic link，需看 ReparsePoint
    return l.isDirectory() ? (readlinkSync(p, { encoding: 'utf8' }) || null) : null;
  } catch {
    return null;
  }
}

const sourceSkills = listSkills(SOURCE);
const linkedSkills = listSkills(LINK);

const problems = [];
if (sourceSkills.length === 0) problems.push(`工作区技能目录不存在或为空: ${SOURCE}`);
if (!existsSync(LINK)) problems.push(`blog 下不存在技能链接: ${LINK}`);
else if (linkedSkills.length !== sourceSkills.length) {
  problems.push(`链接可见技能数 ${linkedSkills.length} != 工作区 ${sourceSkills.length}`);
}
const onlyInSource = sourceSkills.filter((s) => !linkedSkills.includes(s));
if (onlyInSource.length) problems.push('链接中缺少: ' + onlyInSource.join(', '));

console.log('工作区技能目录 : ' + SOURCE);
console.log('  技能数 = ' + sourceSkills.length);
console.log('blog 下链接    : ' + LINK);
console.log('  可见技能数 = ' + linkedSkills.length);
// 必须是**链接**而不是副本：副本会与工作区版本各自漂移，
// 以后装了新技能这里看不到，且核对时无法察觉。
const isRealLink = (() => {
  try {
    const l = lstatSync(LINK);
    if (l.isSymbolicLink()) return true;
    // Windows 的 junction 在 lstat 里表现为目录 + ReparsePoint，
    // 且 readlinkSync 能返回目标路径。
    try { return typeof readlinkSync(LINK) === 'string' && readlinkSync(LINK).length > 0; } catch { return false; }
  } catch { return false; }
})();
console.log('  是链接而非副本 = ' + isRealLink);
if (!isRealLink) problems.push('blog/.agents/skills 不是链接（可能是被复制成的普通目录，会与工作区版本漂移）');
console.log('  两侧技能一致 = ' + (onlyInSource.length === 0 && linkedSkills.length === sourceSkills.length));

if (problems.length === 0) {
  console.log('PASS  在 blog/ 下开会话时，15 个技能均可被发现');
  process.exitCode = 0;
} else {
  for (const p of problems) console.log('  ! ' + p);
  if (CHECK_ONLY) {
    console.log('FAIL  ' + problems.length + ' 个问题（--check 未做修改）');
    process.exitCode = 1;
  } else {
    console.log('尝试修复…');
    if (existsSync(LINK)) rmSync(LINK, { recursive: true, force: true });
    mkdirSync(LINK_DIR, { recursive: true });
    // Windows 上目录链接用 junction（无需管理员权限）：mklink /J
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'mklink', '/J', LINK, SOURCE], { stdio: 'ignore' });
    } else {
      symlinkSync(SOURCE, LINK, 'dir');
    }
    const after = listSkills(LINK);
    console.log('修复后可见技能数 = ' + after.length);
    console.log(after.length === sourceSkills.length ? 'PASS  链接已建立并校验通过' : 'FAIL  修复后仍不一致');
    process.exitCode = after.length === sourceSkills.length ? 0 : 1;
  }
}
