import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { parse } from './parse'
import { analyze, FALLOW, type Runner } from './worker'

// A trimmed real `fallow --score --format json` from Fallow 3.44.0, paths renamed.
const fixture = async () => JSON.parse(await readFile(new URL('./fixtures/fallow-3.44.json', import.meta.url), 'utf8'))

test('reads every finding Fallow reports, with its file and line', async () => {
  const a = parse(await fixture(), '/p', 1)
  assert.deepEqual([a.health!.score, a.health!.grade, a.health!.duplication], [87.7, 'A', 0.7331095419994599])
  assert.deepEqual(a.health!.penalties[0], { key: 'Function size', points: 10 })
  assert.equal(a.version, '3.44.0')
  const by = (c: string) => a.findings.filter((f) => f.category === c)
  assert.equal(by('unused-files').length, 1)
  assert.equal(by('unused-files')[0].detail, 'No entry point reaches this file')
  assert.deepEqual(
    { title: by('unresolved-imports')[0].title, line: by('unresolved-imports')[0].line, severity: by('unresolved-imports')[0].severity },
    { title: './logo.png', line: 149, severity: 'error' }
  )
  assert.equal(by('unlisted-dependencies')[0].detail, 'Script "lint:design" in package.json:34')
  assert.equal(by('duplication').length, 2)
  assert.match(by('duplication')[0].detail, /^\d+ lines · 2 copies$/)
  assert.equal(by('complexity').length, 3)
  assert.equal(new Set(a.findings.map((f) => f.id)).size, a.findings.length)
})

test('an issue type this parser does not know lands under Other, not nowhere', () => {
  const a = parse({ check: { brand_new_issue: [{ path: 'src/a.ts', line: 3, name: 'thing' }] } }, '/p', 1)
  assert.deepEqual(a.findings.map((f) => [f.category, f.title, f.path, f.line]), [['other', 'thing', 'src/a.ts', 3]])
})

test('circular dependencies read as the cycle', () => {
  const a = parse({ check: { circular_dependencies: [{ files: ['a.ts', 'b.ts', 'a.ts'] }] } }, '/p', 1)
  assert.deepEqual([a.findings[0].title, a.findings[0].detail], ['3 files import each other', 'a.ts → b.ts → a.ts'])
})

async function project(withPkg = true): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fallow-'))
  if (withPkg) await writeFile(join(dir, 'package.json'), '{"name":"x"}')
  return dir
}

test('runs pinned Fallow through npx, and treats exit 1 as findings, not failure', async () => {
  const dir = await project()
  const calls: [string, string[]][] = []
  const run: Runner = async (cmd, args) => (calls.push([cmd, args]), { code: 1, stdout: JSON.stringify(await fixture()), stderr: '[X] gate failed' })
  const a = await analyze(dir, run, () => 42)
  assert.equal(calls[0][0], 'npx')
  assert.deepEqual(calls[0][1], ['--yes', FALLOW, '--score', '--format', 'json', '--quiet'])
  assert.equal(a.error, undefined)
  assert.equal(a.ranAt, 42)
  assert.ok(a.findings.length > 0)
})

test('says why when Fallow does not run or there is no package.json', async () => {
  const none = await analyze(await project(false), async () => ({ code: 0, stdout: '', stderr: '' }))
  assert.match(none.error!, /No package\.json/)
  const broken = await analyze(await project(), async () => ({ code: 127, stdout: '', stderr: 'npm ERR! network\nnpm ERR! offline' }))
  assert.equal(broken.error, 'Fallow did not run (exit 127): npm ERR! network npm ERR! offline')
})

test('keeps the last run in storage, so a restarted worker still shows it', async () => {
  const { mockHost, mountWorker } = await import('orca/testing')
  const main = await import('./worker')
  const host = mockHost({
    results: {
      'workspace.readContext': { workspaceId: 'w1', branch: 'main', displayName: 'app', terminals: [] },
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'worktree', name: 'app', path: '/nowhere/app', branch: 'main', hostId: 'local' }], truncated: false },
      'statusBar.update': { ok: true }
    }
  })
  const first = await mountWorker(main, { host })
  const a = (await first.request('fallow.run')) as { error?: string }
  assert.match(a.error!, /No package\.json/)
  await first.deactivate()
  const second = await mountWorker(main, { host })
  assert.deepEqual(await second.request('fallow.last'), a)
  await second.deactivate()
})

test('previews and applies `fallow fix` for one file, never creating a config', async () => {
  const dir = await project()
  const calls: string[][] = []
  const out = (dry: boolean) =>
    JSON.stringify({ dry_run: dry, fixes: [{ type: 'remove_export', path: 'src/greet.ts', line: 5, name: 'unusedGreeting', ...(dry ? {} : { applied: true }) }], total_fixed: dry ? 0 : 1, skipped: 0, skipped_low_confidence_exports: 1 })
  const run: Runner = async (_cmd, args) => (calls.push(args), { code: 0, stdout: out(args.includes('--dry-run')), stderr: '' })
  const { fix } = await import('./worker')
  const plan = await fix(dir, 'src/greet.ts', true, run)
  assert.deepEqual(plan, { fixes: [{ type: 'remove_export', file: 'src/greet.ts', line: 5, name: 'unusedGreeting' }], skipped: 1 })
  assert.deepEqual(calls[0].slice(-7), ['fix', 'src/greet.ts', '--dry-run', '--no-create-config', '--format', 'json', '--quiet'])
  const applied = await fix(dir, 'src/greet.ts', false, run)
  assert.equal(applied.fixes[0].applied, true)
  assert.ok(calls[1].includes('--yes') && !calls[1].includes('--dry-run'))
  assert.match((await fix(dir, '../etc/passwd', true, run)).error!, /Not a file of this workspace/)
  assert.equal(calls.length, 2)
})

test('lists the files Git has uncommitted changes in, or null outside a repository', async () => {
  const { uncommitted } = await import('./worker')
  const git: Runner = async (_cmd, args) => ({ code: 0, stdout: args.includes('src/a.ts') ? ' M src/a.ts\n' : '', stderr: '' })
  assert.deepEqual(await uncommitted('/p', ['src/a.ts', 'src/b.ts'], git), ['src/a.ts'])
  assert.deepEqual(await uncommitted('/p', ['src/b.ts'], git), [])
  assert.equal(await uncommitted('/p', ['x'], async () => ({ code: 128, stdout: '', stderr: 'not a git repository' })), null)
})

test('really fixes a project, end to end with Fallow and Git', async () => {
  const { execFileSync } = await import('node:child_process')
  const { fix, uncommitted } = await import('./worker')
  const dir = await project()
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', main: 'src/index.ts', dependencies: { 'left-pad': '^1.3.0' } }))
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(dir, 'src'))
  await writeFile(join(dir, 'src/index.ts'), "import { greet } from './greet'\nconsole.log(greet('x'))\n")
  await writeFile(join(dir, 'src/greet.ts'), "export function greet(n: string) {\n  return n\n}\n\nexport function unusedGreeting() {\n  return 1\n}\n")
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir })
  g('init', '-q')
  g('add', '-A')
  g('commit', '-qm', 'init')
  try {
    const plan = await fix(dir, 'src/greet.ts', true)
    assert.deepEqual(plan.fixes.map((f) => [f.type, f.name]), [['remove_export', 'unusedGreeting']])
    assert.deepEqual(await uncommitted(dir, ['src/greet.ts']), [])
    await fix(dir, 'src/greet.ts', false)
    assert.match(await readFile(join(dir, 'src/greet.ts'), 'utf8'), /^function unusedGreeting/m)
    assert.deepEqual(await uncommitted(dir, ['src/greet.ts']), ['src/greet.ts'])
    assert.match(await readFile(join(dir, 'package.json'), 'utf8'), /left-pad/)
  } catch (e) {
    // Offline machines cannot fetch Fallow through npx: say so instead of failing the suite.
    if (/did not run/.test(String((e as Error).message))) return
    throw e
  }
})

test('inserts the ignore comment at the indentation of the line it silences', async () => {
  const { insertComment } = await import('./worker')
  const src = 'const a = 1\n  export function f() {}\n'
  assert.equal(insertComment(src, { comment: '// fallow-ignore-next-line unused-export', line: 2 }), 'const a = 1\n  // fallow-ignore-next-line unused-export\n  export function f() {}\n')
  assert.equal(insertComment('#!/usr/bin/env node\r\nrun()\r\n', { comment: '// fallow-ignore-file unused-file', line: null }), '#!/usr/bin/env node\r\n// fallow-ignore-file unused-file\r\nrun()\r\n')
})

test('deletes and suppresses only files Git can restore', async () => {
  const { execFileSync } = await import('node:child_process')
  const { deleteFile, suppress } = await import('./worker')
  const dir = await project()
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(dir, 'src'))
  await writeFile(join(dir, 'src/old.ts'), 'export const x = 1\n')
  await writeFile(join(dir, 'src/keep.ts'), 'export const y = 1\n')
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir })
  g('init', '-q')
  g('add', '-A')
  g('commit', '-qm', 'init')
  await writeFile(join(dir, 'src/new.ts'), 'export const z = 1\n')

  await suppress(dir, { comment: '// fallow-ignore-next-line unused-export', line: 1, path: 'src/keep.ts' })
  assert.equal(await readFile(join(dir, 'src/keep.ts'), 'utf8'), '// fallow-ignore-next-line unused-export\nexport const y = 1\n')
  await assert.rejects(() => suppress(dir, { comment: '// fallow-ignore-next-line', line: 1, path: 'src/keep.ts' }), /Commit or stash/)
  await assert.rejects(() => suppress(dir, { comment: 'rm -rf /', line: 1, path: 'src/old.ts' }), /Only Fallow ignore comments/)
  await assert.rejects(() => deleteFile(dir, 'src/new.ts'), /not committed to Git/)
  await assert.rejects(() => deleteFile(dir, '../outside.ts'), /Not a file of this workspace/)
  await deleteFile(dir, 'src/old.ts')
  const { access } = await import('node:fs/promises')
  await assert.rejects(() => access(join(dir, 'src/old.ts')))
  g('restore', 'src/old.ts')
  await access(join(dir, 'src/old.ts'))
})

test('reads every place a finding spans, its ignore comment, advice and docs', async () => {
  const a = parse(await fixture(), '/p', 1)
  const file = a.findings.find((f) => f.category === 'unused-files')!
  assert.equal(file.deletable, true)
  assert.deepEqual(file.suppress, { comment: '// fallow-ignore-file unused-file', line: null, path: file.path })
  assert.equal(file.docs, 'https://fallow.tools/docs/explanations/dead-code/#unused-files')
  const clone = a.findings.find((f) => f.category === 'duplication')!
  assert.equal(clone.locations.length, 2)
  assert.ok(clone.locations.every((l) => l.line && l.endLine && l.endLine >= l.line))
  assert.match(clone.advice!, /^Extract duplicated code/)
  assert.equal(clone.suppress, null)
  const complex = a.findings.find((f) => f.category === 'complexity')!
  assert.match(complex.suppress!.comment, /fallow-ignore-next-line complexity/)
  assert.equal(complex.suppress!.line, complex.line)
  const binary = a.findings.find((f) => f.category === 'unlisted-dependencies')!
  assert.equal(binary.suppress, null, 'a comment in package.json does nothing')
})

test('starts the agent in the focused workspace and brings its terminal to the front', async () => {
  const { mockHost, mountWorker } = await import('orca/testing')
  const main = await import('./worker')
  const calls: [string, unknown][] = []
  const host = mockHost({
    results: {
      'workspace.readContext': { workspaceId: 'w1', branch: 'main', displayName: 'app', terminals: [] },
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'worktree', name: 'app', path: '/repo/app', branch: 'main', hostId: 'local' }], truncated: false },
      'settings.get': { settings: { agent: 'codex' } },
      'agent.launch': (p: unknown) => (calls.push(['agent.launch', p]), { terminalId: 't9' }),
      'terminal.focus': (p: unknown) => (calls.push(['terminal.focus', p]), { focused: true }),
      'terminal.read': () => ({ lines: ['  Claude Code v2.1.328', '❯ Try "write a test"'], truncated: false }),
      'terminal.sendText': (p: unknown) => (calls.push(['terminal.sendText', p]), { accepted: true })
    }
  })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('fallow.askAgent', { prompt: 'fix it' }), { started: true, focused: true, sent: true })
  assert.deepEqual(calls, [
    ['agent.launch', { workspaceId: 'w1', agent: 'codex' }],
    ['terminal.focus', { terminalId: 't9' }],
    ['terminal.sendText', { terminalId: 't9', text: 'fix it', enter: true }]
  ])
  await worker.deactivate()
})

// Captured from a real Claude Code 2.1.328 launch in Orca, and the screens that must not get a prompt.
const BOOTING = ['', '']
const READY = ['           Claude Code v2.1.328', ' ▐▛███▛█   Opus 5.5', '──────────────────', '❯ Try "write a test for <filepath>"', '──────────────────', '  ⏵⏵ bypass permissions on']
const TRUST = ['Do you trust the files in this folder?', '❯ 1. Yes, proceed', '  2. No, exit']
const CODEX = ['╭──────────────╮', '│ >_ OpenAI Codex │', '╰──────────────╯', '› Ask Codex to do anything']

test('knows when an agent is ready for its prompt', async () => {
  const { agentReady } = await import('./worker')
  assert.equal(agentReady(BOOTING), false)
  assert.equal(agentReady(READY), true)
  assert.equal(agentReady(CODEX), true)
  assert.equal(agentReady(TRUST), false, 'a trust menu must not get the prompt typed into it')
})

test('types the prompt once the agent is ready, and gives up after the timeout', async () => {
  const { deliverPrompt } = await import('./worker')
  const screens = [BOOTING, BOOTING, READY]
  const sent: string[] = []
  const ok = await deliverPrompt(async () => screens.shift() ?? READY, async (t) => (sent.push(t), true), 'fix it', { everyMs: 1, wait: async () => {} })
  assert.equal(ok, true)
  assert.deepEqual(sent, ['fix it'])
  assert.deepEqual(screens, [], 'waited through both booting screens first')

  let reads = 0
  const never = await deliverPrompt(async () => (reads++, TRUST), async () => true, 'x', { timeoutMs: 10, everyMs: 1, wait: async () => {} })
  assert.equal(never, false)
  assert.equal(reads, 11)
})

test('the Health view gets every vital sign, ranking and threshold Fallow reports', () => {
  const health = {
    health_score: { score: 70, grade: 'C', penalties: { unit_size: 10, coupling: 1.6, dead_exports: 0 } },
    summary: { files_analyzed: 331, functions_analyzed: 1596, functions_above_threshold: 110, max_cyclomatic_threshold: 20, max_cognitive_threshold: 15, severity_critical_count: 16, severity_high_count: 27, severity_moderate_count: 67, coverage_model: 'static_estimated' },
    vital_signs: { dead_file_pct: 0.3, avg_cyclomatic: 2.3, p90_cyclomatic: 5, maintainability_avg: 91.3, total_loc: 36289, counts: { total_files: 331, dead_files: 1, dead_exports: 0, total_exports: 326, duplicated_lines: 190 }, unit_size_profile: { low_risk: 83.1, medium_risk: 8.4, high_risk: 3.7, very_high_risk: 4.8 } },
    hotspots: [{ path: 'a.ts', score: 27.6, commits: 11, trend: 'accelerating' }, { path: 'cold.ts', score: 0, commits: 1 }],
    hotspot_summary: { since: '6 months' },
    targets: [{ path: 'b.ts', recommendation: 'Split high-impact file', effort: 'medium', confidence: 'medium', priority: 26.2 }],
    change_coupling: { pairs: [{ path_a: 'x.ts', path_b: 'y.ts', degree: 0.91, shared_revisions: 5, strong: true }] },
    file_scores: [{ path: 'good.ts', maintainability_index: 95, total_cyclomatic: 3, lines: 10, fan_in: 1, fan_out: 1 }, { path: 'bad.ts', maintainability_index: 40, total_cyclomatic: 125, lines: 379, fan_in: 2, fan_out: 21 }],
    framework_health: { detected_frameworks: ['svelte', 'sveltekit'] }
  }
  const h = parse({ health, dupes: { stats: { duplication_percentage: 0.7 } } }, '/p', 1).health!
  assert.deepEqual(h.penalties, [{ key: 'Function size', points: 10 }, { key: 'Coupling', points: 1.6 }])
  const v = Object.fromEntries(h.vitals.map((x) => [x.label, x.value]))
  assert.equal(v['Files'], '331')
  assert.equal(v['Lines'], '36,289')
  assert.equal(v['Unused files'], '1 (0.3%)')
  assert.equal(v['Over the limit'], '110/1,596')
  assert.equal(v['Critical/high/mod.'], '16/27/67')
  assert.equal(v['High/very high'], '3.7%/4.8%')
  assert.ok(!('P95 fan-in' in v), 'a vital sign Fallow did not report is left out, not shown as a dash')
  assert.deepEqual(h.hotspots.map((x) => x.path), ['a.ts'], 'zero-score hotspots are noise')
  assert.equal(h.targets[0].recommendation, 'Split high-impact file')
  assert.deepEqual(h.coupling, [{ a: 'x.ts', b: 'y.ts', degree: 0.91, shared: 5, strong: true }])
  assert.deepEqual(h.files.map((f) => f.path), ['bad.ts', 'good.ts'])
  assert.equal(h.scope, 'Limits: cyclomatic 20, cognitive 15 · hotspots over 6 months · coverage static estimated')
  assert.deepEqual(h.frameworks, ['svelte', 'sveltekit'])
})

test('one agent per list: the prompt names the Fallow command to run and stays short', async () => {
  const { batchPrompt, BATCH_COMMAND, PROMPT_MAX } = await import('./parse')
  for (const kind of Object.keys(BATCH_COMMAND) as (keyof typeof BATCH_COMMAND)[]) {
    const p = batchPrompt(kind, 110)
    assert.ok(p.length <= PROMPT_MAX && p.length < 4096, kind)
    assert.ok(p.startsWith(`Run \`${BATCH_COMMAND[kind].command}\` in this project. It lists 110 items to fix.`), kind)
    assert.match(p, /Never silence a finding/)
    assert.match(p, /Do not commit\.$/)
  }
  assert.match(batchPrompt('duplication', 1), /^Run `npx fallow dupes` in this project\. It lists 1 item to fix\. Then extract each group/)
  assert.match(batchPrompt('hotspots', 3), /confirm each one in the code before changing it/)
})

test('the batch handler starts one agent and types the short prompt, writing no file', async () => {
  const { mockHost, mountWorker } = await import('orca/testing')
  const main = await import('./worker')
  const { readdir } = await import('node:fs/promises')
  const dir = await project()
  const sent: string[] = []
  let launches = 0
  const host = mockHost({
    results: {
      'workspace.readContext': { workspaceId: 'w1', branch: 'main', displayName: 'app', terminals: [] },
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'worktree', name: 'app', path: dir, branch: 'main', hostId: 'local' }], truncated: false },
      'settings.get': { settings: { agent: 'claude' } },
      'agent.launch': () => (launches++, { terminalId: 't1' }),
      'terminal.focus': { focused: true },
      'terminal.read': { lines: ['❯ '], truncated: false },
      'terminal.sendText': (p: { text: string }) => (sent.push(p.text), { accepted: true })
    }
  })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('fallow.askAgentBatch', { kind: 'duplication', count: 11 }), { started: true, focused: true, sent: true })
  assert.equal(launches, 1)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /^Run `npx fallow dupes` in this project\. It lists 11 items/)
  assert.deepEqual(await readdir(dir), ['package.json'])
  await assert.rejects(() => worker.request('fallow.askAgentBatch', { kind: 'rm -rf' as never, count: 1 }), /Unknown list/)
  await worker.deactivate()
})

test('reads fallow security: category, CWE, evidence, the source-to-sink trace and the blind spots', async () => {
  const { parseSecurity } = await import('./parse')
  const sec = parseSecurity({
    security_findings: [
      {
        stable_finding_id: 'sec1:680de8b54b960068',
        kind: 'tainted-sink',
        category: 'ssrf',
        cwe: 918,
        path: 'src/server/api.server.ts',
        line: 7,
        severity: 'medium',
        evidence: 'Non-literal URL passed to fetch(). Candidate for verification.',
        trace: [{ path: 'src/server/api.server.ts', line: 7, role: 'sink' }],
        reachability: {
          reachable_from_untrusted_source: true,
          untrusted_source_trace: [
            { path: 'src/server/api.check.ts', line: 45, role: 'module-source' },
            { path: 'src/server/api.server.ts', line: 7, role: 'sink' }
          ]
        }
      }
    ],
    unresolved_edge_files: [],
    unresolved_callee_sites: 697
  })
  assert.deepEqual(sec.blindSpots, { unresolvedImports: 0, unresolvedCallees: 697 })
  const [c] = sec.candidates
  assert.deepEqual([c.id, c.category, c.cwe, c.severity, c.reachableFromUntrusted], ['sec1:680de8b54b960068', 'ssrf', 918, 'medium', true])
  assert.deepEqual(c.trace.map((t) => `${t.path}:${t.line}`), ['src/server/api.check.ts:45', 'src/server/api.server.ts:7'])
})

test('every one-agent list names a real Fallow command', async () => {
  const { BATCH_COMMAND, batchPrompt } = await import('./parse')
  // The subcommands and flags `npx fallow@3.44.0 --help` lists.
  const known = /^npx fallow(?: (?:dead-code|dupes|health|security))?(?: --(?:unused-files|unused-exports|unused-types|unused-deps|unused-enum-members|unused-class-members|unlisted-deps|unlisted-binaries|duplicate-exports|boundary-violations|circular-deps|unresolved-imports|complexity|hotspots|targets|file-scores))*$/
  for (const [kind, { command }] of Object.entries(BATCH_COMMAND)) {
    assert.match(command, known, kind)
    assert.ok(batchPrompt(kind as never, 5).length < 4096, kind)
  }
})

test('the status bar takes the colour of the health grade, as the panel badge does', async () => {
  const { statusOf } = await import('./worker')
  const at = (grade: string, findings: { severity: 'error' | 'warning' | 'info' }[] = []) =>
    statusOf({ path: '/p', version: '3.44.0', ranAt: 1, elapsedMs: 1, security: null, findings: findings as never, health: { score: 50, grade, duplication: 0 } as never })
  assert.deepEqual(['A', 'B', 'C', 'D', 'E', 'F'].map((g) => at(g).tone), ['success', 'success', 'warning', 'warning', 'danger', 'danger'])
  assert.equal(at('A', [{ severity: 'error' }]).tone, 'success', 'errors no longer turn a healthy project red')
  const noScore = statusOf({ path: '/p', version: null, ranAt: 1, elapsedMs: null, security: null, health: null, findings: [{ severity: 'error' }] as never })
  assert.equal(noScore.tone, 'danger', 'without a score, the worst finding still decides')
})
