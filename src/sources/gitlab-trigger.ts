/** Normalizes GitLab issues, merge requests, and notes into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp } from '../infra/text.ts'

export const SOURCE = 'gitlab'
/** The Thread of one Issue or merge request; Issues and merge requests number from separate sequences, so the kind names the thread. */
export const gitlabThread = (kind: 'issue' | 'mr', iid: number): string => `${kind === 'issue' ? 'i' : 'mr'}${iid}`
/** GitLab reply address: an Issue or merge request conversation. */
export const gitlabChannel = (kind: 'issue' | 'mr', iid: number, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: `gitlab:${gitlabThread(kind, iid)}`, address: { kind, number: String(iid), ...(url ? { url } : {}) } })
/** The web page of an Issue or merge request on a self-hosted GitLab. */
export const gitlabPage = (base: string, project: string, iid: number, mr = false): string =>
  `${base}/${project}/-/${mr ? 'merge_requests' : 'issues'}/${iid}`
/** URL-encodes a `group/project` path for a GitLab API address. */
export const encodeProject = (project: string): string => project.split('/').map(encodeURIComponent).join('%2F')
/** Parses a web URL for an Issue or merge request; returns undefined for other URLs. */
export function gitlabAddress(url: string): { kind: 'issue' | 'mr'; iid: number } | undefined {
  const match = /\/-\/(issues|merge_requests)\/(\d+)$/.exec(url)
  if (!match) return undefined
  return { kind: match[1] === 'merge_requests' ? 'mr' : 'issue', iid: Number(match[2]) }
}
/** GitLab returns a deleted account as `null`; the API displays no name for it. */
export const UserSchema = z.looseObject({ username: z.string() }).nullable()
  .transform(user => user ?? { username: 'ghost' })
/**
 * A GitLab note on an Issue or merge request; system notes record status changes and carry no conversation.
 * GitLab's API carries no bot flag on note authors, so every author counts as human here; the prompts identify which accounts are automated.
 */
export const NoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), author: UserSchema.nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), system: z.boolean().nullish(),
})
export type GitlabNote = z.infer<typeof NoteSchema>
/** An Issue or merge request as `projects/:id/issues/:iid` or `projects/:id/merge_requests/:iid` returns it. */
export const DescriptionSchema = z.looseObject({
  iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string().nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), web_url: z.string().nullish(),
  author: UserSchema.nullish(), source_branch: z.string().nullish(),
})
export type GitlabDescription = z.infer<typeof DescriptionSchema>
/** A pending todo of the agent account; `target_type` names the kind of its `target`, which carries its `iid`. */
export const TodoSchema = z.looseObject({
  id: z.number(), target_type: z.string().nullish(), updated_at: z.string().nullish(),
  project: z.looseObject({ path_with_namespace: z.string().nullish() }).nullish(),
  target: z.looseObject({ iid: z.number().nullish() }).nullish(),
})
export type GitlabTodo = z.infer<typeof TodoSchema>
export type GitlabRef = { kind: 'issue' | 'mr'; iid: number; url?: string }
export const mentions = (text: string, username: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(username)}(?![a-zA-Z0-9_-])`, 'i').test(text)
const actor = (username: string | undefined) => ({ actor: { source: SOURCE, id: username ?? '' }, human: true })
/** Builds a trigger for a note; text is empty for an empty note. */
export function noteTrigger(note: GitlabNote, ref: GitlabRef, agent: string): Trigger {
  const at = note.updated_at ?? note.created_at ?? new Date().toISOString()
  const thread = gitlabThread(ref.kind, ref.iid)
  const id = key('gitlab-comment', ref.url ?? thread, String(note.id), note.updated_at ?? '')
  return { id, source: SOURCE, threads: [{ source: SOURCE, id: thread }], ...actor(note.author?.username), at,
    text: note.body ?? '',
    ...(mentions(note.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(ref.kind, ref.iid, ref.url),
    ...(ref.url ? { url: ref.url } : {}),
    meta: { kind: ref.kind, iid: ref.iid, noteId: note.id } }
}
/**
 * Builds the trigger for a newly opened Issue's or merge request's title and description.
 * The ID is the same as when descriptions were stored previously, so already-stored bodies are not ingested again.
 */
export function descriptionTrigger(item: GitlabDescription, kind: 'issue' | 'mr', agent: string): Trigger {
  const body = item.description ?? ''
  const thread = gitlabThread(kind, item.iid)
  const url = item.web_url ?? ''
  return { id: key(kind === 'issue' ? 'gitlab-issue' : 'gitlab-mr', String(item.iid)), source: SOURCE,
    threads: [{ source: SOURCE, id: thread }], ...actor(item.author?.username), at: item.created_at ?? new Date().toISOString(),
    text: `${item.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(kind, item.iid, url), ...(url ? { url } : {}), meta: { kind, iid: item.iid } }
}
