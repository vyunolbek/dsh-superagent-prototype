/** GitLab source kind definition, todo and thread polling loops, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { sameName } from '../infra/text.ts'
import { GitlabAccountsSchema } from '../deployment.ts'
import { CliError, validItems, type Tally } from '../infra/commands.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import type { Thread } from '../core/index.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'
import type { Localized, SourceKind } from './kind.ts'
import { z } from 'zod'
import { descriptionTrigger, encodeProject, DescriptionSchema, gitlabThread, NoteSchema, noteTrigger, SOURCE, TodoSchema, type GitlabDescription, type GitlabNote, type GitlabRef, type GitlabTodo }
  from './gitlab-trigger.ts'
import { glabApi, glabPages } from './gitlab-api.ts'
import { gitlabLink, sendGlab } from './gitlab-channel.ts'

const GitlabConfigSchema = GitlabAccountsSchema.extend({ pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observeMergeRequests: z.boolean().default(false) }).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const OBSERVED = { issues: 'observeIssues', mergeRequests: 'observeMergeRequests' } as const
type Scope = keyof typeof OBSERVED | 'comments'
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'mr') return 'mergeRequests'
  return meta.kind === 'conversation' ? 'comments' : undefined
}
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体的 GitLab 账号；接收项目里发给它的待办、已订阅 Issue 与 MR 的讨论和新 Issue 与 MR。', en: 'The agent\'s GitLab accounts; receives todos to it in the project, discussion on subscribed Issues and merge requests, and new Issues and merge requests.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'baseUrl', type: 'text', pattern: '^https?://', label: { zh: 'GitLab 地址', en: 'GitLab base URL' },
      hint: { zh: '写作 http(s)://主机。保存时检查智能体账号能否推送到项目，然后重启 dsh-superagent。', en: 'Written http(s)://host. Saving checks that the agent account can push to the project, then restarts dsh-superagent.' } },
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+', label: { zh: '监听的项目', en: 'Project' },
      hint: { zh: '写作 group/project。这个来源接收这个项目的待办和讨论；保存时检查智能体账号能否推送到它，然后重启 dsh-superagent。', en: 'Written group/project. This Source receives the project\'s todos and discussion; saving checks that the agent account can push to it, then restarts dsh-superagent.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '命令名或绝对路径，通常是用 GLAB_CONFIG_DIR 登录智能体账号的 glab 包装脚本。智能体以它登录的账号行事，执行器以 glab 调用它。保存时检查它登录的账号能否推送到项目，然后重启 dsh-superagent。', en: 'A command name or absolute path, usually a glab wrapper signed in to the agent account through GLAB_CONFIG_DIR. The agent acts as the account it is signed in to, and the Executor calls it as glab. Saving checks that this account can push to the project, then restarts dsh-superagent.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
      hint: { zh: 'GitLab 要求更长间隔时以 GitLab 为准。', en: 'A longer interval requested by GitLab wins.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 Issue', en: 'Receive new Issues in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observeMergeRequests', type: 'switch', label: { zh: '接收项目里的新 MR', en: 'Receive new merge requests in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新 MR 也会收到，由策略的接收表决定是否成为候选。', en: 'New merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
  ],
  // What the Source observes across the project it receives in full; elsewhere, only what addresses the agent.
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && row in OBSERVED && !!config[OBSERVED[row as keyof typeof OBSERVED]], ...row ? { row } : {} }
  },
  health: ['gitlab'],
  channel: { send: sendGlab, link: gitlabLink },
  threadContext: {
    // The first page opens with the Issue or merge request description; its message ID names the description Trigger.
    messageId: trigger => typeof trigger.meta.noteId === 'number' ? String(trigger.meta.noteId) : `desc-${trigger.meta.iid}`,
    read: async (commands, trigger, _part, cursor) => {
      const kind = trigger.meta.kind === 'mr' ? 'merge_requests' : 'issues'
      const iid = String(trigger.meta.iid ?? '')
      const project = encodeProject(commands.deployment.gitlab?.project ?? '')
      const page = Number(cursor ?? '1')
      const listed = await commands.run('glab', ['api', `projects/${project}/${kind}/${iid}/notes?sort=asc&order_by=created_at&per_page=100&page=${page}`])
      const tally = { skipped: 0 }
      const notes = validItems(NoteSchema, z.array(z.unknown()).parse(JSON.parse(listed)), tally)
      const messages = notes.filter(note => !note.system).map(note => ({ id: String(note.id), from: note.author?.username ?? 'ghost',
        at: note.updated_at ?? note.created_at ?? '', text: note.body ?? '' }))
      if (page === 1) {
        const item = await glabApi(commands, DescriptionSchema, `projects/${project}/${kind}/${iid}`)
        messages.unshift({ id: `desc-${item.iid}`, from: item.author?.username ?? 'ghost', at: item.created_at ?? '',
          text: `${item.title}\n\n${item.description ?? ''}` })
      }
      return { messages, next: notes.length === 100 ? String(page + 1) : undefined, body: { messages } }
    },
  },
  // `#12` names both Threads, which share one sequence nowhere in GitLab; the store keeps whichever exists.
  find: query => {
    const trimmed = query.trim()
    const bare = /^#?(\d+)$/.exec(trimmed)?.[1]
    const issue = /\/-\/issues\/(\d+)$/.exec(trimmed)?.[1]
    const mr = /\/-\/merge_requests\/(\d+)$/.exec(trimmed)?.[1] ?? /^!(\d+)$/.exec(trimmed)?.[1]
    return { threads: [...new Set([...bare ? [`gitlab:i${bare}`, `gitlab:mr${bare}`] : [], ...issue ? [`gitlab:i${issue}`] : [], ...mr ? [`gitlab:mr${mr}`] : []])], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue、MR 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue, merge request, or comment.' },
    rows(stored) {
      const config = GitlabConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id as keyof typeof OBSERVED]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id as keyof typeof OBSERVED]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id as keyof typeof OBSERVED]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('mergeRequests', { zh: '新 MR', en: 'New merge requests' }),
        // Comments are only read for subscribed Threads and todos, so only mentions arrive.
        { id: 'comments', label: { zh: '评论', en: 'Comments' }, note: { zh: '仅 @', en: '@ only' },
          cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_URL', description: { zh: '这个来源监听的 GitLab 地址，http(s)://主机', en: 'The base URL of the GitLab this Source watches, as http(s)://host' } },
      { key: 'DSH_SUPERAGENT_GITLAB_REPOSITORY', description: { zh: '这个来源监听的项目，group/project', en: 'The project this Source watches, as group/project' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；glab 以它登录，GitLab 操作都用 glab，不用其他账号或凭据', en: 'The agent\'s GitLab account. glab is signed in to it; use glab for every GitLab operation, and never another account or credential' } },
      { key: 'DSH_SUPERAGENT_GITLAB_NUMBER', description: { zh: '接下工单的 Issue 或 MR 编号（iid）；工单不是从 GitLab 来的时为空', en: 'Number (iid) of the Issue or merge request that started the ticket; empty when the ticket did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_HEAD', description: { zh: '接下工单的 MR 的 head 引用 refs/merge-requests/<编号>/head；不是 MR 时为空', en: 'Head ref refs/merge-requests/<iid>/head of the merge request that started the ticket; empty when it was not a merge request' } },
    ],
    values: ({ deployment, trigger }) => {
      const iid = trigger?.source === SOURCE ? Number(trigger.meta.iid) || 0 : 0
      return { DSH_SUPERAGENT_GITLAB_URL: deployment.gitlab?.host ?? '', DSH_SUPERAGENT_GITLAB_REPOSITORY: deployment.gitlab?.project ?? '',
        DSH_SUPERAGENT_GITLAB_ACCOUNT: deployment.gitlab?.login ?? '', DSH_SUPERAGENT_GITLAB_NUMBER: iid ? String(iid) : '',
        DSH_SUPERAGENT_GITLAB_MR_HEAD: iid && trigger?.meta.kind === 'mr' ? `refs/merge-requests/${iid}/head` : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? {
    cli: { zh: `当前账号 @${deployment.gitlab.login}`, en: `Current account @${deployment.gitlab.login}` },
  } : {},
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
const available = (ctx: SourceContext): boolean => {
  if (ctx.configured() && ctx.deployment.gitlab) return true
  const waiting = health('paused', ctx.configured() ? 'gitlabCliUnset' : 'setupPending')
  ctx.report('gitlab', ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : waiting)
  return false
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is polled.
  if (!available(ctx)) return
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (config && available(ctx)) interval = await pollRound(ctx, signal)
      else ctx.report('gitlab', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('gitlab', failed)
    }
    await pause(Math.max(interval, ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round { started: string; signal?: AbortSignal | undefined; failures: string[]; dropped: number[]; tally: Tally; count: number }
const newRound = (signal?: AbortSignal): Round =>
  ({ started: new Date().toISOString(), signal, failures: [], dropped: [], tally: { skipped: 0 }, count: 0 })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
/** True when GitLab reports the target as deleted (404) or moved (301, which a project rename reports). */
const deleted = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410)
/** Records a failed read on the Thread and in the round; deleted threads do not fail the round. */
function failed(ctx: SourceContext, round: Round, thread: string, error: unknown): void {
  const iid = Number(/^[a-z]+(\d+)$/.exec(thread)?.[1])
  if (deleted(error) && Number.isInteger(iid)) round.dropped.push(iid)
  else round.failures.push(`${thread}: ${String(error)}`)
  ctx.threads.patch(`gitlab:${thread}`, { pollError: String(error) })
}
/** The Thread of a todo or stream item, or undefined when it names no Issue or merge request. */
const refOf = (todo: { target_type?: string | null | undefined; target?: { iid?: number | null | undefined } | null | undefined }): GitlabRef | undefined => {
  const kind = todo.target_type === 'Issue' ? 'issue' : todo.target_type === 'MergeRequest' ? 'mr' : undefined
  return kind && todo.target?.iid ? { kind, iid: todo.target.iid } : undefined
}
/**
 * One polling round: the agent account's pending todos, then observed repository streams, then subscribed Threads.
 * Each step and each Issue, MR, or Thread fails independently so all steps run before the round fails.
 * @returns the polling interval, in seconds.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  await pollTodos(ctx, round)
  await pollStreams(ctx, round)
  await pollThreads(ctx, signal, round)
  if (signal?.aborted) return 60
  if (round.failures.length) throw new Error(`${round.failures.length} GitLab reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const named = (numbers: number[]) => [...new Set(numbers)].sort((a, b) => a - b).map(number => `#${number}`).join(', ')
  const dropped = (round.dropped.length ? `; deleted on GitLab: ${named(round.dropped)}` : '')
    + (round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : '')
  ctx.report('gitlab', { state: 'ready', detail: `${round.count} todos; next poll ≥ 60s${dropped}`, at: round.started })
  return 60
}
/** Reads the pending todos of the agent account since their last read and marks each done once its Issue or MR was read; a todo whose target keeps failing stays pending and retries next round, while a deleted target is marked done once its error is recorded. */
async function pollTodos(ctx: SourceContext, round: Round): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const todos = await glabPages(commands, TodoSchema, 'todos?per_page=100', round.tally)
  round.count = todos.length
  // A mixed deployment names the GitHub repository in `repository`; the GitLab project lives on the GitLab accounts.
  const project = ctx.deployment.gitlab?.project
  for (const todo of todos.slice().reverse()) {
    if (stopped(ctx, round)) return
    // Todos of other projects, of the agent's own messages, and of unreadable targets are marked done and left alone.
    const ref = refOf(todo)
    if (!ref || !todo.project?.path_with_namespace || !project || !sameName(todo.project.path_with_namespace, project)) {
      await commands.run('glab', ['api', `todos/${todo.id}/mark_as_done`, '--method', 'POST']).catch(() => {})
      continue
    }
    try {
      // Reading from the todo's own update leaves notes from before it alone.
      await readTarget(ctx, round, ref, todo.updated_at ?? undefined)
      await commands.run('glab', ['api', `todos/${todo.id}/mark_as_done`, '--method', 'POST'])
    } catch (error) {
      if (stopped(ctx, round)) return
      // A deleted or moved Issue or MR never arrives; mark its todo done so it does not retry forever.
      if (deleted(error)) {
        await commands.run('glab', ['api', `todos/${todo.id}/mark_as_done`, '--method', 'POST']).catch(() => {})
        round.dropped.push(ref.iid)
        continue
      }
      round.failures.push(`todo for ${gitlabThread(ref.kind, ref.iid)}: ${String(error)}`)
    }
  }
}
/** Reads an Issue or merge request and its notes since the Thread's cursor, with the cursor advanced atomically after them. */
async function readTarget(ctx: SourceContext, round: Round, ref: GitlabRef, floor?: string | undefined): Promise<void> {
  const thread = gitlabThread(ref.kind, ref.iid)
  const checkpoint = KV.gitlab.cursor(thread)
  const since = [ctx.state.get(checkpoint) ?? '', floor ?? round.started].sort().at(-1)!
  const item = await readDescription(ctx, round, ref)
  const { login } = ctx.deployment.gitlab ?? { login: '' }  // An Issue or MR opened by someone other than the agent since the cursor brings its body so a mention in it reaches the gate.
  // A mention added by a later edit to the body is not read: only the author can be the actor of the body.
  if (item.created_at && Date.parse(item.created_at) >= Date.parse(since) && !sameName(item.author?.username ?? '', login)) {
    await ctx.receive(descriptionTrigger(item, ref.kind, login))
  }
  await intakeNotes(ctx, ref, since, round)
  ctx.state.set(checkpoint, cursorAt(round.started))
  if (item.title) nameThread(ctx, ref, item.title)
  ctx.threads.patch(`gitlab:${thread}`, { pollError: undefined })
}
async function readDescription(ctx: SourceContext, round: Round, ref: GitlabRef): Promise<GitlabDescription> {
  const commands = ctx.commands.withSignal(round.signal)
  const project = encodeProject(ctx.deployment.gitlab?.project ?? '')
  const kind = ref.kind === 'mr' ? 'merge_requests' : 'issues'
  return glabApi(commands, DescriptionSchema, `projects/${project}/${kind}/${ref.iid}`)
}
/** Reads the notes of an Issue or merge request since `since` and receives each conversation note as a Trigger. */
async function intakeNotes(ctx: SourceContext, ref: GitlabRef, since: string, round: Round): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const { login } = ctx.deployment.gitlab ?? { login: '' }
  const project = encodeProject(ctx.deployment.gitlab?.project ?? '')
  const kind = ref.kind === 'mr' ? 'merge_requests' : 'issues'
  const path = `projects/${project}/${kind}/${ref.iid}/notes?sort=asc&order_by=created_at&per_page=100`
  const notes = await glabPages(commands, NoteSchema, path, round.tally)
  for (const note of notes) {
    // Stopping mid-read throws so the thread's cursor stays where it was.
    if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
    const timestamp = Date.parse(note.updated_at ?? note.created_at ?? '')
    if (!Number.isFinite(timestamp) || timestamp < Date.parse(since) || note.system === true) continue
    if (sameName(note.author?.username ?? '', login)) continue
    await ctx.receive(noteTrigger(note, ref, login))
  }
}
function nameThread(ctx: SourceContext, ref: GitlabRef, title: string): void {
  const thread = gitlabThread(ref.kind, ref.iid)
  ctx.threads.patch(thread, { title })
  ctx.threads.describe(`gitlab:${thread}`, { label: `${ref.kind === 'mr' ? '!' : '#'}${ref.iid} ${title}`, facts: {} })
}
/** Polls repository-wide streams (new Issues and merge requests); each stream reads from when it was switched on, resets when switched off, and fails independently. */
async function pollStreams(ctx: SourceContext, round: Round): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return
  const commands = ctx.commands.withSignal(round.signal)
  const project = encodeProject(ctx.deployment.gitlab?.project ?? '')
  for (const stream of [{ id: 'issues', kind: 'issue', observed: config.observeIssues, path: 'issues?state=all' },
    { id: 'mergeRequests', kind: 'mr', observed: config.observeMergeRequests, path: 'merge_requests?state=all' }] as const) {
    if (stopped(ctx, round)) return
    const name = KV.gitlab.stream(stream.id)
    if (!stream.observed) { ctx.state.set(name, undefined); continue }
    try {
      const stored = ctx.state.get(name)
      const since = new Date(Math.max(Date.parse(stored?.since ?? round.started), Date.parse(round.started) - POLL_HORIZON_MS)).toISOString()
      const begin = [since, stored?.started ?? round.started].sort().at(-1)!
      const listed = `${stream.path}&order_by=updated_at&sort=asc&per_page=100&updated_after=${encodeURIComponent(since)}`
      const items = validItems(DescriptionSchema, z.array(z.unknown()).parse(JSON.parse(await commands.run('glab', ['api', listed]))), round.tally)
      const { login } = ctx.deployment.gitlab ?? { login: '' }
      for (const item of items) {
        // Stopping mid-stream aborts before advancing the cursor so unread items are retried.
        if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
        if (sameName(item.author?.username ?? '', login)) continue
        // The stream only feeds newly opened Issues and merge requests; their discussion arrives through todos and Threads.
        if (!item.created_at || Date.parse(item.created_at) < Date.parse(begin)) continue
        const ref: GitlabRef = { kind: stream.kind, iid: item.iid, url: item.web_url ?? undefined }
        await readTarget(ctx, round, ref, item.updated_at ?? undefined)
      }
      const newest = Math.max(...items.map(item => Date.parse(item.updated_at ?? '')).filter(Number.isFinite))
      const moved = Number.isFinite(newest) ? cursorAt(new Date(newest).toISOString()) : since
      ctx.state.set(name, { since: Date.parse(moved) > Date.parse(since) ? moved : since, started: stored?.started ?? round.started })
    } catch (error) { if (!stopped(ctx, round)) round.failures.push(`${stream.id}: ${String(error)}`) }
  }
}
/** Polls subscribed Issue and merge request Threads; a deleted Issue or merge request does not fail the round once its error is recorded. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round: Round = newRound(signal)): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    try { await pollThread(ctx, round, thread) }
    catch (error) {
      if (stopped(ctx, round)) throw error
      failed(ctx, round, thread.ref.id, error)
    }
  })
}
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  const iid = Number(/^[a-z]+(\d+)$/.exec(thread.ref.id)?.[1])
  if (!iid) throw new Error('Subscribed thread has no GitLab Issue or MR number')
  const kind = thread.ref.id.startsWith('i') ? 'issue' : 'mr'
  const ref: GitlabRef = { kind, iid }
  const checkpoint = KV.gitlab.cursor(thread.ref.id)
  const since = ctx.state.get(checkpoint) ?? thread.createdAt
  const item = await readDescription(ctx, round, ref)
  if (typeof thread.meta.title !== 'string' && item.title) {
    ctx.threads.patch(thread.key, { kind, iid, url: item.web_url ?? undefined })
    nameThread(ctx, ref, item.title)
  }
  await intakeNotes(ctx, ref, since, round)
  ctx.state.set(checkpoint, cursorAt(round.started))
}
