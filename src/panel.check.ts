// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh host.
import { defineCheck } from 'orca/testing'
import type { Analysis, Finding } from './protocol'

const f = (over: Partial<Finding>): Finding => ({
  id: String(Math.random()),
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

const ran: Analysis = {
  path: '/home/dev/apps/shop',
  version: '3.44.0',
  ranAt: 1,
  elapsedMs: 1240,
  health: {
    score: 87.7,
    grade: 'A',
    duplication: 0.73,
    penalties: [{ key: 'Function size', points: 10 }, { key: 'Coupling', points: 1.6 }],
    vitals: [
      { group: 'Codebase', label: 'Files', value: '331' },
      { group: 'Codebase', label: 'Lines of code', value: '36,289' },
      { group: 'Complexity', label: 'Functions over the limit', value: '110 of 1,596', tone: 'danger' },
      { group: 'Function size', label: 'High · very high risk', value: '3.7% · 4.8%', tone: 'warning' }
    ],
    hotspots: Array.from({ length: 20 }, (_, i) => ({ path: `src/routes/(shop)/page-${i}.server.ts`, score: 27.6 - i, commits: 11, trend: 'accelerating' })),
    targets: [{ path: 'packages/domain/orders/order-summary.ts', recommendation: 'Split high-impact file (34 LOC), 9 dependents amplify every change', effort: 'medium', confidence: 'medium', priority: 26 }],
    coupling: [{ a: 'src/routes/(shop)/+page.server.ts', b: 'src/routes/(shop)/shop.stories.svelte', degree: 0.91, shared: 5, strong: true }],
    files: [{ path: 'src/lib/components/dashboard/dashboard.svelte', maintainability: 77.7, cyclomatic: 125, lines: 379, fanIn: 2, fanOut: 21 }],
    scope: 'Limits: cyclomatic 20, cognitive 15 · hotspots over 6 months',
    frameworks: ['svelte', 'sveltekit']
  },
  findings: [
    f({ title: './logo.png', category: 'unresolved-imports', severity: 'error', detail: 'Imported in src/page.svelte:149', path: 'src/page.svelte', line: 149 }),
    f({ title: 'src/lib/components/orders/order-editor/order-editor-with-a-very-long-name.svelte' }),
    f({ title: '11 lines in 2 places', category: 'duplication', severity: 'info', detail: 'src/a.svelte:53, src/b.svelte:72', path: 'src/a.svelte', line: 53 }),
    ...Array.from({ length: 200 }, (_, i) =>
      f({ title: `Template in page-${i}.svelte`, category: 'complexity', severity: i % 3 ? 'info' : 'error', detail: `src/routes/page-${i}.svelte:131 · cyclomatic 23, cognitive 42, 304 lines`, path: `src/routes/page-${i}.svelte`, line: 131 })
    )
  ]
}

export default defineCheck({
  noWorkspace: { requests: { 'fallow.last': { ...ran, path: null, ranAt: null, health: null, findings: [], error: 'No workspace is focused.' } } },
  beforeFirstRun: { requests: { 'fallow.last': { ...ran, ranAt: null, health: null, findings: [] } } },
  ran: { requests: { 'fallow.last': ran } },
  health: { requests: { 'fallow.last': ran }, persisted: { plugin: { view: 'health' } } }
})
