/** GitLab API helpers over the `glab` CLI: JSON calls and paginated lists, like `Commands.api` and `Commands.pages`. */
import { z } from 'zod'
import { validItems, type Tally, type Commands } from '../infra/commands.ts'

/**
 * Runs the agent's GitLab CLI: the resolved CLI path from the deployment with `GITLAB_HOST` set, so every call reaches
 * the GitLab the deployment resolved regardless of the working directory. Callers pass project addresses, which this
 * does not restrict.
 */
export async function glabRun(commands: Commands, args: string[]): Promise<string> {
  const gitlab = commands.deployment.gitlab
  return commands.run(gitlab?.cli ?? 'glab', args, undefined, gitlab ? { GITLAB_HOST: gitlab.host } : undefined)
}

/**
 * Runs the agent's `glab` and parses its JSON output. `glab` runs through the worker shim, which names its GitLab host,
 * so every call reaches the GitLab the deployment resolved; callers pass project addresses, which this does not restrict.
 */
export async function glabApi<T>(commands: Commands, schema: z.ZodType<T>, path: string): Promise<T> {
  return schema.parse(JSON.parse(await glabRun(commands, ['api', path])))
}
/** Fetches all pages of a GitLab API list through `glab`, skipping items that fail schema validation.
 *
 * `glab api --paginate` prints the pages back to back rather than wrapping them, and its api has no `--slurp`, so each
 * page is requested by number until one returns fewer than 100 items.
 */
export async function glabPages<T>(commands: Commands, item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
  const joiner = path.includes('?') ? '&' : '?'
  const items: unknown[] = []
  for (let page = 1; ; page++) {
    const body = z.array(z.unknown()).parse(JSON.parse(await glabRun(commands, ['api', `${path}${joiner}per_page=100&page=${page}`])))
    items.push(...body)
    if (body.length < 100) break
  }
  return validItems(item, items, tally)
}
