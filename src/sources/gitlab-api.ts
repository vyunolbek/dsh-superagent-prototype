/** GitLab API helpers over the `glab` CLI: JSON calls and paginated lists, like `Commands.api` and `Commands.pages`. */
import { z } from 'zod'
import { validItems, type Tally, type Commands } from '../infra/commands.ts'

/**
 * Runs the agent's `glab` and parses its JSON output. `glab` runs through the worker shim, which names its GitLab host,
 * so every call reaches the GitLab the deployment resolved; callers pass project addresses, which this does not restrict.
 */
export async function glabApi<T>(commands: Commands, schema: z.ZodType<T>, path: string): Promise<T> {
  return schema.parse(JSON.parse(await commands.run('glab', ['api', path])))
}
/** Fetches all pages of a GitLab API list through `glab`, skipping items that fail schema validation. */
export async function glabPages<T>(commands: Commands, item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
  const pages = z.array(z.array(z.unknown())).parse(JSON.parse(await commands.run('glab', ['api', path, '--paginate', '--slurp'])))
  return validItems(item, pages.flat(), tally)
}
