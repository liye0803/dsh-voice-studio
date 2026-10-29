// 发版小工具：node scripts/release.mjs 1.0.1
// 做四件事：改 package.json 版本 → 在 CHANGELOG 顶部插入一节 → 提交 → 打 tag 并推送
// 之后去 GitHub 的 Releases 页面点 "Draft a new release" 选这个 tag 即可。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const ver = (process.argv[2] || '').trim()
const notes = (process.argv.slice(3).join(' ') || '').trim()

if (!/^\d+\.\d+\.\d+$/.test(ver)) {
  console.error('用法：node scripts/release.mjs <版本号，如 1.0.1> [一句话说明]')
  process.exit(1)
}

const git = (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim()

// 1) package.json
const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const prev = pkg.version
pkg.version = ver
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

// 2) CHANGELOG
const clPath = join(root, 'CHANGELOG.md')
let cl = readFileSync(clPath, 'utf8')
const today = new Date().toISOString().slice(0, 10)
const section = `## ${ver} — ${today}\n\n${notes ? '- ' + notes + '\n' : '- 详见本次提交。\n'}\n`
cl = cl.replace(/^# 更新记录\n\n/, `# 更新记录\n\n${section}`)
writeFileSync(clPath, cl, 'utf8')

// 3) commit + tag + push
git(['add', '-A'])
git(['commit', '-m', `chore(release): v${ver}`])
git(['tag', '-a', `v${ver}`, '-m', `v${ver}`])
git(['push', 'origin', 'HEAD', `v${ver}`])

console.log(`\n完成：${prev} → ${ver}`)
console.log(`tag v${ver} 已推送`)
console.log('\n下一步：打开 https://github.com/liye0803/dsh-voice-studio/releases/new')
console.log(`选 tag v${ver}，标题写 v${ver}，描述粘贴：\n`)
console.log(section)
