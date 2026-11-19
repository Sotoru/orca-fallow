// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  EmptyState,
  Heading,
  IconButton,
  Grid,
  Input,
  KeyValue,
  on,
  plugin,
  read,
  Row,
  Progress,
  Separator,
  set,
  Skeleton,
  Stack,
  Tab,
  Tabs,
  Text,
  shell,
  update,
  type IconName,
  type OrcaNode,
  type PanelContext
} from 'orca'
import { agentPrompt, BATCH_COMMAND, describeFix, healthItems } from './parse'
import type { AgentItem, Analysis, BatchKind, CategoryId, Finding, FixPlan, Location } from './protocol'

type Filter = 'all' | 'error' | 'warning' | 'info'
type View = 'findings' | 'health' | 'agent'

const analysis = atom<Analysis | null>(null)
const busy = atom(false)
const query = atom('')
const filter = atom<Filter>('filter', 'all', { persist: 'plugin' })
const view = atom<View>('view', 'findings', { persist: 'plugin' })
/** Categories the person closed; all start open. */
const closed = atom<Record<string, boolean>>('closed', {}, { persist: 'plugin' })
const failure = atom<string | null>(null)
/** The dry run on screen: for the whole project (`file` unset) or one file. */
const preview = atom<{ file?: string; plan: FixPlan } | null>(null)
const fixing = atom(false)
const done = atom<string | null>(null)
/** The finding whose actions are open under its row. */
const selected = atom<string | null>(null)
/** Clone families opened to show their copies, as the VS Code Duplicates tree does. */
const expandedClones = atom<Record<string, boolean>>({})
/** A destructive action waiting for its second press: `delete:<path>` or `suppress:<id>`. */
const confirming = atom<string | null>(null)

const FILTERS: Filter[] = ['all', 'error', 'warning', 'info']
const FILTER_LABEL: Record<Filter, string> = { all: 'All', error: 'Errors', warning: 'Warnings', info: 'Hints' }

// The order and icons follow the Fallow sidebar in VS Code: what breaks first, then what to delete.
const CATEGORIES: { id: CategoryId; label: string; icon: IconName }[] = [
  { id: 'unresolved-imports', label: 'Unresolved imports', icon: 'error' },
  { id: 'unlisted-dependencies', label: 'Unlisted dependencies', icon: 'package' },
  { id: 'circular-dependencies', label: 'Circular dependencies', icon: 'refresh' },
  { id: 'unused-files', label: 'Unused files', icon: 'file' },
  { id: 'unused-exports', label: 'Unused exports', icon: 'code' },
  { id: 'unused-types', label: 'Unused types', icon: 'blocks' },
  { id: 'unused-dependencies', label: 'Unused dependencies', icon: 'package' },
  { id: 'unused-members', label: 'Unused members', icon: 'layers' },
  { id: 'duplicate-exports', label: 'Duplicate exports', icon: 'copy' },
  { id: 'boundaries', label: 'Boundary violations', icon: 'flag' },
  { id: 'duplication', label: 'Duplication', icon: 'copy' },
  { id: 'complexity', label: 'Complexity', icon: 'gauge' },
  { id: 'other', label: 'Other', icon: 'info' }
]

const SEVERITY_ICON: Record<Finding['severity'], IconName> = { error: 'error', warning: 'warning', info: 'info' }
const SEVERITY_LABEL: Record<Finding['severity'], string> = { error: 'Error', warning: 'Warning', info: 'Hint' }
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

async function request(work: () => Promise<Analysis>): Promise<void> {
  set(failure, null)
  try {
    set(analysis, await work())
  } catch (e) {
    set(failure, (e as Error).message)
  }
}

async function run(): Promise<void> {
  set(busy, true)
  // Fallow on a large monorepo can take minutes; past the 120 s ceiling the worker still posts the result.
  await request(() => plugin.request('fallow.run', undefined, { timeoutMs: 120000 }))
  set(busy, false)
}

async function open(l: Pick<Location, 'path' | 'line'>): Promise<void> {
  try {
    await plugin.request('fallow.open', { path: l.path, line: l.line })
  } catch (e) {
    set(failure, `Could not open ${l.path}: ${(e as Error).message}`)
  }
}

/** An action that edits files, then shows the fresh analysis and what it did. */
async function act(work: () => Promise<{ analysis: Analysis }>, message: string): Promise<void> {
  set(fixing, true)
  set(failure, null)
  set(done, null)
  try {
    set(analysis, (await work()).analysis)
    set(selected, null)
    set(done, message)
  } catch (e) {
    set(failure, (e as Error).message)
  } finally {
    set(fixing, false)
    set(confirming, null)
  }
}

/** Every list one agent can work through, with how the panel names it. */
const BATCH: Record<BatchKind, { label: string; verb: string; one: string; many: string; icon: IconName }> = {
  'unresolved-imports': { label: 'Unresolved imports', verb: 'Fix all', one: 'unresolved import', many: 'unresolved imports', icon: 'error' },
  'circular-dependencies': { label: 'Circular dependencies', verb: 'Break all', one: 'cycle', many: 'cycles', icon: 'refresh' },
  'unused-files': { label: 'Unused files', verb: 'Clean up all', one: 'unused file', many: 'unused files', icon: 'file' },
  'unused-exports': { label: 'Unused exports', verb: 'Clean up all', one: 'unused export', many: 'unused exports', icon: 'code' },
  'unused-dependencies': { label: 'Unused dependencies', verb: 'Clean up all', one: 'unused dependency', many: 'unused dependencies', icon: 'package' },
  duplication: { label: 'Duplication', verb: 'Extract all', one: 'duplicated block', many: 'duplicated blocks', icon: 'copy' },
  complexity: { label: 'Complexity', verb: 'Refactor all', one: 'complex function', many: 'complex functions', icon: 'gauge' },
  targets: { label: 'Refactoring candidates', verb: 'Refactor all', one: 'refactoring candidate', many: 'refactoring candidates', icon: 'wrench' },
  hotspots: { label: 'Hotspot candidates', verb: 'Simplify all', one: 'hotspot', many: 'hotspots', icon: 'zap' },
  files: { label: 'Least maintainable files', verb: 'Improve all', one: 'file', many: 'files', icon: 'gauge' }
}

/** One agent for a whole list: it runs the Fallow command for the list and works through it. */
async function askAgentBatch(kind: BatchKind, count: number): Promise<void> {
  const b = BATCH[kind]
  const what = plural(count, b.one, b.many)
  set(confirming, null)
  set(failure, null)
  set(done, `Starting an agent for ${what}…`)
  try {
    const r = await plugin.request('fallow.askAgentBatch', { kind, count }, { timeoutMs: 90000 })
    const where = r.focused ? 'in the terminal tab Orca just opened' : 'in a new terminal tab of this workspace'
    if (r.sent) set(done, `One agent is working through ${what} ${where}, starting from \`${BATCH_COMMAND[kind].command}\`. Review its changes before you commit them.`)
    else {
      set(done, null)
      set(failure, `The agent opened ${where}, but it did not get ready for the prompt within a minute. Answer it, then press the button again.`)
    }
  } catch (e) {
    set(done, null)
    set(failure, `Could not start an agent: ${(e as Error).message}`)
  }
}

/** The Agent tab: one row per list, each handing the whole list to a single agent. */
function AgentView(a: Analysis) {
  const findings = a.findings
  const fromFindings = (c: CategoryId) => findings.filter((f) => f.category === c).length
  const h = a.health
  const counts: Record<BatchKind, number> = {
    'unresolved-imports': fromFindings('unresolved-imports'),
    'circular-dependencies': fromFindings('circular-dependencies'),
    'unused-files': fromFindings('unused-files'),
    'unused-exports': fromFindings('unused-exports'),
    'unused-dependencies': fromFindings('unused-dependencies'),
    duplication: fromFindings('duplication'),
    complexity: fromFindings('complexity'),
    targets: h?.targets.length ?? 0,
    hotspots: h?.hotspots.length ?? 0,
    files: h?.files.length ?? 0
  }
  const kinds = (Object.keys(BATCH) as BatchKind[]).filter((k) => counts[k] > 0)
  const waiting = read(confirming)
  return (
    <Stack gap="md">
      <Text size="xs" muted>
        Each button starts one agent in this workspace. It runs the Fallow command shown, works through every item it lists, runs your type check and tests, and does not commit.
      </Text>
      {kinds.length === 0 ? (
        <EmptyState icon="check" title="Nothing to hand to an agent" />
      ) : (
        <Box border radius="md" direction="column">
          {kinds.flatMap((k, n) => {
            const b = BATCH[k]
            const asking = waiting === `batch:${k}`
            return [
              n > 0 ? <Separator /> : null,
              <Box direction="column" gap="sm" paddingX="sm" paddingY="sm">
                <Box direction="row" gap="xs" align="center">
                  <IconButton icon={b.icon} label={b.label} variant="ghost" size="xs" />
                  <Box grow minWidth={0} gap="none">
                    <Row gap="xs">
                      <Text weight="medium" truncate>
                        {b.label}
                      </Text>
                      <Badge>{String(counts[k])}</Badge>
                    </Row>
                    <Text size="xs" muted truncate>
                      {BATCH_COMMAND[k].command}
                    </Text>
                  </Box>
                  <Button icon="agent" size="sm" variant={asking ? 'solid' : 'outline'} disabled={read(fixing)} onPress={() => set(confirming, asking ? null : `batch:${k}`)}>
                    {b.verb}
                  </Button>
                </Box>
                {asking ? BatchConfirm(k, counts[k]) : null}
              </Box>
            ]
          })}
        </Box>
      )}
    </Stack>
  )
}

async function askAgent(f: Finding | AgentItem): Promise<void> {
  set(failure, null)
  try {
    set(done, `Starting an agent for "${f.title}"…`)
    // The worker waits for the agent to be ready before it types the prompt: allow it a minute.
    const { focused, sent } = await plugin.request('fallow.askAgent', { prompt: agentPrompt(f) }, { timeoutMs: 90000 })
    const where = focused ? 'in the terminal tab Orca just opened' : 'in a new terminal tab of this workspace'
    if (sent) set(done, `An agent is working on "${f.title}" ${where}. Review its changes before you commit them.`)
    else {
      set(done, null)
      set(failure, `The agent opened ${where}, but it did not get ready for the prompt within a minute (a login or trust screen?). Answer it, then press the button again.`)
    }
  } catch (e) {
    set(failure, `Could not start an agent: ${(e as Error).message}`)
  }
}

/** Step 1 of a fix: ask Fallow what it would change. Nothing is written yet. */
async function planFix(file?: string): Promise<void> {
  set(fixing, true)
  set(done, null)
  set(failure, null)
  try {
    // JSON has no undefined: an unset file must be left out, not sent as a missing value.
    set(preview, { file, plan: await plugin.request('fallow.planFix', file ? { file } : {}, { timeoutMs: 120000 }) })
  } catch (e) {
    set(failure, (e as Error).message)
  } finally {
    set(fixing, false)
  }
}

/** Step 2: the person saw the list and pressed Apply. */
async function applyFix(): Promise<void> {
  const p = read(preview)
  if (!p) return
  set(fixing, true)
  try {
    const { plan, analysis: a } = await plugin.request('fallow.applyFix', p.file ? { file: p.file } : {}, { timeoutMs: 120000 })
    const applied = plan.fixes.filter((f) => f.applied !== false).length
    const held = plan.fixes.length - applied + plan.skipped
    set(analysis, a)
    set(preview, null)
    set(done, `Fallow applied ${plural(applied, 'fix', 'fixes')}${held ? `, held back ${held} as unsafe` : ''}. Run your type check and tests; git restore undoes it.`)
  } catch (e) {
    set(failure, (e as Error).message)
  } finally {
    set(fixing, false)
  }
}

function PreviewCard(p: { file?: string; plan: FixPlan }) {
  const { fixes, skipped, error } = p.plan
  const blocked = !!error
  return (
    <Callout tone={blocked ? 'warning' : 'accent'} icon={blocked ? 'warning' : 'wrench'} title={fixes.length ? `${plural(fixes.length, 'change', 'changes')} ${p.file ? `in ${p.file}` : 'across the project'}` : 'Nothing Fallow can fix safely'}>
      <Stack gap="sm">
        {fixes.length ? (
          <Box border radius="md" direction="column" maxHeight={240} scroll="y">
            {fixes.flatMap((f, n) => [
              n > 0 ? <Separator /> : null,
              <Box paddingX="sm" paddingY="xs">
                <Text size="xs" truncate>
                  {describeFix(f)}
                </Text>
              </Box>
            ])}
          </Box>
        ) : null}
        {error ? <Text size="sm">{error}</Text> : null}
        {skipped ? (
          <Text size="xs" muted>
            {`Fallow holds back ${plural(skipped, 'edit', 'edits')} it cannot make safely; fix ${skipped === 1 ? 'it' : 'them'} by hand.`}
          </Text>
        ) : null}
        {!blocked && fixes.length ? (
          <Text size="xs" muted>
            Fallow removes the export keyword and keeps the code; unused files are never deleted. Your changes stay undoable with git restore.
          </Text>
        ) : null}
        <Row gap="xs">
          {!blocked && fixes.length ? (
            <Button icon="check" tone="accent" variant="solid" size="sm" disabled={read(fixing)} onPress={applyFix}>
              {`Apply ${plural(fixes.length, 'change', 'changes')}`}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onPress={() => set(preview, null)}>
            {blocked || !fixes.length ? 'Close' : 'Cancel'}
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

export function setup(ctx: PanelContext): void {
  void request(() => plugin.request('fallow.last'))
  ctx.subscriptions.push(
    plugin.on('fallow.updated', (a) => {
      set(analysis, a)
      set(busy, false)
    })
  )
  // The first event replays the current workspace; show the new one's last run when focus moves.
  let last: string | undefined | null = null
  ctx.subscriptions.push(
    on('workspace.changed', ({ context }) => {
      const id = context?.workspaceId
      if (last !== null && id !== last) void request(() => plugin.request('fallow.last'))
      last = id
    })
  )
}

const where = (l: Location) => `${l.path}${l.line ? `:${l.line}${l.endLine && l.endLine !== l.line ? `-${l.endLine}` : ''}` : ''}`
const lines = (l: Location) => (l.line ? `${l.line}${l.endLine && l.endLine !== l.line ? `-${l.endLine}` : ''}` : '')

/**
 * The copies of a clone, one row each: `card.svelte:53-63` with its folder underneath, as the
 * VS Code Duplicates tree shows them. A press opens that copy.
 */
function CloneCopies(f: Finding) {
  return (
    <Box direction="column" background="muted">
      {f.locations.flatMap((l, n) => {
        const parts = l.path.split('/')
        const file = parts.pop()!
        const span = lines(l)
        return [
          <Separator />,
          <Box direction="row" gap="xs" align="center" paddingY="xs" paddingX="sm">
            <Box width={28} shrink={false} />
            <IconButton icon="copy" label={`Copy ${n + 1} of ${f.locations.length}`} variant="ghost" size="xs" />
            <Box grow minWidth={0} gap="none">
              <Text size="sm" truncate>
                {span ? `${file}:${span}` : file}
              </Text>
              <Text size="xs" muted truncate>
                {parts.join('/') || '.'}
              </Text>
            </Box>
            <IconButton icon="open-external" label={`Open ${where(l)}`} variant="ghost" size="sm" onPress={() => open(l)} />
          </Box>
        ]
      })}
    </Box>
  )
}

/** One finding: same shape as a Version Lens row, so the two panels read alike. */
function FindingRow(f: Finding) {
  const isOpen = read(selected) === f.id
  const isClone = f.category === 'duplication' && f.locations.length > 0
  const showCopies = isClone && !!read(expandedClones)[f.id]
  return (
    <Box direction="column">
      <Box direction="row" gap="xs" align="center" paddingX="sm" paddingY="sm">
        {isClone ? (
          <IconButton
            icon={showCopies ? 'collapse' : 'next'}
            label={`${showCopies ? 'Hide' : 'Show'} the ${f.locations.length} copies of ${f.title}`}
            variant="ghost"
            size="xs"
            onPress={() => update(expandedClones, (e) => ({ ...e, [f.id]: !showCopies }))}
          />
        ) : null}
        <IconButton icon={SEVERITY_ICON[f.severity]} label={`${SEVERITY_LABEL[f.severity]}: ${f.title}`} variant="ghost" size="xs" />
        <Box grow minWidth={0} gap="xs">
          <Text weight="medium" truncate>
            {f.title}
          </Text>
          <Text size="xs" muted truncate>
            {f.detail}
          </Text>
        </Box>
        {f.fix && f.path ? (
          <IconButton
            icon="wrench"
            label={`Preview fix: ${f.fix} (${f.path})`}
            variant="ghost"
            size="sm"
            disabled={read(fixing)}
            onPress={() => planFix(f.path!)}
          />
        ) : null}
        <IconButton
          icon={isOpen ? 'collapse' : 'more'}
          label={`${isOpen ? 'Hide' : 'Show'} actions for ${f.title}`}
          variant={isOpen ? 'solid' : 'ghost'}
          size="sm"
          onPress={() => {
            set(selected, isOpen ? null : f.id)
            set(confirming, null)
          }}
        />
      </Box>
      {showCopies ? CloneCopies(f) : null}
      {isOpen ? FindingActions(f) : null}
    </Box>
  )
}

/** Everything the VS Code quick fixes and tree offer for this finding, under its row. */
function FindingActions(f: Finding) {
  const busyNow = read(fixing)
  const waiting = read(confirming)
  const deleting = f.deletable && waiting === `delete:${f.path}`
  const silencing = !!f.suppress && waiting === `suppress:${f.id}`
  return (
    <Box background="muted" direction="column" gap="sm" paddingX="sm" paddingY="sm">
      {f.locations.length && f.category !== 'duplication' ? (
        <Stack gap="none">
          {f.locations.length > 1 ? (
            <Text size="xs" muted weight="medium">
              {`${f.locations.length} files`}
            </Text>
          ) : null}
          {f.locations.map((l) => (
            <Box direction="row" gap="xs" align="center">
              <Box grow minWidth={0}>
                <Text size="xs" truncate>
                  {where(l)}
                </Text>
              </Box>
              <IconButton icon="open-external" label={`Open ${where(l)}`} variant="ghost" size="xs" onPress={() => open(l)} />
            </Box>
          ))}
        </Stack>
      ) : null}
      {f.advice ? (
        <Text size="xs" muted>
          {f.advice}
        </Text>
      ) : null}
      {deleting ? (
        <Callout tone="danger" icon="delete" title={`Delete ${f.path}?`}>
          <Stack gap="sm">
            <Text size="xs">Fallow never deletes files itself: a file can be loaded in ways static analysis cannot see. git restore brings it back.</Text>
            <Row gap="xs">
              <Button tone="danger" variant="solid" size="sm" disabled={busyNow} onPress={() => act(() => plugin.request('fallow.deleteFile', { path: f.path! }, { timeoutMs: 120000 }), `Deleted ${f.path}. Run your build and tests; git restore ${f.path} brings it back.`)}>
                Delete file
              </Button>
              <Button variant="ghost" size="sm" onPress={() => set(confirming, null)}>
                Cancel
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      {silencing ? (
        <Callout tone="warning" icon="info" title="Ignore this finding?">
          <Stack gap="sm">
            <Text size="xs">{`Adds \`${f.suppress!.comment}\` ${f.suppress!.line ? `above line ${f.suppress!.line}` : 'at the top'} of ${f.suppress!.path}. Fallow stops reporting it; the rule stays on everywhere else.`}</Text>
            <Row gap="xs">
              <Button variant="solid" size="sm" disabled={busyNow} onPress={() => act(() => plugin.request('fallow.suppress', f.suppress!, { timeoutMs: 120000 }), `Ignored "${f.title}" with a fallow-ignore comment in ${f.suppress!.path}.`)}>
                Add comment
              </Button>
              <Button variant="ghost" size="sm" onPress={() => set(confirming, null)}>
                Cancel
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      {deleting || silencing ? null : (
        <Row gap="xs" wrap>
          {f.fix && f.path ? (
            <Button icon="wrench" size="sm" variant="outline" disabled={busyNow} onPress={() => planFix(f.path!)}>
              Preview fix
            </Button>
          ) : null}
          {f.deletable ? (
            <Button icon="delete" size="sm" variant="outline" tone="danger" disabled={busyNow} onPress={() => set(confirming, `delete:${f.path}`)}>
              Delete file
            </Button>
          ) : null}
          {!f.fix && !f.deletable ? (
            <Button icon="agent" size="sm" variant="outline" disabled={busyNow} onPress={() => askAgent(f)}>
              {f.category === 'duplication' ? 'Extract with agent' : f.category === 'complexity' ? 'Refactor with agent' : 'Fix with agent'}
            </Button>
          ) : null}
          {f.suppress ? (
            <Button icon="close" size="sm" variant="ghost" disabled={busyNow} onPress={() => set(confirming, `suppress:${f.id}`)}>
              Ignore
            </Button>
          ) : null}
          {f.docs ? (
            <Button icon="book" size="sm" variant="ghost" onPress={() => shell.openExternal(f.docs!)}>
              Docs
            </Button>
          ) : null}
        </Row>
      )}
      {f.id.startsWith('dc1:') ? (
        // Plugins cannot write the clipboard: the id sits in a field to select and copy.
        <Input label="Finding id" value={f.id} onChange={() => {}} />
      ) : null}
    </Box>
  )
}

/** Findings categories that also have a one-agent list: the same button as in the Agent tab. */
const CATEGORY_BATCH: Partial<Record<CategoryId, BatchKind>> = {
  'unresolved-imports': 'unresolved-imports',
  'circular-dependencies': 'circular-dependencies',
  'unused-files': 'unused-files',
  'unused-exports': 'unused-exports',
  'unused-dependencies': 'unused-dependencies',
  duplication: 'duplication',
  complexity: 'complexity'
}

/** The confirmation before a whole list goes to one agent: shared by the Agent tab and the categories. */
function BatchConfirm(k: BatchKind, count: number) {
  const b = BATCH[k]
  return (
    <Callout tone="accent" icon="agent" title={`One agent for ${plural(count, b.one, b.many)}?`}>
      <Stack gap="sm">
        <Text size="xs">{`It runs \`${BATCH_COMMAND[k].command}\` and ${BATCH_COMMAND[k].task}. A long list can take a while and change many files; nothing is committed.`}</Text>
        <Row gap="xs">
          <Button icon="agent" tone="accent" variant="solid" size="sm" onPress={() => askAgentBatch(k, count)}>
            Start agent
          </Button>
          <Button variant="ghost" size="sm" onPress={() => set(confirming, null)}>
            Cancel
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

function CategoryBlock({ id, label, findings }: { id: CategoryId; label: string; findings: Finding[] }) {
  const isClosed = !!read(closed)[id]
  const batch = CATEGORY_BATCH[id]
  const asking = !!batch && read(confirming) === `batch:${batch}`
  return (
    <Stack gap="sm">
      <Row justify="between" gap="xs">
      <Row gap="xs">
          <IconButton
            icon={isClosed ? 'next' : 'collapse'}
            label={`${isClosed ? 'Show' : 'Hide'} ${label}`}
            variant="ghost"
            size="xs"
            onPress={() => update(closed, (c) => ({ ...c, [id]: !isClosed }))}
          />
          <Text size="xs" muted weight="medium">
            {label}
          </Text>
          <Badge>{String(findings.length)}</Badge>
      </Row>
        {batch ? (
          <Button icon="agent" size="xs" variant={asking ? 'solid' : 'ghost'} disabled={read(fixing)} onPress={() => set(confirming, asking ? null : `batch:${batch}`)}>
            {`${BATCH[batch].verb} with agent`}
          </Button>
        ) : null}
      </Row>
      {asking ? BatchConfirm(batch!, findings.length) : null}
      {isClosed ? null : (
        <Box border radius="md" direction="column">
          {findings.flatMap((f, n) => [n > 0 ? <Separator /> : null, FindingRow(f)])}
        </Box>
      )}
    </Stack>
  )
}

/**
 * The summary strip: each cell is as wide as its content, so it never stretches across a wide
 * panel or squeezes a grade into a narrow one. Pressing it opens the Health view.
 */
function HealthStrip(a: Analysis) {
  if (!a.health) return null
  const { score, grade, duplication } = a.health
  const cell = (label: string, value: string, big = false) => (
    <Box gap="none" shrink={false}>
      <Text size="xs" muted>
        {label}
      </Text>
      {big ? <Heading level={2}>{value}</Heading> : <Text weight="semibold">{value}</Text>}
    </Box>
  )
  return (
    <Row gap="sm" wrap>
      <Box border radius="md" paddingX="md" paddingY="sm" direction="row" gap="md" align="center" shrink={false}>
        {cell('Health', `${grade} · ${score.toFixed(1)}`, true)}
        <Separator orientation="vertical" />
        {cell('Duplicated', `${duplication.toFixed(1)}%`)}
        <Separator orientation="vertical" />
        {cell('Issues', String(a.findings.length))}
      </Box>
    </Row>
  )
}

const GRADE_TONE: Record<string, 'success' | 'warning' | 'danger'> = { A: 'success', B: 'success', C: 'warning', D: 'warning', E: 'danger', F: 'danger' }

/** Sections of the Health view, in the VS Code extension's order. */
function HealthView(a: Analysis) {
  const h = a.health!
  const groups = [...new Set(h.vitals.map((v) => v.group))]
  const opener = (path: string, label = `Open ${path}`) => <IconButton icon="open-external" label={label} variant="ghost" size="xs" onPress={() => open({ path, line: null })} />
  const work = healthItems(h)
  const agentButton = (item: AgentItem) => <IconButton icon="agent" label={`Fix with agent: ${item.title}`} variant="ghost" size="xs" onPress={() => askAgent(item)} />
  const fileRow = (path: string, detail: string, item: AgentItem) => (
    <Box direction="row" gap="xs" align="center" paddingX="sm" paddingY="xs">
      <Box grow minWidth={0} gap="none">
        <Text size="sm" truncate>
          {path}
        </Text>
        <Text size="xs" muted truncate>
          {detail}
        </Text>
      </Box>
      {agentButton(item)}
      {opener(path)}
    </Box>
  )
  const section = (id: string, title: string, count: number | null, body: OrcaNode) => {
    const isClosed = !!read(closed)[`health:${id}`]
    return (
      <Stack gap="sm">
        <Row gap="xs">
          <IconButton icon={isClosed ? 'next' : 'collapse'} label={`${isClosed ? 'Show' : 'Hide'} ${title}`} variant="ghost" size="xs" onPress={() => update(closed, (c) => ({ ...c, [`health:${id}`]: !isClosed }))} />
          <Text size="xs" muted weight="medium">
            {title}
          </Text>
          {count !== null ? <Badge>{String(count)}</Badge> : null}
        </Row>
        {isClosed ? null : body}
      </Stack>
    )
  }
  const list = (rows: OrcaNode[]) => (
    <Box border radius="md" direction="column">
      {rows.flatMap((r, n) => [n > 0 ? <Separator /> : null, r])}
    </Box>
  )
  return (
    <Stack gap="md">
      {section(
        'score',
        'Score',
        null,
        <Box border radius="md" padding="sm" gap="sm">
          <Row gap="sm" align="center">
            <Badge tone={GRADE_TONE[h.grade] ?? 'neutral'}>{`Grade ${h.grade}`}</Badge>
            <Text weight="semibold">{`${h.score.toFixed(1)} / 100`}</Text>
          </Row>
          <Progress label="Health score" labelHidden value={h.score} />
          {h.penalties.length ? (
            <KeyValue label="Points taken off" items={h.penalties.map((p) => ({ label: p.key, value: `−${p.points.toFixed(1)}`, tone: p.points >= 5 ? ('warning' as const) : undefined }))} />
          ) : (
            <Text size="xs" muted>
              No penalties applied.
            </Text>
          )}
        </Box>
      )}
      {section(
        'vitals',
        'Vital signs',
        null,
        <Grid minItemWidth="lg" gap="sm">
          {groups.map((g) => (
            <Box border radius="md" padding="sm" gap="xs">
              <Text size="xs" muted weight="medium">
                {g}
              </Text>
              <KeyValue items={h.vitals.filter((v) => v.group === g).map((v) => ({ label: v.label, value: v.value, ...(v.tone && v.tone !== 'success' ? { tone: v.tone } : {}) }))} />
            </Box>
          ))}
        </Grid>
      )}
      {h.targets.length
        ? section(
            'targets',
            'Refactoring candidates',
            h.targets.length,
            list(h.targets.map((t, i) => fileRow(t.path, `${t.recommendation} · effort ${t.effort}, confidence ${t.confidence}`, work.targets[i])))
          )
        : null}
      {h.hotspots.length
        ? section(
            'hotspots',
            'Hotspot candidates',
            h.hotspots.length,
            list(h.hotspots.map((x, i) => fileRow(x.path, `score ${x.score.toFixed(1)} · ${plural(x.commits, 'commit', 'commits')}${x.trend ? ` · ${x.trend}` : ''}`, work.hotspots[i])))
          )
        : null}
      {h.coupling.length
        ? section(
            'coupling',
            'Hidden change coupling',
            h.coupling.length,
            list(
              h.coupling.map((p, i) => (
                <Box direction="column" gap="none" paddingX="sm" paddingY="xs">
                  <Box direction="row" gap="xs" align="center">
                    <Box grow minWidth={0}>
                      <Text size="xs" muted>
                        {`${(p.degree * 100).toFixed(0)}% degree · ${plural(p.shared, 'shared commit', 'shared commits')}${p.strong ? ' · strong' : ''} · no import connects them`}
                      </Text>
                    </Box>
                    {agentButton(work.coupling[i])}
                  </Box>
                  {[p.a, p.b].map((path) => (
                    <Box direction="row" gap="xs" align="center">
                      <Box grow minWidth={0}>
                        <Text size="sm" truncate>
                          {path}
                        </Text>
                      </Box>
                      {opener(path)}
                    </Box>
                  ))}
                </Box>
              ))
            )
          )
        : null}
      {h.files.length
        ? section(
            'files',
            'Least maintainable files',
            h.files.length,
            list(h.files.map((f, i) => fileRow(f.path, `maintainability ${f.maintainability.toFixed(1)} · cyclomatic ${f.cyclomatic} · ${f.lines} lines · fan-in ${f.fanIn}, fan-out ${f.fanOut}`, work.files[i])))
          )
        : null}
      <Text size="xs" muted>
        {[h.scope, h.frameworks.length ? `frameworks: ${h.frameworks.join(', ')}` : ''].filter(Boolean).join(' · ')}
      </Text>
      <Text size="xs" muted>
        Hotspots, targets and coupling are heuristics from Git history: verify before acting.
      </Text>
    </Stack>
  )
}

export default function Panel() {
  const a = read(analysis)
  const working = read(busy)
  const current = read(filter)
  const q = read(query).trim().toLowerCase()
  const failed = read(failure)
  const all = a?.findings ?? []
  const matching = all.filter((f) => !q || `${f.title} ${f.detail}`.toLowerCase().includes(q))
  const counts = Object.fromEntries(FILTERS.map((s) => [s, matching.filter((f) => s === 'all' || f.severity === s).length])) as Record<Filter, number>
  const shown = matching.filter((f) => current === 'all' || f.severity === current)
  const hasRun = !!a?.ranAt
  const fixable = all.filter((f) => f.fix).length

  return (
    <Stack gap="md">
      <Row justify="between" align="start">
        <Stack gap="none">
          <Heading>Fallow</Heading>
          <Text muted size="sm" truncate>
            {a?.path ? a.path.split('/').slice(-2).join('/') : 'Codebase analysis'}
          </Text>
        </Stack>
        <IconButton icon="refresh" label={hasRun ? 'Run again' : 'Run analysis'} variant="ghost" disabled={working} onPress={run} />
      </Row>
      {failed ? (
        <Callout tone="danger" icon="error">
          <Row justify="between" gap="xs">
            <Text size="sm">{failed}</Text>
            <IconButton icon="close" label="Dismiss" variant="ghost" size="xs" onPress={() => set(failure, null)} />
          </Row>
        </Callout>
      ) : null}
      {a?.error ? <Callout tone="warning">{a.error}</Callout> : null}
      {read(done) ? (
        <Callout tone="success" icon="check">
          <Row justify="between" gap="xs">
            <Text size="sm">{read(done)}</Text>
            <IconButton icon="close" label="Dismiss" variant="ghost" size="xs" onPress={() => set(done, null)} />
          </Row>
        </Callout>
      ) : null}
      {read(preview) ? PreviewCard(read(preview)!) : null}
      {working && !hasRun ? <Skeleton lines={4} label="Running Fallow" /> : null}
      {!working && a && !a.error && !hasRun ? (
        <EmptyState
          icon="activity"
          title="Analyse this workspace"
          description="Finds unused files, exports and dependencies, duplication, circular imports and complexity hotspots. Fallow runs on your machine; the first run downloads it with npx."
        >
          <Button icon="play" tone="accent" variant="solid" onPress={run}>
            Run Fallow
          </Button>
        </EmptyState>
      ) : null}
      {hasRun && !a!.error ? (
        <Stack gap="md">
          {HealthStrip(a!)}
          <Tabs label="View" value={!a!.health && read(view) === 'health' ? 'findings' : read(view)} onChange={(v) => set(view, v as View)}>
            <Tab value="findings" label={`Findings (${all.length})`} icon="filter">
              {null}
            </Tab>
            {a!.health ? (
              <Tab value="health" label="Health" icon="activity">
                {null}
              </Tab>
            ) : null}
            <Tab value="agent" label="Agent" icon="agent">
              {null}
            </Tab>
          </Tabs>
          {read(view) === 'agent' ? AgentView(a!) : a!.health && read(view) === 'health' ? HealthView(a!) : FindingsView()}
        </Stack>
      ) : null}
    </Stack>
  )

  function FindingsView() {
    return (
      <Stack gap="md">
          <Tabs label="Severity" value={current} onChange={(v) => set(filter, v as Filter)}>
            {FILTERS.map((s) => (
              <Tab value={s} label={`${FILTER_LABEL[s]} (${counts[s]})`}>
                {null}
              </Tab>
            ))}
          </Tabs>
          <Input label="Search findings" labelHidden type="search" placeholder="Search files and names…" value={read(query)} onChange={(v) => set(query, v)} />
          {fixable && !read(preview) ? (
            <Button icon="wrench" variant="outline" disabled={read(fixing) || working} onPress={() => planFix()}>
              {`Preview fixes (${fixable})`}
            </Button>
          ) : null}
          <Row justify="between">
            <Text weight="semibold">{plural(shown.length, 'finding', 'findings')}</Text>
            <Text muted size="xs">
              {working ? 'Running Fallow…' : `Fallow ${a!.version ?? ''}${a!.elapsedMs != null ? ` · ${(a!.elapsedMs / 1000).toFixed(1)}s` : ''}`}
            </Text>
          </Row>
          {shown.length === 0 ? (
            <EmptyState icon="check" title={q ? 'No matching findings' : current === 'all' ? 'Nothing to clean up' : `No ${FILTER_LABEL[current].toLowerCase()}`} />
          ) : (
            CATEGORIES.map((c) => ({ ...c, findings: shown.filter((f) => f.category === c.id) }))
              .filter((c) => c.findings.length)
              .map((c) => CategoryBlock(c))
          )}
      </Stack>
    )
  }
}
