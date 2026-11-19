import { assert, mockHost, mount, test } from 'orca/testing'
import type { Analysis, Finding } from './protocol'
import * as panel from './panel'

const finding = (over: Partial<Finding>): Finding => ({
  id: over.title ?? 'x',
  category: 'unused-files',
  title: 'src/old.ts',
  detail: 'No entry point reaches this file',
  severity: 'warning',
  path: 'src/old.ts',
  line: null,
  fix: null,
  deletable: false,
  suppress: null,
  locations: [],
  advice: null,
  docs: null,
  ...over
})

/** Categories start folded, as in VS Code: unfold one the way a person does. */
const unfold = async (view: Awaited<ReturnType<typeof mount>>, label: string) => {
  if (view.find({ label: `Show ${label}` })) await view.press({ label: `Show ${label}` })
}

const ran: Analysis = {
  security: null,
  path: '/home/dev/apps/shop',
  version: '3.44.0',
  ranAt: 1,
  elapsedMs: 1240,
  health: {
    score: 87.7,
    grade: 'A',
    duplication: 0.73,
    penalties: [{ key: 'Function size', points: 10 }],
    vitals: [{ group: 'Codebase', label: 'Files', value: '331' }, { group: 'Complexity', label: 'P90 cyclomatic', value: '5' }],
    hotspots: [{ path: 'src/hot.ts', score: 27.6, commits: 11, trend: 'accelerating' }],
    targets: [{ path: 'src/big.ts', recommendation: 'Split high-impact file', effort: 'medium', confidence: 'medium', priority: 26 }],
    coupling: [{ a: 'src/x.ts', b: 'src/y.ts', degree: 0.91, shared: 5, strong: true }],
    files: [{ path: 'src/bad.ts', maintainability: 40, cyclomatic: 125, lines: 379, fanIn: 2, fanOut: 21 }],
    scope: 'Limits: cyclomatic 20',
    frameworks: ['svelte']
  },
  findings: [
    finding({ title: 'src/old.ts' }),
    finding({ title: './logo.png', category: 'unresolved-imports', severity: 'error', path: 'src/page.svelte', line: 149 }),
    finding({ title: 'Template in page.svelte', category: 'complexity', severity: 'info', path: 'src/page.svelte', line: 131, locations: [{ path: 'src/page.svelte', line: 131, endLine: null }] })
  ]
}

test('before the first run it offers to run Fallow, then shows health and findings', async () => {
  let runs = 0
  const host = mockHost({
    requests: {
      'fallow.last': { ...ran, ranAt: null, findings: [], health: null },
      'fallow.run': () => (runs++, ran)
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'Analyse this workspace' }))
  await view.press({ text: 'Run Fallow' })
  assert.equal(runs, 1)
  assert.ok(view.find({ text: 'A · 87.7' }))
  assert.ok(view.find({ text: '0.7%' }))
  assert.ok(view.find({ type: 'Tab', label: 'Errors (1)' }))
  assert.ok(view.find({ text: 'Unresolved imports (1)' }))
  assert.ok(view.find({ text: 'Unused Code' }))
  assert.ok(view.find({ text: 'Fallow 3.44.0 · 1.2s' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('severity tabs, search and a closed category narrow the list; a row opens its file', async () => {
  const opened: unknown[] = []
  const host = mockHost({ requests: { 'fallow.last': ran, 'fallow.open': (input) => (opened.push(input), { opened: true }) } })
  const view = await mount(panel, { host })
  await view.select({ label: 'Severity' }, 'error')
  await unfold(view, 'Unresolved imports')
  assert.ok(view.find({ text: './logo.png' }))
  assert.equal(view.find({ text: 'src/old.ts' }), null)
  await view.select({ label: 'Severity' }, 'all')
  await view.type({ label: 'Search findings' }, 'template')
  assert.ok(view.find({ type: 'Tab', label: 'All (1)' }))
  await view.press({ label: 'Hide Complexity' })
  assert.equal(view.find({ text: 'Template in page.svelte' }), null)
  await view.press({ label: 'Show Complexity' })
  assert.ok(view.find({ text: 'Template in page.svelte' }))
  await view.press({ label: 'Show actions for Template in page.svelte' })
  await view.press({ label: 'Open src/page.svelte:131' })
  assert.deepEqual(opened, [{ path: 'src/page.svelte', line: 131 }])
  await view.unmount()
})

test('a run posted by the status bar item updates an open panel', async () => {
  const view = await mount(panel, { host: mockHost({ requests: { 'fallow.last': { ...ran, findings: [] } } }) })
  assert.ok(view.find({ label: 'Nothing to clean up' }))
  await view.post('fallow.updated', ran)
  assert.ok(view.find({ text: '3 findings' }))
  await view.unmount()
})

test('shows why Fallow could not run', async () => {
  const view = await mount(panel, { host: mockHost({ requests: { 'fallow.last': { ...ran, findings: [], health: null, error: 'No package.json in this workspace' } } }) })
  assert.ok(view.find({ text: 'No package.json in this workspace' }))
  await view.unmount()
})

test('a fixable finding previews its fix, and Apply writes it and refreshes', async () => {
  const unused = finding({ title: 'unusedGreeting', category: 'unused-exports', path: 'src/greet.ts', line: 5, fix: 'Remove the export keyword' })
  const steps: string[] = []
  const host = mockHost({
    requests: {
      'fallow.last': { ...ran, findings: [unused] },
      'fallow.planFix': ({ file }) => (steps.push(`plan:${file}`), { fixes: [{ type: 'remove_export', file: 'src/greet.ts', line: 5, name: 'unusedGreeting' }], skipped: 0 }),
      'fallow.applyFix': ({ file }) => (
        steps.push(`apply:${file}`),
        { plan: { fixes: [{ type: 'remove_export', file: 'src/greet.ts', line: 5, name: 'unusedGreeting', applied: true }], skipped: 0 }, analysis: { ...ran, findings: [] } }
      )
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ type: 'Button', text: 'Preview fixes (1)' }))
  await unfold(view, 'Unused exports')
  await view.press({ label: 'Preview fix: Remove the export keyword (src/greet.ts)' })
  assert.deepEqual(steps, ['plan:src/greet.ts'])
  assert.ok(view.find({ text: 'Remove export `unusedGreeting` · src/greet.ts:5' }))
  await view.press({ text: 'Apply 1 change' })
  assert.deepEqual(steps, ['plan:src/greet.ts', 'apply:src/greet.ts'])
  assert.ok(view.find({ text: /^Fallow applied 1 fix\. / }))
  assert.ok(view.find({ label: 'Nothing to clean up' }))
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('uncommitted changes block Apply and say why', async () => {
  const unused = finding({ title: 'unusedGreeting', category: 'unused-exports', path: 'src/greet.ts', line: 5, fix: 'Remove the export keyword' })
  const host = mockHost({
    requests: {
      'fallow.last': { ...ran, findings: [unused] },
      'fallow.planFix': { fixes: [{ type: 'remove_export', file: 'src/greet.ts', line: 5, name: 'unusedGreeting' }], skipped: 0, error: 'Commit or stash your changes first: src/greet.ts has uncommitted edits' }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Preview fixes (1)' })
  assert.ok(view.find({ text: /^Commit or stash your changes first/ }))
  assert.equal(view.find({ text: /^Apply / }), null)
  await view.press({ text: 'Close' })
  assert.equal(view.find({ text: /^Commit or stash/ }), null)
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('a clone expands to every copy as file:lines with its folder, each opens, and an agent can extract it', async () => {
  const clone = finding({
    id: 'dupes:dup:1',
    title: 'parseCsv',
    category: 'duplication',
    severity: 'info',
    detail: '11 lines · 2 copies',
    path: 'src/a.ts',
    line: 53,
    locations: [
      { path: 'src/a.ts', line: 53, endLine: 63 },
      { path: 'src/b.ts', line: 72, endLine: 82 }
    ],
    advice: 'Extract duplicated code (11 lines, 2 instances) into a shared function',
    docs: 'https://fallow.tools/docs/explanations/duplication/'
  })
  const opened: unknown[] = []
  const prompts: string[] = []
  const host = mockHost({
    requests: {
      'fallow.last': { ...ran, findings: [clone] },
      'fallow.open': (i) => (opened.push(i), { opened: true }),
      'fallow.askAgent': ({ prompt }) => (prompts.push(prompt), { started: true, focused: true, sent: true })
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ text: 'b.ts:72-82' }), null, 'copies start folded')
  await view.press({ label: 'Show the 2 copies of parseCsv' })
  assert.ok(view.find({ text: 'a.ts:53-63' }))
  assert.ok(view.find({ text: 'b.ts:72-82' }))
  await view.press({ label: 'Open src/b.ts:72-82' })
  assert.deepEqual(opened, [{ path: 'src/b.ts', line: 72 }])
  await view.press({ label: 'Hide the 2 copies of parseCsv' })
  assert.equal(view.find({ text: 'b.ts:72-82' }), null)
  await view.press({ label: 'Show actions for parseCsv' })
  assert.equal(view.find({ text: 'Ignore' }), null, 'a clone has no one-line ignore')
  await view.press({ text: 'Extract with agent' })
  assert.match(prompts[0], /src\/a\.ts:53-63\n- src\/b\.ts:72-82/)
  assert.match(prompts[0], /Fallow suggests: Extract duplicated code/)
  assert.ok(view.find({ text: /^An agent is working on "parseCsv" in the terminal tab Orca just opened/ }))
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('deleting an unused file and ignoring a finding both ask first', async () => {
  const unusedFile = finding({
    id: 'dc1:unused-file:abc',
    title: 'src/old.ts',
    deletable: true,
    suppress: { comment: '// fallow-ignore-file unused-file', line: null, path: 'src/old.ts' },
    locations: [{ path: 'src/old.ts', line: null, endLine: null }]
  })
  const calls: string[] = []
  const host = mockHost({
    requests: {
      'fallow.last': { ...ran, findings: [unusedFile] },
      'fallow.deleteFile': ({ path }) => (calls.push(`delete:${path}`), { analysis: { ...ran, findings: [] } }),
      'fallow.suppress': (s) => (calls.push(`suppress:${s.comment}`), { analysis: { ...ran, findings: [] } })
    }
  })
  const view = await mount(panel, { host })
  await unfold(view, 'Unused files')
  await view.press({ label: 'Show actions for src/old.ts' })
  assert.equal(view.valueOf({ label: 'Finding id' }), 'dc1:unused-file:abc')
  await view.press({ text: 'Ignore' })
  assert.ok(view.find({ text: /^Adds `\/\/ fallow-ignore-file unused-file` at the top of src\/old\.ts/ }))
  await view.press({ text: 'Cancel' })
  assert.deepEqual(calls, [])
  await view.press({ text: 'Delete file' })
  assert.deepEqual(calls, [], 'the first press only asks')
  await view.press({ text: 'Delete file' })
  assert.deepEqual(calls, ['delete:src/old.ts'])
  assert.ok(view.find({ text: /^Deleted src\/old\.ts\./ }))
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('the Health tab shows score, penalties, vital signs and every ranking, each file openable', async () => {
  const opened: unknown[] = []
  const view = await mount(panel, { host: mockHost({ requests: { 'fallow.last': ran, 'fallow.open': (i) => (opened.push(i), { opened: true }) } }) })
  await view.select({ label: 'View' }, 'health')
  assert.ok(view.find({ text: 'Grade A' }))
  assert.equal(view.find({ type: 'Progress', label: 'Health score' })?.props.value, 87.7)
  for (const t of ['Points taken off', 'Vital signs', 'Refactoring candidates', 'Hotspot candidates', 'Hidden change coupling', 'Least maintainable files']) assert.ok(view.find({ text: t }) ?? view.find({ label: t }), t)
  assert.ok(view.find({ text: /^91% degree · 5 shared commits · strong/ }))
  await view.press({ label: 'Open src/y.ts' })
  assert.deepEqual(opened, [{ path: 'src/y.ts', line: null }])
  await view.press({ label: 'Hide Hotspot candidates' })
  assert.equal(view.find({ text: 'src/hot.ts' }), null)
  await view.press({ label: 'Show Hotspot candidates' })
  await view.select({ label: 'View' }, 'findings')
  assert.ok(view.find({ label: 'Severity' }))
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('each category and the Agent tab hand a whole list to one agent, after asking', async () => {
  const clone = (n: number) =>
    finding({ id: `dupes:${n}`, title: `block${n}`, category: 'duplication', severity: 'info', locations: [{ path: `src/${n}a.ts`, line: 1, endLine: 9 }, { path: `src/${n}b.ts`, line: 1, endLine: 9 }] })
  const complex = finding({ id: 'h1', title: 'Template in page.svelte', category: 'complexity', severity: 'error', path: 'src/page.svelte', line: 131 })
  const batches: { kind: string; count: number }[] = []
  const host = mockHost({
    requests: {
      'fallow.last': { ...ran, findings: [clone(1), clone(2), complex, finding({ title: 'src/old.ts' })] },
      'fallow.askAgentBatch': ({ kind, count }) => (batches.push({ kind, count }), { started: true, focused: true, sent: true })
    }
  })
  const view = await mount(panel, { host })
  for (const t of ['Extract all with agent', 'Refactor all with agent']) assert.ok(view.find({ type: 'Button', text: t }), t)
  assert.ok(view.find({ label: 'Clean up all unused files with agent' }), 'categories get it too, as an icon')
  await view.press({ text: 'Extract all with agent' })
  assert.deepEqual(batches, [], 'the first press only asks')
  assert.ok(view.find({ label: 'One agent for 2 duplicated blocks?' }))
  assert.ok(view.find({ text: /^It runs `npx fallow dupes`/ }))
  await view.press({ text: 'Start agent' })
  assert.deepEqual(batches, [{ kind: 'duplication', count: 2 }])
  assert.ok(view.find({ text: /^One agent is working through 2 duplicated blocks .* starting from `npx fallow dupes`/ }))

  await view.select({ label: 'View' }, 'agent')
  for (const c of ['npx fallow dupes', 'npx fallow health --complexity', 'npx fallow dead-code --unused-files', 'npx fallow health --targets', 'npx fallow health --hotspots']) assert.ok(view.find({ text: c }), c)
  assert.equal(view.find({ text: 'npx fallow dead-code --circular-deps' }), null, 'an empty list gets no row')
  await view.press({ text: 'Simplify all' })
  await view.press({ text: 'Start agent' })
  assert.deepEqual(batches[1], { kind: 'hotspots', count: 1 })
  assert.deepEqual(view.refusals, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('every Health card row has its own agent button', async () => {
  const prompts: string[] = []
  const host = mockHost({ requests: { 'fallow.last': ran, 'fallow.askAgent': ({ prompt }) => (prompts.push(prompt), { started: true, focused: true, sent: true }) } })
  const view = await mount(panel, { host })
  await view.select({ label: 'View' }, 'health')
  for (const t of ['src/big.ts', 'src/hot.ts', 'src/x.ts ↔ src/y.ts', 'src/bad.ts']) assert.ok(view.find({ label: `Fix with agent: ${t}` }), t)
  await view.press({ label: 'Fix with agent: src/x.ts ↔ src/y.ts' })
  assert.match(prompts[0], /^Fallow reports this in the project: src\/x\.ts ↔ src\/y\.ts \(hidden change coupling\)/)
  assert.match(prompts[0], /- src\/x\.ts\n- src\/y\.ts/)
  await view.unmount()
})

test('findings read as the VS Code sidebar: Unused Code, Duplicates, Complexity and Security Candidates', async () => {
  const prompts: string[] = []
  const opened: unknown[] = []
  const security = {
    candidates: [
      { id: 's1', category: 'ssrf', cwe: 918, severity: 'medium', path: 'src/server/api.ts', line: 7, evidence: 'Non-literal URL passed to fetch()', trace: [{ path: 'src/server/api.ts', line: 7, endLine: null }], reachableFromUntrusted: true },
      { id: 's2', category: 'ssrf', cwe: 918, severity: 'low', path: 'src/server/img.ts', line: 3, evidence: 'Dynamic path', trace: [], reachableFromUntrusted: false },
      { id: 's3', category: 'path-traversal', cwe: 22, severity: 'low', path: 'src/files.ts', line: 9, evidence: 'fs.readFile with a dynamic path', trace: [], reachableFromUntrusted: false }
    ],
    blindSpots: { unresolvedImports: 0, unresolvedCallees: 697 }
  }
  const host = mockHost({
    requests: {
      'fallow.last': { ...ran, security },
      'fallow.open': (i) => (opened.push(i), { opened: true }),
      'fallow.askAgent': ({ prompt }) => (prompts.push(prompt), { started: true, focused: true, sent: true })
    }
  })
  const view = await mount(panel, { host })
  for (const t of ['Unused Code', 'Complexity', 'Security Candidates']) assert.ok(view.find({ text: t }), t)
  assert.ok(view.find({ text: 'Unused files (1)' }))
  assert.equal(view.find({ text: 'src/old.ts' }), null, 'categories start folded')
  assert.ok(view.find({ text: /^ssrf \(CWE-918\) \(2\)/ }))
  assert.ok(view.find({ text: /^path-traversal \(CWE-22\) \(1\)/ }))
  assert.ok(view.find({ text: /^Blind spots: 0 unresolved import edges, 697 unresolved call sites/ }))
  await view.press({ label: 'Show ssrf' })
  assert.ok(view.find({ text: 'api.ts:7' }))
  assert.ok(view.find({ text: /^medium · reachable from untrusted input · Non-literal URL/ }))
  await view.press({ label: 'Open src/server/api.ts:7' })
  assert.deepEqual(opened, [{ path: 'src/server/api.ts', line: 7 }])
  await view.press({ label: 'Verify with agent: ssrf (CWE-918) in src/server/api.ts:7' })
  assert.match(prompts[0], /\(security candidate to verify\)/)
  assert.match(prompts[0], /Verify whether untrusted input really reaches this sink/)
  await view.press({ label: 'Hide Security Candidates' })
  assert.equal(view.find({ text: /^ssrf/ }), null)
  await view.select({ label: 'View' }, 'agent')
  assert.ok(view.find({ text: 'npx fallow security' }))
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
