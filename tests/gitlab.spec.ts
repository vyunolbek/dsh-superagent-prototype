import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { apply as applyGitlab, gitlabKind, pollRound } from '../src/sources/gitlab.ts'
import { descriptionTrigger, encodeProject, gitlabAddress, gitlabChannel, gitlabPage, noteTrigger, type GitlabTodo } from '../src/sources/gitlab-trigger.ts'
import { sendGlab, gitlabLink } from '../src/sources/gitlab-channel.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { SetupError } from '../src/setup.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OutboundMessage } from '../src/core/index.ts'

const AGENT = 'agent-bot'
const HOST = 'https://gitlab.example.com'
const PROJECT = 'acme/widgets'
const gitlabDeployment = () => ({ cli: '/bin/false', login: AGENT, host: HOST, project: PROJECT })
function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gitlab-')), 'db.sqlite'))
  const settings = SettingsSchema.parse({
    policy: { sources: { gitlab: { allowed: [{ id: 'alice', name: 'Alice' }] } } }, eval: { mode: 'auto' },
    sources: { gitlab: { enabled: true, config: { baseUrl: HOST, repository: PROJECT, cli: '/bin/false' } } } })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = overrides.sources ?? new SourceRegistry(() => store.settings(), board)
  if (!overrides.sources) healthOf.set(sources, board)
  const deployment = testDeployment({ gitlab: gitlabDeployment() })
  if (!overrides.sources) sources.register(gitlabKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  const context = sourceContextOf(parts, { kind: 'gitlab', health: ['gitlab'] })
  const live = (overrides.sources ? healthOf.get(overrides.sources)! : board)
  return { ...value, ...context, get health() { return live.all }, store, engine, commands, receive, executor }
}
const healthOf = new WeakMap<SourceRegistry, HealthBoard>()
function emptyRegistry(): SourceRegistry {
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
  healthOf.set(sources, board)
  return sources
}
/** Stubs `glab api` calls against the project and returns the requested paths in order. */
function glab(h: ReturnType<typeof host>, routes: Record<string, unknown>): string[] {
  const reads: string[] = []
  vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
    reads.push(args[1]!)
    const path = (args[1] ?? '').split('?')[0]!
    const value: unknown = routes[path] ?? []
    if (value instanceof Error) throw value
    return JSON.stringify(value)
  })
  return reads
}
const bare = (reads: string[]) => reads.map(path => path.split('?')[0])
const todo = (id: number, kind: 'Issue' | 'MergeRequest', iid: number, project = PROJECT): GitlabTodo =>
  ({ id, target_type: kind, updated_at: '2026-09-01T00:00:00Z', project: { path_with_namespace: project }, target: { iid } })
const note = (id: number, username: string, body: string, at = '2026-09-09T01:00:00Z') =>
  ({ id, body, author: { username }, created_at: at, updated_at: at })
const issue = (iid: number, fields: Record<string, unknown> = {}) =>
  ({ iid, title: `Fix the margin ${iid}`, description: 'see the margin', author: { username: 'carol' },
    web_url: `${HOST}/${PROJECT}/-/issues/${iid}`, created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:00Z', ...fields })
const mergeRequest = (iid: number, fields: Record<string, unknown> = {}) =>
  ({ iid, title: `Merge ${iid}`, description: '', author: { username: 'carol' },
    web_url: `${HOST}/${PROJECT}/-/merge_requests/${iid}`, created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:00Z', ...fields })
const refused = (status: number, text: string) => commandError({ stderr: `glab: ${text} (HTTP ${status})`, code: 1 })
const message = (id: string, kind: 'issue' | 'mr', iid: number, text: string): OutboundMessage =>
  ({ id, kind: 'reply', text, channel: gitlabChannel(kind, iid) } as unknown as OutboundMessage)

let dirs: string[] = []
beforeEach(() => { dirs = [] })
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

describe('gitlab source', () => {
  it('registers its kind without an account, and names on its health what setup still needs', async () => {
    const run = async (overrides: Partial<SourceContextDeps>) => {
      // This host starts empty so the plugin's registration shows.
      const value = host({ sources: emptyRegistry(), ...overrides })
      const disposers: (() => unknown)[] = []
      applyGitlab({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      const registered = value.sources.kind('gitlab')
      await vi.waitFor(() => expect(value.health.gitlab).toMatchObject({ state: 'paused' }))
      const health = { ...value.health }
      for (const dispose of disposers) await dispose()
      return { ...value, registered, health }
    }
    const unset = await run({ deployment: testDeployment({ gitlab: undefined }) })
    expect(unset.registered).toBe(gitlabKind)
    expect(unset.health).toMatchObject({ gitlab: { state: 'paused', code: 'gitlabCliUnset' } })
    expect((await run({ configured: () => false })).health.gitlab).toEqual({ state: 'paused', detail: 'Waiting for the deployment check', code: 'setupPending' })
  })

  it('parses the address of an Issue, a merge request or their pages, and encodes the project path', () => {
    expect(gitlabAddress(`${HOST}/${PROJECT}/-/issues/12`)).toEqual({ kind: 'issue', iid: 12 })
    expect(gitlabAddress(`${HOST}/${PROJECT}/-/merge_requests/7`)).toEqual({ kind: 'mr', iid: 7 })
    expect(gitlabAddress(`${HOST}/${PROJECT}/-/merge_requests/7/diffs`)).toBeUndefined()
    expect(encodeProject('acme/widgets')).toBe('acme%2Fwidgets')
    expect(gitlabPage(HOST, PROJECT, 12)).toBe(`${HOST}/${PROJECT}/-/issues/12`)
    expect(gitlabPage(HOST, PROJECT, 7, true)).toBe(`${HOST}/${PROJECT}/-/merge_requests/7`)
  })

  it('translates notes and descriptions into triggers keyed by note and iid, and addresses mentions of the agent', () => {
    const trigger = noteTrigger(note(5, 'alice', `@${AGENT} please fix`), { kind: 'issue', iid: 12, url: `${HOST}/${PROJECT}/-/issues/12#note_5` }, AGENT)
    expect(trigger).toMatchObject({ id: key('gitlab-comment', `${HOST}/${PROJECT}/-/issues/12#note_5`, '5', note(5, 'alice', '').updated_at),
      source: 'gitlab', threads: [{ source: 'gitlab', id: 'i12' }], actor: { source: 'gitlab', id: 'alice' }, human: true,
      addressed: 'mention', url: `${HOST}/${PROJECT}/-/issues/12#note_5`, channel: { source: 'gitlab', thread: 'gitlab:i12', address: { kind: 'issue', number: '12' } },
      meta: { kind: 'issue', iid: 12, noteId: 5 } })
    // A mail-like string is not a mention; a merge request thread names its own sequence.
    expect(noteTrigger(note(6, 'alice', `mail@${AGENT}.example`), { kind: 'issue', iid: 12 }, AGENT)).not.toHaveProperty('addressed')
    const mr = noteTrigger(note(7, 'bob', 'nit'), { kind: 'mr', iid: 7 }, AGENT)
    expect(mr.threads).toEqual([{ source: 'gitlab', id: 'mr7' }])
    expect(mr).not.toHaveProperty('addressed')
    // A description's trigger is keyed by its iid, so an already-stored body is not ingested again.
    const opened = descriptionTrigger(issue(12) as never, 'issue', AGENT)
    expect(opened.id).toBe(key('gitlab-issue', '12'))
    expect(opened.text).toBe('Fix the margin 12\n\nsee the margin')
    expect(descriptionTrigger(mergeRequest(7) as never, 'mr', AGENT).id).toBe(key('gitlab-mr', '7'))
  })

  it('takes in todos by reading their Issue or merge request, marks them done, and leaves todos of other projects alone', async () => {
    const h = host()
    h.store.set(KV.gitlab.cursor('i12'), '2026-09-01T00:00:00.000Z')
    const reads = glab(h, {
      todos: [todo(1, 'Issue', 12), todo(2, 'Issue', 20, 'acme/other'), todo(3, 'Issue', 1, 'acme/other')],
      [`projects/acme%2Fwidgets/issues/12`]: issue(12),
      [`projects/acme%2Fwidgets/issues/12/notes`]: [note(5, 'alice', `@${AGENT} take this`)],
    })
    await pollRound(h)
    // The todo of another project and of an unreadable target are marked done without reading anything.
    expect(bare(reads)).toEqual(['todos', `todos/3/mark_as_done`, `todos/2/mark_as_done`,
      `projects/acme%2Fwidgets/issues/12`, `projects/acme%2Fwidgets/issues/12/notes`, `todos/1/mark_as_done`])
    expect(h.receive).toHaveBeenCalledTimes(2)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta)).toEqual([
      expect.objectContaining({ kind: 'issue', iid: 12 }), expect.objectContaining({ kind: 'issue', iid: 12, noteId: 5 })])
    h.store.close()
  })

  it('reads a failing target again next round, and marks a deleted one done once its error is recorded', async () => {
    const h = host()
    const routes: Record<string, unknown> = {
      todos: [todo(1, 'Issue', 12), todo(2, 'Issue', 14)],
      [`projects/acme%2Fwidgets/issues/12`]: refused(502, 'Bad Gateway'),
      [`projects/acme%2Fwidgets/issues/14`]: refused(404, 'Not Found'),
    }
    glab(h, routes)
    await expect(pollRound(h)).rejects.toThrow('todo for i12')
    // The failing todo stays pending; the deleted one is done.
    expect(bare(h.store.keys('glab-'))).toEqual([])
    routes.todos = [todo(1, 'Issue', 12)]
    routes[`projects/acme%2Fwidgets/issues/12`] = issue(12)
    routes[`projects/acme%2Fwidgets/issues/12/notes`] = [note(5, 'alice', `@${AGENT} take this`)]
    h.store.set(KV.gitlab.cursor('i12'), '2026-09-01T00:00:00.000Z')
    await pollRound(h)
    expect(h.receive).toHaveLength(1)
    h.store.close()
  })

  it('reads subscribed threads from their cursor, deduplicating notes between rounds', async () => {
    const h = host()
    h.store.threads.save({ key: 'gitlab:i12', ref: { source: 'gitlab', id: 'i12' }, createdAt: '2026-09-01T00:00:00Z',
      lastAt: new Date().toISOString(), subscriptions: ['t'], correlated: [], pending: [], meta: { kind: 'issue', iid: 12 } })
    const notes: Record<string, unknown>[] = [note(5, 'alice', `@${AGENT} first`, '2026-09-09T01:00:00Z')]
    const routes: Record<string, unknown> = { todos: [], [`projects/acme%2Fwidgets/issues/12`]: issue(12),
      [`projects/acme%2Fwidgets/issues/12/notes`]: notes }
    glab(h, routes)
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    // A second round reads the same notes but takes in none: the cursor moved past them.
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    // A system note and the agent's own notes never arrive.
    notes.push({ ...note(6, 'alice', 'changed the title', '2026-09-09T02:00:00Z'), system: true })
    notes.push(note(7, AGENT, 'Done', '2026-09-09T03:00:00Z'))
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    h.store.close()
  })

  it('sends a reply as a note with an idempotency marker, sending nothing when the marker is already there', async () => {
    const h = host()
    const writes: string[] = []
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      writes.push(args.join(' '))
      if (args.includes('--method')) return '{}'
      if (writes.length > 1) return JSON.stringify([{ id: 9, body: `done\n\n<!-- dsh-superagent:m1 -->`, author: { username: AGENT } }])
      return JSON.stringify([])
    })
    expect(await sendGlab(h, message('m1', 'issue', 12, 'Done'))).toBe('sent')
    expect(writes.filter(args => args.includes('--method'))).toHaveLength(1)
    // A retry of the same message finds its marker and posts nothing.
    expect(await sendGlab(h, message('m1', 'issue', 12, 'Done'))).toBe('sent')
    expect(writes.filter(args => args.includes('--method'))).toHaveLength(1)
    h.store.close()
  })

  it('builds the page of an Issue or merge request from the resolved accounts, and nothing for an unknown channel', () => {
    const links = { repository: PROJECT, gitlab: gitlabDeployment() }
    expect(gitlabLink({ kind: 'issue', number: '12' }, links).url).toBe(`${HOST}/${PROJECT}/-/issues/12`)
    expect(gitlabLink({ kind: 'mr', number: '7' }, links).label).toEqual({ zh: 'GitLab !7', en: 'GitLab !7' })
    expect(gitlabLink({}, { repository: PROJECT }).url).toBe('')
  })

  it('reports its admission rows as mention-only everywhere, and new Issues and merge requests as observed when switched on', async () => {
    const rows = gitlabKind.policy!.rows!({})
    expect(rows.map(row => row.id)).toEqual(['issues', 'mergeRequests', 'comments'])
    expect(rows[2]).toMatchObject({ note: { en: '@ only' }, cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } })
    expect(rows[0]).toMatchObject({ note: { en: '@ only' }, cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } })
  })

  it('names the environment variables of the agent account and the ticket\'s Issue or merge request', () => {
    const variables = gitlabKind.environment!.values({ deployment: testDeployment({ gitlab: gitlabDeployment() }),
      trigger: { source: 'gitlab', meta: { kind: 'mr', iid: 7 } } } as never)
    expect(variables).toEqual({ DSH_SUPERAGENT_GITLAB_URL: HOST, DSH_SUPERAGENT_GITLAB_REPOSITORY: PROJECT,
      DSH_SUPERAGENT_GITLAB_ACCOUNT: AGENT, DSH_SUPERAGENT_GITLAB_NUMBER: '7', DSH_SUPERAGENT_GITLAB_MR_HEAD: 'refs/merge-requests/7/head' })
    const empty = gitlabKind.environment!.values({ deployment: testDeployment({ gitlab: undefined }), trigger: undefined } as never)
    expect(empty).toEqual({ DSH_SUPERAGENT_GITLAB_URL: '', DSH_SUPERAGENT_GITLAB_REPOSITORY: '', DSH_SUPERAGENT_GITLAB_ACCOUNT: '',
      DSH_SUPERAGENT_GITLAB_NUMBER: '', DSH_SUPERAGENT_GITLAB_MR_HEAD: '' })
  })
})

describe('gitlab setup', () => {
  const probe = (response: string) => async (args: readonly string[]) => {
    if (args.at(-1) === 'user') return response
    return JSON.stringify({ path_with_namespace: PROJECT, permissions: { project_access: { access_level: 40 }, group_access: null } })
  }
  it('resolves nothing when the Source names no GitLab at all, and refuses an unset base URL or project', async () => {
    expect(await import('../src/deployment.ts').then(m => m.resolveGitlab(testMachine(), {}, probe('{}')))).toBeUndefined()
    await expect(import('../src/deployment.ts').then(m => m.resolveGitlab(testMachine(), { repository: PROJECT, cli: '/bin/false' }, probe('{"username":"agent-bot","id":7}'))))
      .rejects.toMatchObject({ code: 'gitlabBaseUrlUnset' })
    await expect(import('../src/deployment.ts').then(m => m.resolveGitlab(testMachine(), { baseUrl: HOST }, probe('{"username":"agent-bot","id":7}'))))
      .rejects.toMatchObject({ code: 'gitlabRepositoryUnset' })
  })
  it('resolves the account and its push access from a project access level of at least Developer', async () => {
    const m = await import('../src/deployment.ts')
    const resolved = await m.resolveGitlab(testMachine(), { baseUrl: HOST, repository: PROJECT, cli: process.execPath }, probe('{"username":"agent-bot","id":7}'))
    expect(resolved).toEqual({ cli: process.execPath, login: 'agent-bot', host: HOST, project: PROJECT })
    // Group membership alone decides when the project names no access level of its own.
    const group = async (args: readonly string[]) => (args.at(-1) === 'user' ? '{"username":"agent-bot","id":7}' : only(args))
    const only = async (args: readonly string[]) => JSON.stringify({ path_with_namespace: PROJECT, permissions: { project_access: null, group_access: { access_level: 30 } } })
    const viaGroup = await m.resolveGitlab(testMachine(), { baseUrl: HOST, repository: PROJECT, cli: process.execPath }, group)
    expect(viaGroup).toMatchObject({ login: 'agent-bot' })
    const readonly = async (args: readonly string[]) => args.at(-1) === 'user' ? '{"username":"agent-bot","id":7}'
      : JSON.stringify({ path_with_namespace: PROJECT, permissions: { project_access: { access_level: 20 }, group_access: null } })
    await expect(m.resolveGitlab(testMachine(), { baseUrl: HOST, repository: PROJECT, cli: process.execPath }, readonly))
      .rejects.toMatchObject({ code: 'gitlabRepositoryReadOnly' })
    await expect(m.resolveGitlab(testMachine(), { baseUrl: HOST, repository: PROJECT, cli: process.execPath }, async () => { throw refused(401, 'Unauthorized') }))
      .rejects.toMatchObject({ code: 'gitlabCliSignedOut' })
    const problems = new SetupError('gitlabRepositoryReadOnly', { account: AGENT, repository: PROJECT }).problem
    expect(problems).toMatchObject({ place: 'gitlab', detail: expect.stringContaining('push') })
  })
  it('localizes a missing CLI as a GitLab problem', () => {
    expect(new SetupError('gitlabCliMissing', { output: 'not found' }).problem).toMatchObject({ place: 'gitlab', detail: expect.any(String) })
  })
})
