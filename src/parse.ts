// Turns Fallow's JSON (`fallow --score --format json`, schema 11) into the panel's findings.
// Fallow grows new issue types often: an unknown array still lands under "Other" instead of vanishing.
import type { AgentItem, Analysis, BatchKind, CategoryId, Finding, Fix, FixPlan, Health, Location, Security, SecurityCandidate, Suppression } from './protocol'

type Json = Record<string, any>

/** Fallow's issue arrays under `check`, and the category each belongs to. */
const CHECK: Record<string, CategoryId> = {
  unused_files: 'unused-files',
  unused_exports: 'unused-exports',
  unused_types: 'unused-types',
  private_type_leaks: 'unused-types',
  unused_dependencies: 'unused-dependencies',
  unused_dev_dependencies: 'unused-dependencies',
  unused_optional_dependencies: 'unused-dependencies',
  type_only_dependencies: 'unused-dependencies',
  test_only_dependencies: 'unused-dependencies',
  dev_dependencies_in_production: 'unused-dependencies',
  unused_catalog_entries: 'unused-dependencies',
  unused_dependency_overrides: 'unused-dependencies',
  unused_enum_members: 'unused-members',
  unused_class_members: 'unused-members',
  unused_namespace_members: 'unused-members',
  unresolved_imports: 'unresolved-imports',
  unresolved_catalog_references: 'unresolved-imports',
  unlisted_dependencies: 'unlisted-dependencies',
  unlisted_binaries: 'unlisted-dependencies',
  circular_dependencies: 'circular-dependencies',
  re_export_cycles: 'circular-dependencies',
  package_cycles: 'circular-dependencies',
  duplicate_exports: 'duplicate-exports',
  boundary_violations: 'boundaries',
  boundary_coverage_violations: 'boundaries',
  boundary_call_violations: 'boundaries',
  policy_violations: 'boundaries'
}

/** Arrays under `check` that are bookkeeping, not findings. */
const NOT_FINDINGS = new Set(['entry_points', 'next_steps', 'workspace_diagnostics'])

/** Fallow's default severities: unresolved imports break the build, unused files and deps warn. */
const ERROR_CATEGORIES = new Set<CategoryId>(['unresolved-imports', 'circular-dependencies', 'unlisted-dependencies'])

const DOCS = 'https://fallow.tools/docs/explanations'
/** `unused_dev_dependencies` → the heading anchor on Fallow's "dead code explained" page. */
const docsFor = (key: string) =>
  `${DOCS}/dead-code/#${key.replace(/_/g, '-').replace('dev-dependencies', 'devdependencies').replace('optional-dependencies', 'optionaldependencies')}`

const words = (key: string) => key.replace(/_/g, ' ')
const at = (path: string | null, line: number | null) => (path ? (line ? `${path}:${line}` : path) : '')

/** The one thing a finding is about, whichever field this issue type uses for it. */
function subject(f: Json): string {
  return f.export_name ?? f.name ?? f.member_name ?? f.package_name ?? f.binary_name ?? f.specifier ?? f.dependency ?? f.path ?? f.finding_id ?? 'finding'
}

/**
 * Fallow's own suppression for this finding, placed where its docs say. A dependency lives in
 * package.json, where a comment does nothing: Fallow points at the config instead, so no button.
 */
function suppressionOf(actions: Json[] | undefined, path: string | null, line: number | null): Suppression | null {
  if (!path || path.endsWith('.json')) return null
  const file = actions?.find((x) => x.type === 'suppress-file' && x.comment)
  if (file) return { comment: String(file.comment), line: null, path }
  const next = actions?.find((x) => x.type === 'suppress-line' && x.comment)
  if (next && line) return { comment: String(next.comment), line, path }
  return null
}

/** Fallow's advice for what only a person or an agent can do: extract, refactor, add tests. */
function adviceOf(actions: Json[] | undefined): string | null {
  const a = actions?.find((x) => !x.auto_fixable && !String(x.type).startsWith('suppress') && x.type !== 'add-to-config' && x.description)
  return a ? [a.description, a.note].filter(Boolean).join('. ') : null
}

function fromCheck(key: string, f: Json, category: CategoryId): Finding {
  const where = f.path ?? f.used_in?.[0]?.path ?? f.files?.[0] ?? f.cycle?.[0] ?? null
  const line = f.line ?? f.used_in?.[0]?.line ?? null
  const cycle: string[] | undefined = Array.isArray(f.files) ? f.files : Array.isArray(f.cycle) ? f.cycle : undefined
  let title = subject(f)
  let detail = at(where, line)
  if (category === 'unused-files') {
    title = f.path
    detail = 'No entry point reaches this file'
  } else if (category === 'unresolved-imports') {
    detail = `Imported in ${at(where, line)}`
  } else if (key === 'unlisted_binaries') {
    const s = f.used_in?.[0]
    detail = s?.script_name ? `Script "${s.script_name}" in ${at(s.path, s.line)}` : detail
  } else if (cycle?.length) {
    title = `${cycle.length} files import each other`
    detail = cycle.join(' → ')
  } else if (category === 'unused-dependencies' && key !== 'unused_dependencies') {
    detail = `${words(key)}${detail ? ` · ${detail}` : ''}`
  }
  const locations: Location[] = cycle?.length
    ? [...new Set(cycle)].map((p) => ({ path: p, line: null, endLine: null }))
    : Array.isArray(f.used_in) && f.used_in.length > 1
      ? f.used_in.map((u: Json) => ({ path: u.path, line: u.line ?? null, endLine: null }))
      : where
        ? [{ path: where, line, endLine: null }]
        : []
  // `auto_fixable` is per finding, not per action type: read it on each one.
  const fix = (f.actions as Json[] | undefined)?.find((x) => x.auto_fixable === true && !String(x.type).startsWith('suppress'))
  return {
    id: f.finding_id ?? `${key}:${title}:${detail}`,
    category,
    title: String(title),
    detail,
    severity: ERROR_CATEGORIES.has(category) ? 'error' : 'warning',
    path: where,
    line,
    fix: fix ? String(fix.description ?? fix.type) : null,
    deletable: category === 'unused-files' && !!f.path,
    suppress: suppressionOf(f.actions, where, line),
    locations,
    advice: adviceOf(f.actions),
    docs: CHECK[key] ? docsFor(key) : null
  }
}

function fromHealth(f: Json): Finding {
  const name = f.name === '<template>' ? 'Template' : f.name
  return {
    id: `health:${f.path}:${f.line}:${f.name}`,
    category: 'complexity',
    title: `${name} in ${f.path.split('/').pop()}`,
    detail: `${at(f.path, f.line)} · cyclomatic ${f.cyclomatic}, cognitive ${f.cognitive}, ${f.line_count} lines`,
    severity: f.severity === 'critical' ? 'error' : f.severity === 'high' ? 'warning' : 'info',
    path: f.path,
    line: f.line ?? null,
    fix: null,
    deletable: false,
    suppress: suppressionOf(f.actions, f.path, f.line ?? null),
    locations: [{ path: f.path, line: f.line ?? null, endLine: f.line && f.line_count ? f.line + f.line_count - 1 : null }],
    advice: adviceOf(f.actions),
    docs: `${DOCS}/health/`
  }
}

function fromClone(g: Json, i: number): Finding {
  const parts: Json[] = g.instances ?? []
  const first = parts[0]
  const lines = g.line_count ?? (first ? first.end_line - first.start_line + 1 : 0)
  const name = g.suggested_name ?? (first ? first.file.split('/').pop() : 'Duplicated code')
  return {
    id: `dupes:${g.fingerprint ?? i}:${first?.file}:${first?.start_line}`,
    category: 'duplication',
    title: String(name),
    detail: `${lines} lines · ${parts.length} copies`,
    severity: 'info',
    path: first?.file ?? null,
    line: first?.start_line ?? null,
    fix: null,
    deletable: false,
    // A clone has a copy per file: a line comment hides only one, so the range Fallow suggests is
    // what silences this clone and not its neighbours. That needs the block's end, which agents handle.
    suppress: null,
    locations: parts.map((p) => ({ path: p.file, line: p.start_line ?? null, endLine: p.end_line ?? null })),
    advice: adviceOf(g.actions),
    docs: `${DOCS}/duplication/`
  }
}

export function parse(json: Json, path: string, ranAt: number): Analysis {
  const check: Json = json.check ?? (json.kind === 'dead-code' ? json : {})
  const findings: Finding[] = []
  for (const [key, value] of Object.entries(check)) {
    if (!Array.isArray(value) || NOT_FINDINGS.has(key)) continue
    const category = CHECK[key] ?? 'other'
    for (const f of value) if (f && typeof f === 'object') findings.push(fromCheck(key, f, category))
  }
  for (const [i, g] of (json.dupes?.clone_groups ?? []).entries()) findings.push(fromClone(g, i))
  for (const f of json.health?.findings ?? []) findings.push(fromHealth(f))

  const score = json.health?.health_score ?? json.health_score
  const health: Health | null = score ? healthOf(json.health ?? {}, score, json.dupes?.stats?.duplication_percentage ?? 0) : null
  return { path, version: json.version ?? null, ranAt, elapsedMs: json.elapsed_ms ?? null, health, findings, security: null }
}

/** `fallow security --format json`: candidates grouped later by category, plus Fallow's blind spots. */
export function parseSecurity(json: Json): Security {
  const candidates: SecurityCandidate[] = ((json.security_findings ?? []) as Json[]).map((f) => ({
    id: String(f.stable_finding_id ?? f.finding_id ?? `${f.path}:${f.line}`),
    category: String(f.category ?? f.kind ?? 'security'),
    cwe: typeof f.cwe === 'number' ? f.cwe : null,
    severity: String(f.severity ?? 'medium'),
    path: f.path,
    line: f.line ?? null,
    evidence: String(f.evidence ?? ''),
    trace: ((f.reachability?.untrusted_source_trace ?? f.trace ?? []) as Json[]).map((t) => ({ path: t.path, line: t.line ?? null, endLine: null })),
    reachableFromUntrusted: !!f.reachability?.reachable_from_untrusted_source
  }))
  const edges = json.unresolved_edge_files
  return {
    candidates,
    blindSpots: {
      unresolvedImports: Array.isArray(edges) ? edges.length : typeof edges === 'number' ? edges : 0,
      unresolvedCallees: typeof json.unresolved_callee_sites === 'number' ? json.unresolved_callee_sites : (json.unresolved_callee_sites?.length ?? 0)
    }
  }
}

// The same names the VS Code extension and Fallow's docs use for each penalty and vital sign.
const PENALTY_LABEL: Record<string, string> = {
  dead_files: 'Unused files',
  dead_exports: 'Unused exports',
  complexity: 'Complexity',
  p90_complexity: 'P90 complexity',
  maintainability: 'Maintainability',
  hotspots: 'Hotspots',
  unused_deps: 'Unused dependencies',
  circular_deps: 'Circular dependencies',
  unit_size: 'Function size',
  coupling: 'Coupling',
  duplication: 'Duplication'
}

const pct = (n: unknown) => (typeof n === 'number' ? `${n.toFixed(1)}%` : '–')
const num = (n: unknown, digits = 0) => (typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: digits }) : '–')
type Tone = 'success' | 'warning' | 'danger'
const bad = (n: unknown, warn: number, danger: number): Tone | undefined =>
  typeof n !== 'number' ? undefined : n >= danger ? 'danger' : n >= warn ? 'warning' : 'success'

function healthOf(h: Json, score: Json, duplication: number): Health {
  const v: Json = h.vital_signs ?? {}
  const c: Json = v.counts ?? {}
  const s: Json = h.summary ?? {}
  const size: Json = v.unit_size_profile ?? {}
  const iface: Json = v.unit_interfacing_profile ?? {}
  const vitals: Health['vitals'] = [
    { group: 'Codebase', label: 'Files', value: num(c.total_files ?? s.files_analyzed) },
    { group: 'Codebase', label: 'Lines', value: num(v.total_loc ?? c.total_lines) },
    { group: 'Codebase', label: 'Functions', value: num(s.functions_analyzed) },
    { group: 'Codebase', label: 'Exports', value: num(c.total_exports) },
    { group: 'Dead code', label: 'Unused files', value: `${num(c.dead_files)} (${pct(v.dead_file_pct)})`, tone: bad(v.dead_file_pct, 1, 5) },
    { group: 'Dead code', label: 'Unused exports', value: `${num(c.dead_exports)} (${pct(v.dead_export_pct)})`, tone: bad(v.dead_export_pct, 5, 15) },
    { group: 'Dead code', label: 'Unused deps', value: num(v.unused_dep_count), tone: bad(v.unused_dep_count, 1, 5) },
    { group: 'Dead code', label: 'Circular deps', value: num(v.circular_dep_count), tone: bad(v.circular_dep_count, 1, 3) },
    { group: 'Complexity', label: 'Avg cyclomatic', value: num(v.avg_cyclomatic, 1), tone: bad(v.avg_cyclomatic, 5, 10) },
    { group: 'Complexity', label: 'P90 cyclomatic', value: num(v.p90_cyclomatic), tone: bad(v.p90_cyclomatic, 10, 20) },
    { group: 'Complexity', label: 'Over the limit', value: `${num(s.functions_above_threshold)}/${num(s.functions_analyzed)}`, tone: bad(s.functions_above_threshold, 1, 50) },
    { group: 'Complexity', label: 'Critical/high/mod.', value: `${num(s.severity_critical_count)}/${num(s.severity_high_count)}/${num(s.severity_moderate_count)}` },
    { group: 'Complexity', label: 'Critical', value: pct(v.critical_complexity_pct), tone: bad(v.critical_complexity_pct, 1, 5) },
    { group: 'Maintainability', label: 'Avg index', value: num(v.maintainability_avg ?? s.average_maintainability, 1), tone: typeof v.maintainability_avg === 'number' ? bad(100 - v.maintainability_avg, 15, 35) : undefined },
    { group: 'Maintainability', label: 'Low files', value: pct(v.maintainability_low_pct), tone: bad(v.maintainability_low_pct, 2, 10) },
    { group: 'Maintainability', label: 'Duplicated', value: `${num(c.duplicated_lines)} (${pct(v.duplication_pct ?? duplication)})`, tone: bad(v.duplication_pct ?? duplication, 3, 10) },
    { group: 'Function size', label: 'Low/medium', value: `${pct(size.low_risk)}/${pct(size.medium_risk)}` },
    { group: 'Function size', label: 'High/very high', value: `${pct(size.high_risk)}/${pct(size.very_high_risk)}`, tone: bad((size.high_risk ?? 0) + (size.very_high_risk ?? 0), 5, 15) },
    { group: 'Function size', label: '>60 lines per 1k', value: num(v.functions_over_60_loc_per_k, 1) },
    { group: 'Coupling', label: 'Many params', value: `${pct(iface.high_risk)}/${pct(iface.very_high_risk)}` },
    { group: 'Coupling', label: 'P95 fan-in', value: num(v.p95_fan_in) },
    { group: 'Coupling', label: 'Highly coupled', value: pct(v.coupling_high_pct), tone: bad(v.coupling_high_pct, 5, 15) },
    { group: 'Coupling', label: 'Hotspots', value: `${num(v.hotspot_count)}${v.hotspot_top_pct_count != null ? ` (${num(v.hotspot_top_pct_count)} top)` : ''}` }
  ].filter((r) => !r.value.split(/[ /()]+/).filter(Boolean).every((x) => x === '–'))

  const thresholds = [
    s.max_cyclomatic_threshold && `cyclomatic ${s.max_cyclomatic_threshold}`,
    s.max_cognitive_threshold && `cognitive ${s.max_cognitive_threshold}`,
    s.max_crap_threshold && `CRAP ${s.max_crap_threshold}`,
    s.max_unit_size_threshold && `${s.max_unit_size_threshold} lines`
  ].filter(Boolean)
  const since = h.hotspot_summary?.since
  return {
    score: score.score,
    grade: score.grade,
    duplication,
    penalties: Object.entries((score.penalties ?? {}) as Record<string, number>)
      .filter(([, p]) => typeof p === 'number' && p > 0)
      .map(([key, points]) => ({ key: PENALTY_LABEL[key] ?? words(key), points }))
      .sort((a, b) => b.points - a.points),
    vitals,
    hotspots: ((h.hotspots ?? []) as Json[])
      .filter((x) => x.score > 0)
      .slice(0, 20)
      .map((x) => ({ path: x.path, score: x.score, commits: x.commits, trend: x.trend ?? null })),
    targets: ((h.targets ?? []) as Json[]).slice(0, 20).map((t) => ({ path: t.path, recommendation: t.recommendation, effort: t.effort, confidence: t.confidence, priority: t.priority })),
    coupling: ((h.change_coupling?.pairs ?? []) as Json[]).map((p) => ({ a: p.path_a, b: p.path_b, degree: p.degree, shared: p.shared_revisions, strong: !!p.strong })),
    files: ((h.file_scores ?? []) as Json[])
      .filter((f) => typeof f.maintainability_index === 'number')
      .sort((a, b) => a.maintainability_index - b.maintainability_index)
      .slice(0, 15)
      .map((f) => ({ path: f.path, maintainability: f.maintainability_index, cyclomatic: f.total_cyclomatic, lines: f.lines, fanIn: f.fan_in, fanOut: f.fan_out })),
    scope: [
      thresholds.length ? `Limits: ${thresholds.join(', ')}` : '',
      since ? `hotspots over ${since}` : '',
      s.coverage_model ? `coverage ${String(s.coverage_model).replace(/_/g, ' ')}` : ''
    ]
      .filter(Boolean)
      .join(' · '),
    frameworks: h.framework_health?.detected_frameworks ?? []
  }
}

/** `fallow fix --format json`: its `fixes[]` entries and its skip counters. */
export function parseFix(json: Json): FixPlan {
  const fixes: Fix[] = (json.fixes ?? []).map((x: Json) => ({
    type: String(x.type),
    file: x.path ?? x.file ?? 'package.json',
    line: x.line ?? null,
    name: x.name ?? x.package ?? x.member ?? x.export ?? x.type,
    ...(x.applied !== undefined ? { applied: !!x.applied } : {}),
    ...(x.skip_reason ? { skipReason: String(x.skip_reason) } : {})
  }))
  const skipped = Object.entries(json)
    .filter(([k, v]) => k.startsWith('skipped') && typeof v === 'number')
    .reduce((n, [, v]) => n + (v as number), 0)
  return { fixes, skipped }
}

/** One line a person reads in the preview: "Remove export `unusedGreeting` · src/greet.ts:5". */
export function describeFix(f: Fix): string {
  const what: Record<string, string> = {
    remove_export: 'Remove export',
    remove_dependency: 'Remove dependency',
    remove_enum_member: 'Remove enum member',
    remove_class_member: 'Remove class member',
    remove_catalog_entry: 'Remove catalog entry',
    add_ignore_exports: 'Ignore duplicate export'
  }
  const verb = what[f.type] ?? f.type.replace(/_/g, ' ')
  return `${verb} \`${f.name}\` · ${f.line ? `${f.file}:${f.line}` : f.file}`
}

// terminal.sendText takes at most 4096 characters; the prompt must fit, with room to spare.
export const PROMPT_MAX = 4000

const locationsOf = (f: Pick<AgentItem, 'locations'>) =>
  f.locations.map((l) => `${l.path}${l.line ? `:${l.line}${l.endLine && l.endLine !== l.line ? `-${l.endLine}` : ''}` : ''}`)

export const asItem = (f: Finding): AgentItem => ({
  title: f.title,
  kind: f.category.replace(/-/g, ' '),
  detail: f.detail,
  locations: f.locations,
  advice: f.advice,
  docs: f.docs
})

const one = (path: string): Location[] => [{ path, line: null, endLine: null }]

/**
 * Health cards as agent work. Fallow's JSON gives targets a recommendation; for hotspots,
 * coupling and maintainability its docs say what to do, so that advice is spelled out here.
 */
export function healthItems(h: Health): Record<'targets' | 'hotspots' | 'coupling' | 'files', AgentItem[]> {
  return {
    targets: h.targets.map((t) => ({
      title: t.path,
      kind: 'refactoring candidate',
      detail: `effort ${t.effort}, confidence ${t.confidence}, priority ${t.priority.toFixed(0)}`,
      locations: one(t.path),
      advice: t.recommendation,
      docs: `${DOCS}/health/`
    })),
    hotspots: h.hotspots.map((x) => ({
      title: x.path,
      kind: 'hotspot',
      detail: `hotspot score ${x.score.toFixed(1)}, ${x.commits} commits${x.trend ? `, ${x.trend}` : ''}`,
      locations: one(x.path),
      advice: 'It changes often and is complex: lower its complexity or split it so the next change is cheaper and safer',
      docs: `${DOCS}/health/`
    })),
    coupling: h.coupling.map((p) => ({
      title: `${p.a} ↔ ${p.b}`,
      kind: 'hidden change coupling',
      detail: `${(p.degree * 100).toFixed(0)}% of their commits change both, ${p.shared} shared commits, and no import connects them`,
      locations: [...one(p.a), ...one(p.b)],
      advice: 'Find the concept both files encode and make it explicit in one shared module, or remove the hidden dependency between them',
      docs: `${DOCS}/health/#change-coupling`
    })),
    files: h.files.map((f) => ({
      title: f.path,
      kind: 'low maintainability',
      detail: `maintainability index ${f.maintainability.toFixed(1)}, cyclomatic ${f.cyclomatic}, ${f.lines} lines, fan-in ${f.fanIn}, fan-out ${f.fanOut}`,
      locations: one(f.path),
      advice: 'Raise its maintainability: split long functions, cut deep branching and reduce how many modules it depends on',
      docs: `${DOCS}/health/`
    }))
  }
}

/**
 * The Fallow command that prints each list, and what to do with it. The agent runs the command
 * itself, so it always works on the current list, not on a copy taken when the button was pressed.
 */
export const BATCH_COMMAND: Record<BatchKind, { command: string; task: string }> = {
  all: {
    command: 'npx fallow',
    task: 'work through every finding it reports, starting with unresolved imports and circular dependencies, then unused code, then duplication; leave complexity and health work for last'
  },
  'unused-code': {
    command: 'npx fallow dead-code',
    task: 'clean up all of it: fix unresolved imports and cycles, remove unused exports, types, members and dependencies, and delete files that really are unused'
  },
  'unused-types': { command: 'npx fallow dead-code --unused-types', task: 'remove the export from each unused type, or delete the type when nothing uses it at all' },
  'unused-members': {
    command: 'npx fallow dead-code --unused-enum-members --unused-class-members',
    task: 'remove each unused enum member and class member, checking first that nothing reaches it dynamically'
  },
  'unlisted-dependencies': {
    command: 'npx fallow dead-code --unlisted-deps --unlisted-binaries',
    task: 'add each package the code or a script uses but package.json does not list, as a dependency or a devDependency as it is used'
  },
  'duplicate-exports': { command: 'npx fallow dead-code --duplicate-exports', task: 'keep one export of each name and point every import at it' },
  boundaries: { command: 'npx fallow dead-code --boundary-violations', task: "move each import that crosses an architecture boundary so it respects the project's zones" },
  health: {
    command: 'npx fallow health --complexity --hotspots --targets --file-scores',
    task: 'raise the health score: simplify the complex functions, then act on the hotspots, the refactoring candidates and the least maintainable files'
  },
  coupling: {
    command: 'npx fallow health --hotspots',
    task: 'for each pair of files Fallow reports as changing together with no import between them, make the shared concept explicit in one module or remove the hidden dependency'
  },
  'unused-files': { command: 'npx fallow dead-code --unused-files', task: 'delete each unused file that really is unused; keep any loaded in a way static analysis cannot see (dynamic imports, config, scripts) and say why' },
  'unused-exports': { command: 'npx fallow dead-code --unused-exports', task: 'remove the export keyword from each unused export, or delete the code when nothing uses it at all' },
  'unused-dependencies': { command: 'npx fallow dead-code --unused-deps', task: 'remove each unused dependency from package.json, then run the package manager install' },
  'circular-dependencies': { command: 'npx fallow dead-code --circular-deps', task: 'break each import cycle, usually by moving the shared part into its own module' },
  'unresolved-imports': { command: 'npx fallow dead-code --unresolved-imports', task: 'fix each import that does not resolve: correct the path, add the missing file, or install the missing package' },
  duplication: { command: 'npx fallow dupes', task: 'extract each group of duplicated code into one shared function or component, and use it from every copy' },
  complexity: { command: 'npx fallow health --complexity', task: "simplify each function above Fallow's complexity limits: extract helpers, flatten nested branches, split long functions" },
  targets: { command: 'npx fallow health --targets', task: "act on each of Fallow's refactoring candidates, following its recommendation for that file" },
  hotspots: { command: 'npx fallow health --hotspots', task: 'lower the complexity of each hotspot (a file changed often and complex) so the next change is cheaper and safer' },
  files: { command: 'npx fallow health --file-scores', task: 'raise the maintainability of the files with the lowest scores: split long functions, cut deep branching, reduce dependencies' },
  security: {
    command: 'npx fallow security',
    task: 'verify each security candidate: trace whether untrusted input really reaches the sink; fix the ones that are real (validate, encode, allowlist), and for the ones that are not, explain why without changing code'
  }
}

/** One short prompt for a whole list: which Fallow command to run, and how to work through it. */
export function batchPrompt(kind: BatchKind, count: number): string {
  const { command, task } = BATCH_COMMAND[kind]
  const heuristic =
    kind === 'security'
      ? ' These are unverified candidates from static analysis, not confirmed vulnerabilities.'
      : kind === 'hotspots' || kind === 'targets' || kind === 'files' || kind === 'coupling' || kind === 'health'
        ? ' These rankings come from heuristics and Git history: confirm each one in the code before changing it.'
        : ''
  const prompt = [
    `Run \`${command}\` in this project. It lists ${count} ${count === 1 ? 'item' : 'items'} to fix. Then ${task}.${heuristic}`,
    'Work through them in the order Fallow lists them. For each, make the smallest change that resolves it without changing behaviour; skip any whose fix would change behaviour, and say why.',
    'Never silence a finding with a fallow-ignore comment or a .fallowrc.json entry unless it is the only correct answer, and then ask me first.',
    `After every few items run the type check and the tests. At the end run \`${command}\` again and report what is resolved, what you skipped, and what remains. Do not commit.`
  ].join('\n\n')
  return prompt.slice(0, PROMPT_MAX)
}

/** What an agent gets when asked to act on one finding, or one Health card row. */
export function agentPrompt(f: Finding | AgentItem): string {
  const item = 'category' in f ? asItem(f) : f
  return itemPrompt(item)
}

function itemPrompt(f: AgentItem): string {
  const where = locationsOf(f).map((l) => `- ${l}`).join('\n')
  return [
    `Fallow reports this in the project: ${f.title} (${f.kind}).`,
    f.detail,
    where ? `Locations:\n${where}` : '',
    f.advice ? `Fallow suggests: ${f.advice}` : '',
    f.docs ? `What this finding means: ${f.docs}` : '',
    'Make the smallest change that resolves it without changing behaviour. Never silence it with a fallow-ignore comment or a .fallowrc.json entry unless that is the only correct answer, and then ask me first. Run the type check and tests, then run `npx fallow` to confirm the finding is gone. Do not commit.'
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, PROMPT_MAX)
}
