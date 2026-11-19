import { execFile } from 'node:child_process'
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { BATCH_COMMAND, batchPrompt, parse, parseFix, PROMPT_MAX } from './parse'
import type { Analysis, FixPlan, Suppression } from './protocol'

// The version this plugin's parser was written against; npx fetches it once and caches it.
export const FALLOW = 'fallow@3.44.0'
const TIMEOUT_MS = 5 * 60_000
// Fallow's JSON is ~400 KB on a 25k-line project; leave room for large monorepos.
const MAX_BUFFER = 256 * 1024 * 1024

export type Runner = (cmd: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>

const nodeRunner: Runner = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: { ...process.env, FALLOW_QUIET: '1' } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: err && !stderr ? String(err.message) : String(stderr) })
    })
  })

const ANALYZE = ['--score', '--format', 'json', '--quiet']

/** The project's own fallow when it has one (its pinned version, its config); else npx. */
export async function command(dir: string, args: string[] = ANALYZE): Promise<[string, string[]]> {
  const local = join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'fallow.cmd' : 'fallow')
  try {
    await access(local)
    return [local, args]
  } catch {
    return [process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', FALLOW, ...args]]
  }
}

/** Fallow prints its JSON on stdout after any progress lines: read from the first brace. */
function jsonOf(stdout: string): unknown | null {
  const start = stdout.indexOf('{')
  if (start === -1) return null
  try {
    return JSON.parse(stdout.slice(start))
  } catch {
    return null
  }
}

const lastLines = (stderr: string) => stderr.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' ')

// Never creates a .fallowrc.json behind the person's back; the panel never asks Fallow for one.
const fixArgs = (file: string | undefined, dryRun: boolean) => ['fix', ...(file ? [file] : []), dryRun ? '--dry-run' : '--yes', '--no-create-config', '--format', 'json', '--quiet']

/** `fallow fix`, previewed or applied, for the project or one workspace-relative file. */
export async function fix(dir: string, file: string | undefined, dryRun: boolean, run: Runner = nodeRunner): Promise<FixPlan> {
  if (file && (file.startsWith('/') || file.split('/').includes('..'))) return { fixes: [], skipped: 0, error: `Not a file of this workspace: ${file}` }
  const [cmd, args] = await command(dir, fixArgs(file, dryRun))
  const { code, stdout, stderr } = await run(cmd, args, dir)
  const json = jsonOf(stdout)
  // Exit 2 means some files were skipped as unsafe; the JSON still lists what was done.
  if (!json) return { fixes: [], skipped: 0, error: `Fallow fix did not run (exit ${code})${stderr ? `: ${lastLines(stderr)}` : ''}` }
  return parseFix(json as Record<string, unknown>)
}

/**
 * The files among `paths` with changes Git has not committed. Fallow's own advice is to commit
 * before `fallow fix`, so the panel refuses to edit them and Git can always undo what it wrote.
 * Null when the folder is not a Git repository: the panel then warns instead.
 */
export async function uncommitted(dir: string, paths: string[], run: Runner = nodeRunner): Promise<string[] | null> {
  if (!paths.length) return []
  const { code, stdout } = await run('git', ['status', '--porcelain', '--', ...paths], dir)
  if (code !== 0) return null
  return stdout.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ''))
}

/** Runs Fallow in `dir`. Exit 1 only means "found error-level issues": the JSON is still the answer. */
export async function analyze(dir: string, run: Runner = nodeRunner, now = Date.now): Promise<Analysis> {
  const empty = (error: string): Analysis => ({ path: dir, version: null, ranAt: now(), elapsedMs: null, health: null, findings: [], error })
  try {
    JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  } catch {
    return empty('No package.json in this workspace: Fallow analyses JavaScript and TypeScript projects.')
  }
  const [cmd, args] = await command(dir)
  const { code, stdout, stderr } = await run(cmd, args, dir)
  const json = jsonOf(stdout)
  if (!json) {
    const why = lastLines(stderr)
    return empty(stdout.includes('{') ? "Fallow's output could not be read." : `Fallow did not run (exit ${code})${why ? `: ${why}` : ''}`)
  }
  return parse(json as Record<string, unknown>, dir, now())
}

const statusOf = (a: Analysis) => {
  if (a.error) return { text: 'Fallow', tone: 'neutral' as const, tooltip: a.error }
  const errors = a.findings.filter((f) => f.severity === 'error').length
  const warnings = a.findings.filter((f) => f.severity === 'warning').length
  const grade = a.health ? `${a.health.grade} ${Math.round(a.health.score)}` : null
  return {
    text: [grade, `${a.findings.length} issues`].filter(Boolean).join(' · '),
    tone: errors ? ('danger' as const) : warnings ? ('warning' as const) : ('success' as const),
    tooltip: `Fallow: ${errors} errors, ${warnings} warnings, ${a.findings.length - errors - warnings} hints${
      a.health ? `. Health ${a.health.score.toFixed(1)} (${a.health.grade}), ${a.health.duplication.toFixed(1)}% duplicated` : ''
    }. Press to run again; the Fallow panel lists them.`
  }
}

const inside = (file: string) => !!file && !file.startsWith('/') && !file.split(/[\\/]/).includes('..')

/** Refuses to touch a file Git cannot restore: untracked, or with uncommitted edits. */
async function guard(dir: string, file: string, run: Runner): Promise<void> {
  if (!inside(file)) throw Object.assign(new Error(`Not a file of this workspace: ${file}`), { code: 'invalid' })
  const tracked = await run('git', ['ls-files', '--error-unmatch', '--', file], dir)
  if (tracked.code !== 0) throw Object.assign(new Error(`${file} is not committed to Git, so this could not be undone. Commit it first, or change it by hand.`), { code: 'conflict' })
  const dirty = await uncommitted(dir, [file], run)
  if (dirty?.length) throw Object.assign(new Error(`Commit or stash your changes to ${file} first.`), { code: 'conflict' })
}

/** Deletes an unused file. Fallow itself never does: the panel asks first, and Git can restore it. */
export async function deleteFile(dir: string, file: string, run: Runner = nodeRunner): Promise<void> {
  await guard(dir, file, run)
  await rm(join(dir, file))
}

/**
 * Inserts Fallow's ignore comment above `line` (or at the top of the file), matching the
 * indentation of the line it silences and the file's line endings.
 */
export function insertComment(text: string, s: Pick<Suppression, 'comment' | 'line'>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  if (s.line === null) {
    // After a shebang, which must stay first.
    const at = lines[0]?.startsWith('#!') ? 1 : 0
    lines.splice(at, 0, s.comment)
  } else {
    const i = Math.min(Math.max(s.line - 1, 0), lines.length)
    const indent = /^[ \t]*/.exec(lines[i] ?? '')?.[0] ?? ''
    lines.splice(i, 0, indent + s.comment)
  }
  return lines.join(eol)
}

export async function suppress(dir: string, s: Suppression, run: Runner = nodeRunner): Promise<void> {
  if (!/fallow-ignore-(next-line|file)\b/.test(s.comment)) throw Object.assign(new Error('Only Fallow ignore comments can be written.'), { code: 'invalid' })
  await guard(dir, s.path, run)
  const file = join(dir, s.path)
  await writeFile(file, insertComment(await readFile(file, 'utf8'), s))
}

/**
 * Whether an agent's TUI is waiting for input. Each draws a prompt glyph at the start of its input
 * box (`❯` Claude Code, `›` Codex, `>` others) once it has loaded; a trust or login screen does not.
 */
export function agentReady(lines: string[]): boolean {
  const text = lines.join('\n')
  if (/trust (this|the) (folder|files)|do you trust|log ?in to|sign in to|select (a )?login/i.test(text)) return false
  return lines.some((l) => /^\s*[│|]?\s*[❯›>](\s|$)/.test(l))
}

type Wait = (ms: number) => Promise<void>
const pause: Wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Orca's agent.launch drops the prompt when the agent has not registered in time
 * (`agent_launch_terminal_not_running_agent`), so the worker types it once the TUI is ready.
 * Answers whether it was sent; on a timeout the agent is left open and the panel says so.
 */
export async function deliverPrompt(
  read: () => Promise<string[]>,
  send: (text: string) => Promise<boolean>,
  prompt: string,
  { timeoutMs = 60_000, everyMs = 500, wait = pause }: { timeoutMs?: number; everyMs?: number; wait?: Wait } = {}
): Promise<boolean> {
  for (let waited = 0; waited <= timeoutMs; waited += everyMs) {
    const lines = await read().catch(() => [] as string[])
    if (agentReady(lines)) return send(prompt)
    await wait(everyMs)
  }
  return false
}

export default function activate(orca: OrcaWorkerApi): void {
  // The last run per workspace folder, in storage so it outlives the worker's idle restarts.
  const key = (path: string) => `last:${path}`
  const remembered = async (path: string) => (await orca.storage.get(key(path))) as Analysis | null
  let running: Promise<Analysis> | null = null

  async function focused(): Promise<{ id: string; path: string } | null> {
    const ctx = await orca.host.call('workspace.readContext')
    if (!ctx?.workspaceId) return null
    const { workspaces } = await orca.host.call('workspace.list')
    const ws = workspaces.find((w) => w.id === ctx.workspaceId)
    // shortcut: runs Fallow on the Orca host, so SSH workspaces are not analysed; run it over terminal.create for remote hosts.
    return ws ? { id: ws.id, path: ws.path } : null
  }

  const none = (error: string): Analysis => ({ path: null, version: null, ranAt: null, elapsedMs: null, health: null, findings: [], error })

  async function run(): Promise<Analysis> {
    const ws = await focused()
    if (!ws) return none('No workspace is focused.')
    // One run at a time: a second press while Fallow works waits for the same answer.
    running ??= analyze(ws.path).finally(() => (running = null))
    const a = await running
    await orca.storage.set(key(ws.path), a)
    orca.panels.post('fallow.updated', a)
    await orca.host.call('statusBar.update', { id: 'fallow', visible: true, ...statusOf(a) }).catch(() => {})
    return a
  }

  orca.panels.handle('fallow.last', async () => {
    const ws = await focused()
    if (!ws) return none('No workspace is focused.')
    return (await remembered(ws.path)) ?? { path: ws.path, version: null, ranAt: null, elapsedMs: null, health: null, findings: [] }
  })
  orca.panels.handle('fallow.run', () => run())
  orca.panels.handle('fallow.open', async ({ path }) => {
    const ws = await focused()
    if (!ws) return { opened: false }
    await orca.host.call('editor.open', { workspaceId: ws.id, path })
    return { opened: true }
  })
  orca.panels.handle('fallow.planFix', async ({ file }) => {
    const ws = await focused()
    if (!ws) return { fixes: [], skipped: 0, error: 'No workspace is focused.' }
    const plan = await fix(ws.path, file, true)
    if (plan.error || !plan.fixes.length) return plan
    const dirty = await uncommitted(ws.path, [...new Set(plan.fixes.map((f) => f.file))])
    if (dirty === null) return { ...plan, error: 'This folder is not a Git repository, so these edits could not be undone. Fix them by hand, or put the folder under Git first.' }
    if (dirty.length) return { ...plan, error: `Commit or stash your changes first: ${dirty.join(', ')} ${dirty.length === 1 ? 'has' : 'have'} uncommitted edits, and Fallow would write into ${dirty.length === 1 ? 'it' : 'them'}.` }
    return plan
  })
  orca.panels.handle('fallow.applyFix', async ({ file }) => {
    const ws = await focused()
    if (!ws) throw Object.assign(new Error('No workspace is focused.'), { code: 'unavailable' })
    // Checked again here: the files may have changed since the preview.
    const preview = await fix(ws.path, file, true)
    const dirty = await uncommitted(ws.path, [...new Set(preview.fixes.map((f) => f.file))])
    if (dirty === null || dirty.length) throw Object.assign(new Error('Files changed since the preview; open it again.'), { code: 'conflict' })
    const plan = await fix(ws.path, file, false)
    return { plan, analysis: await run() }
  })
  orca.panels.handle('fallow.deleteFile', async ({ path }) => {
    const ws = await focused()
    if (!ws) throw Object.assign(new Error('No workspace is focused.'), { code: 'unavailable' })
    await deleteFile(ws.path, path)
    return { analysis: await run() }
  })
  orca.panels.handle('fallow.suppress', async (input) => {
    const ws = await focused()
    if (!ws) throw Object.assign(new Error('No workspace is focused.'), { code: 'unavailable' })
    await suppress(ws.path, input)
    return { analysis: await run() }
  })
  /** Starts an agent in `workspaceId`, brings its tab forward and types `prompt` once it is ready. */
  async function startAgent(workspaceId: string, prompt: string) {
    const agent = String((await orca.settings.get('agent')) ?? 'claude')
    // No prompt here: Orca's own delivery can silently drop it (see deliverPrompt).
    const { terminalId } = await orca.host.call('agent.launch', { workspaceId, agent })
    // agent.launch opens its tab in the background; bring it to the front, as a press on the tab would.
    const { focused: shown } = await orca.host.call('terminal.focus', { terminalId }).catch(() => ({ focused: false }))
    const sent = await deliverPrompt(
      async () => (await orca.host.call('terminal.read', { terminalId, maxLines: 60 })).lines,
      async (text) => (await orca.host.call('terminal.sendText', { terminalId, text, enter: true })).accepted,
      prompt.slice(0, PROMPT_MAX)
    )
    return { started: true, focused: shown, sent }
  }

  orca.panels.handle('fallow.askAgent', async ({ prompt }) => {
    const ws = await focused()
    if (!ws) throw Object.assign(new Error('No workspace is focused.'), { code: 'unavailable' })
    return startAgent(ws.id, prompt)
  })
  orca.panels.handle('fallow.askAgentBatch', async ({ kind, count }) => {
    const ws = await focused()
    if (!ws) throw Object.assign(new Error('No workspace is focused.'), { code: 'unavailable' })
    if (!(kind in BATCH_COMMAND)) throw Object.assign(new Error('Unknown list.'), { code: 'invalid' })
    // One agent, one short prompt: it runs the Fallow command itself and works through what it prints.
    return startAgent(ws.id, batchPrompt(kind, count))
  })
  orca.commands.register('fallow.run', async () => {
    const a = await run()
    return a.error ?? statusOf(a).tooltip
  })
}
