// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

/** One problem Fallow reports, flattened from its JSON so the panel never reads Fallow's schema. */
export type Finding = {
  /** Fallow's own stable id, e.g. `dc1:unused-file:0c52ee4b549581b3`; unique per run. */
  id: string
  category: CategoryId
  /** What a person reads first: a file, an export name, a dependency. */
  title: string
  /** Where, and anything else worth one line. */
  detail: string
  severity: 'error' | 'warning' | 'info'
  /** Workspace-relative file to open, when the finding has one. */
  path: string | null
  line: number | null
  /** What `fallow fix` would do, when Fallow marks this finding safe to fix. */
  fix: string | null
  /** For an unused file: delete it, as the VS Code quick fix "Delete this unused file" does. */
  deletable: boolean
  /** The comment Fallow suggests to silence this finding, and where it goes. */
  suppress: Suppression | null
  /** Every place the finding spans: each copy of a clone, each file of a cycle. */
  locations: Location[]
  /** Fallow's own advice for findings it cannot fix (extract, refactor), for an agent to act on. */
  advice: string | null
  /** The fallow.tools docs page for this issue type. */
  docs: string | null
}

export type Location = { path: string; line: number | null; endLine: number | null }

/** One piece of work an agent gets: a finding, or a Health card row. */
export type AgentItem = {
  title: string
  /** What it is, for the prompt: "duplication", "refactoring candidate"… */
  kind: string
  detail: string
  locations: Location[]
  advice: string | null
  docs?: string | null
}

/** The lists one agent can work through in one go, each the output of one Fallow command. */
export type BatchKind =
  | 'unused-files'
  | 'unused-exports'
  | 'unused-dependencies'
  | 'circular-dependencies'
  | 'unresolved-imports'
  | 'duplication'
  | 'complexity'
  | 'targets'
  | 'hotspots'
  | 'files'
  | 'security'

export type Suppression = {
  /** The exact comment, e.g. `// fallow-ignore-next-line unused-export`. */
  comment: string
  /** Inserted above this 1-based line; `null` puts it at the top of the file. */
  line: number | null
  path: string
}

/** One edit `fallow fix` plans or made, flattened from its JSON. */
export type Fix = {
  /** `remove_export`, `remove_dependency`, `remove_enum_member`… */
  type: string
  /** The file it edits, workspace-relative. */
  file: string
  line: number | null
  /** The export, dependency or member it removes. */
  name: string
  /** Set once applied: whether Fallow wrote it, or why it skipped it. */
  applied?: boolean
  skipReason?: string
}

export type FixPlan = {
  fixes: Fix[]
  /** Edits Fallow held back as unsafe (low confidence, changed on disk, mixed line endings). */
  skipped: number
  /** The run failed before planning anything. */
  error?: string
}

export type CategoryId =
  | 'unused-files'
  | 'unused-exports'
  | 'unused-types'
  | 'unused-dependencies'
  | 'unused-members'
  | 'unresolved-imports'
  | 'unlisted-dependencies'
  | 'circular-dependencies'
  | 'duplicate-exports'
  | 'boundaries'
  | 'duplication'
  | 'complexity'
  | 'other'

export type Health = {
  score: number
  grade: string
  /** Share of lines Fallow found duplicated, 0–100. */
  duplication: number
  /** Points each factor takes off the score, largest first. */
  penalties: { key: string; points: number }[]
  /** Fallow's vital signs, as label/value rows ready to show. */
  vitals: { group: string; label: string; value: string; tone?: 'success' | 'warning' | 'danger' }[]
  /** Files changed often and complex: Fallow's churn x complexity ranking. */
  hotspots: { path: string; score: number; commits: number; trend: string | null }[]
  /** Fallow's refactoring candidates. */
  targets: { path: string; recommendation: string; effort: string; confidence: string; priority: number }[]
  /** Files that change together with no import between them. */
  coupling: { a: string; b: string; degree: number; shared: number; strong: boolean }[]
  /** Least maintainable files first. */
  files: { path: string; maintainability: number; cyclomatic: number; lines: number; fanIn: number; fanOut: number }[]
  /** What Fallow measured, and the limits it measured against. */
  scope: string
  frameworks: string[]
}

/** A security candidate from `fallow security`: unverified, to check, never a confirmed flaw. */
export type SecurityCandidate = {
  id: string
  /** `ssrf`, `dangerous-html`, `code-injection`, `path-traversal`… */
  category: string
  cwe: number | null
  severity: string
  path: string
  line: number | null
  /** Fallow's own words on what it saw and what to check. */
  evidence: string
  /** Source to sink, when Fallow traced one. */
  trace: Location[]
  reachableFromUntrusted: boolean
}

export type Security = {
  candidates: SecurityCandidate[]
  /** Call sites Fallow could not resolve: places its taint tracking cannot see into. */
  blindSpots: { unresolvedImports: number; unresolvedCallees: number }
}

export type Analysis = {
  /** Workspace folder the run was for. */
  path: string | null
  /** Fallow's version, from its JSON. */
  version: string | null
  ranAt: number | null
  elapsedMs: number | null
  health: Health | null
  findings: Finding[]
  /** From a second `fallow security` run; null when it did not run or failed. */
  security: Security | null
  /** Why there is nothing to show: no workspace, no package.json, Fallow failed. */
  error?: string
}

declare module 'orca' {
  interface PluginRequests {
    /** The last run for the focused workspace, without running Fallow again. */
    'fallow.last': { output: Analysis }
    /** Runs `fallow` in the focused workspace and answers the result. */
    'fallow.run': { output: Analysis }
    /** Opens a finding's file at its line in an editor tab. */
    'fallow.open': { input: { path: string; line: number | null }; output: { opened: boolean } }
    /** `fallow fix --dry-run`, for the whole project or one file: what it would change. */
    'fallow.planFix': { input: { file?: string }; output: FixPlan }
    /** `fallow fix --yes` for the same scope, then a fresh analysis. */
    'fallow.applyFix': { input: { file?: string }; output: { plan: FixPlan; analysis: Analysis } }
    /** Deletes an unused file Git tracks unchanged, so `git restore` brings it back. */
    'fallow.deleteFile': { input: { path: string }; output: { analysis: Analysis } }
    /** Writes Fallow's suggested ignore comment above the finding, then a fresh analysis. */
    'fallow.suppress': { input: Suppression; output: { analysis: Analysis } }
    /** Starts an agent in the focused workspace with the finding and Fallow's advice as its prompt. */
    'fallow.askAgent': { input: { prompt: string }; output: { started: boolean; focused: boolean; sent: boolean } }
    /** Writes the work list for a whole category, starts an agent on it, and types the prompt. */
    /** Starts one agent on a whole list: it runs the Fallow command for it and works through the output. */
    'fallow.askAgentBatch': { input: { kind: BatchKind; count: number }; output: { started: boolean; focused: boolean; sent: boolean } }
  }
  interface PluginPanelEvents {
    /** A run finished, from the panel's Run or the status bar item. */
    'fallow.updated': Analysis
  }
}
