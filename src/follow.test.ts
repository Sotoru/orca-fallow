import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { follow, relevant } from './follow'

test('only sources and the configs Fallow reads start a run', () => {
  for (const f of ['src/a.ts', 'src/b.tsx', 'lib/c.mjs', 'app/d.svelte', 'package.json', 'packages/x/package.json', 'tsconfig.app.json', '.fallowrc.json']) assert.equal(relevant(f), true, f)
  for (const f of ['node_modules/x/index.js', 'dist/a.js', '.git/index', 'README.md', 'src/logo.png', '.svelte-kit/types/a.ts']) assert.equal(relevant(f), false, f)
})

test('a burst of saves runs once, after the last', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fallow-follow-'))
  await mkdir(join(dir, 'src'))
  let runs = 0
  const stop = follow(dir, () => runs++, 150)
  await new Promise((r) => setTimeout(r, 100))
  for (let i = 0; i < 3; i++) await writeFile(join(dir, 'src', 'a.ts'), `export const a = ${i}`)
  await writeFile(join(dir, 'notes.md'), 'x')
  await new Promise((r) => setTimeout(r, 600))
  stop()
  assert.equal(runs, 1)
})
