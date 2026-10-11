// Prints the CHANGELOG section of one version, for the notes of a GitHub Release.
//
//   node scripts/changelog-section.mjs 1.0.0
import { readFileSync } from 'node:fs'

const version = process.argv[2]
if (!version) {
  console.error('Usage: node scripts/changelog-section.mjs <version>')
  process.exit(2)
}
const lines = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split('\n')
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`))
if (start === -1) {
  console.error(`CHANGELOG.md has no section for ${version}.`)
  process.exit(1)
}
let end = lines.findIndex((line, index) => index > start && line.startsWith('## ['))
if (end === -1) end = lines.length
console.log(lines.slice(start + 1, end).join('\n').trim())
