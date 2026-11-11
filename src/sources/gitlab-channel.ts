/** GitLab outbound channel: posts notes on Issues and merge requests under the agent account. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { glabPages } from './gitlab-api.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { encodeProject, gitlabPage } from './gitlab-trigger.ts'

const NoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), author: z.looseObject({ username: z.string() }).nullish(),
})
/** True when an Issue or merge request permanently refuses replies (deleted, 404; locked, 403). */
const gone = (error: unknown): boolean => error instanceof CliError
  && (error.code === 410 || (error.code === 403 && /locked/i.test(error.message)))
/** Posts a note with an embedded HTML marker so retries do not create duplicate notes. */
export async function sendGlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const gitlab = commands.deployment.gitlab
  if (!gitlab) throw new Error('The GitLab Source has no working CLI')
  const kind = message.channel.address.kind === 'mr' ? 'merge_requests' : 'issues'
  const iid = Number(message.channel.address.number)
  if (!iid) throw new Error('Missing GitLab reply target')
  const path = `projects/${encodeProject(gitlab.project)}/${kind}/${iid}/notes`
  const marker = `<!-- dsh-superagent:${message.id} -->`
  const mine = (note: z.infer<typeof NoteSchema>) => note.author?.username === gitlab.login && (note.body ?? '').includes(marker)
  // A long conversation returns more notes than one page holds; read every page before deciding a note was not sent.
  if ((await glabPages(commands, NoteSchema, path)).some(mine)) return 'sent'
  await commands.run('glab', ['api', path, '--method', 'POST', '-f', `body=${message.text}\n\n${marker}`])
  return 'sent'
}
export function gitlabLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const gitlab = links.gitlab
  const number = address.number ?? ''
  const mr = address.kind === 'mr'
  const label = mr ? { zh: `GitLab !${number}`, en: `GitLab !${number}` } : { zh: `GitLab #${number}`, en: `GitLab #${number}` }
  return { url: address.url ?? (gitlab ? gitlabPage(gitlab.host, gitlab.project, Number(number), mr) : ''), label }
}
