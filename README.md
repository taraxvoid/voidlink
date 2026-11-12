# voidlink

Short links on Cloudflare Workers, kept as reviewed config.

- Links live in a typed `redirects.ts` in a private repo. You change them with
  a PR, CI shows the plan, and merging redeploys the site.
- The site's Worker bundles its links at build time. Nothing writes links to a
  database, so the deploy token only needs access to one Worker.
- Browsers that open `/` see the links you mark `public`. The rest still
  redirect but aren't listed.
- Each human click adds one to a count in D1 and, if you set it up, sends one
  anonymous PostHog event.

voidlink holds the code only. Your links, account IDs and secrets stay in
your own repos.

## How it fits together

| Where | What | Example |
| --- | --- | --- |
| voidlink (this repo, on npm) | Worker engine, the `voidlink` CLI, the `build-links` action | |
| The site's repo | `voidlink.config.ts`, `wrangler.jsonc`, `src/index.ts`, the deploy | taraxvoid/txv.sh |
| A private infra repo | `redirects.ts`, with links for every site you run | taraxvoid/infra |

```
infra PR ──▶ voidlink plan (job summary)
   │ merge
   ▼
infra push ──▶ workflow_dispatch the site's deploy
                  │ build-links: read redirects.ts (read-only App token)
                  │ voidlink build ──▶ links.gen.json
                  ▼
               wrangler deploy (token scoped to that one Worker)
```

## Links: `redirects.ts`

This file goes in your infra repo, keyed by site host and then by slug:

```ts
import type { Redirects } from '@taraxvoid/voidlink'

export default {
    'txv.sh': {
        cv: { to: 'https://example.com/cv', public: true, title: 'CV' },
        gh: 'https://github.com/example', // unlisted
    },
    'short.example': {
        talk: 'https://slides.example/talk',
    },
} satisfies Redirects
```

- **Slugs** are lowercase letters, digits and hyphens, up to 64 characters,
  and must start with a letter or digit. `/CV/` finds `cv`.
- **Destinations** must use https and can't point back at the site.
- **`public: true`** lists the link on the index page. `title` is what the
  page shows (default: the slug).
- **Unlisted is not the same as secret.** An unlisted link still works for
  anyone who has the URL, and the redirects file has every link in it. Keep
  the file somewhere private.
- **Keep the import type-only.** CI loads the file without installing
  anything.

## A site: `voidlink.config.ts` and the Worker

```ts
// voidlink.config.ts
import { defineSite } from '@taraxvoid/voidlink'

export default defineSite({
    host: 'txv.sh',
    homeUrl: 'https://example.com/',
    title: 'txv.sh',
    description: 'Short links',
    utmHosts: ['example.com'], // our own sites get utm_ tags
    reserved: ['verify'], // paths the site serves itself
    analytics: { event: 'txv_link_clicked' },
})
```

```ts
// src/index.ts
import { createWorker } from '@taraxvoid/voidlink'
import links from '../links.gen.json'
import site from '../voidlink.config'

export default createWorker({ site, links })
```

- `links.gen.json` is generated. Gitignore it, and run
  `voidlink build --empty --site voidlink.config.ts --out links.gen.json`
  for local dev and tests.
- Pass `routes` to serve your own paths first. If it returns `undefined`,
  voidlink handles the request. `reserved` stops links from using those
  paths.
- `site.aliases` lists other hosts the same Worker serves, such as
  `dev.example.com`.
- `index: 'home'` makes `/` redirect browsers to `homeUrl` instead of
  showing the list.

### Routes

| Path | What |
| --- | --- |
| `/` | Browsers get the public links as a page. `curl` gets them as `#` comments, so `curl … \| sh` does nothing |
| `/<slug>` | 302 to the link, with utm tags added where they apply |
| `/_health` | `{ "ok": true }` when D1 answers, or when there is no D1 |
| anything else | 404: a page for browsers, a body that fails if piped to `sh` for everything else |

### Click counts (D1)

Bind a D1 database as `DB`. The Worker creates its own tables
(`voidlink_clicks`, `voidlink_meta`) through that binding the first time it
counts a click.

There are no migrations for CI to run. Running them would need a token with
D1 Write over Cloudflare's REST API, which applies to every database in the
account. The binding needs nothing beyond the deploy token for that one
Worker.

If the database already has a `links` table with `click_count` (txv.sh and
rvnflt.com had one before voidlink), its counts are copied in once.

To read the counts with your own login:

```sh
bunx wrangler d1 execute <db> --remote --command \
  "SELECT * FROM voidlink_clicks ORDER BY click_count DESC"
```

### Analytics

Only human clicks count. Crawlers, link previews, HTTP clients and `HEAD`
requests are redirected but not counted. With `site.analytics` set and a
`POSTHOG_KEY` Worker secret, each click sends one PostHog event with:

- `source` (the site's host);
- `slug`;
- `destination`, without its query;
- `referrer_host`;
- `country`, from Cloudflare;
- utm tags.

There's no person profile and no GeoIP, no IP address or user-agent is sent,
and every event has a new random id. `POSTHOG_HOST` defaults to
`https://us.i.posthog.com`.

Destinations on `utmHosts` get
`utm_source=<host>&utm_medium=shortlink&utm_campaign=<slug>`. utm params on
the short link win over those and are passed to any destination.

## CI

### The site: build links, then deploy

`actions/build-links` checks out the redirects file with a GitHub App token
that can only read that one repo, then runs `voidlink build`. It logs counts,
never destinations, and deletes the checkout afterwards.

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch: # run by the infra repo after a links change
jobs:
  deploy:
    environment: prod
    steps:
      - uses: actions/checkout@<sha>
        with: { persist-credentials: false }
      - run: bun install --frozen-lockfile
      - uses: taraxvoid/voidlink/actions/build-links@<sha> # vX.Y.Z
        with:
          redirects-repo: example/infra
          app-client-id: ${{ vars.LINKS_BOT_CLIENT_ID }}
          app-private-key: ${{ secrets.LINKS_BOT_PRIVATE_KEY }}
      - uses: taraxvoid/voidflow/actions/cloudflare-deploy@<sha> # vX.Y.Z
        with:
          env: prod
          cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

There's no `migrate-d1` step. In voidflow's `cf-tokens`, the site's env
doesn't need `d1: true`.

### The infra repo: plan on PRs, redeploy on merge

```yaml
# in the infra repo
- run: git show "origin/${BASE_REF}:redirects.ts" > "$RUNNER_TEMP/base.ts" || echo 'export default {}' > "$RUNNER_TEMP/base.ts"
- run: bunx @taraxvoid/voidlink@<version> plan --redirects redirects.ts --base "$RUNNER_TEMP/base.ts" --summary
```

After a merge, infra starts each site's deploy with `workflow_dispatch`. The
App token for that has only Actions write on the site's repo, and no access
to its contents. `repository_dispatch` would need Contents write, which is
much broader. Check a live site against the
file with:

```sh
voidlink check --redirects redirects.ts --host txv.sh
```

## CLI

```sh
voidlink build --redirects <file> --site <voidlink.config.ts> --out <file>
voidlink build --empty --site <voidlink.config.ts> --out <file>
voidlink plan  --redirects <file> [--base <file>] [--summary]
voidlink check --redirects <file> --host <host> [--origin <url>]
voidlink ls    --redirects <file> [--host <host>]
```

| Command | What it does |
| --- | --- |
| `build` | Checks one site's links (including its `reserved` slugs) and writes them out |
| `plan` | Checks every site in the file and prints what changed against `--base`, as Markdown. `--summary` also adds it to the GitHub job summary |
| `check` | Sends a `HEAD` to every link on the live site, as a bot so nothing is counted, and exits 1 if any redirect doesn't match the file |
| `ls` | Prints the file's links |

Exit codes: 0 for success, 1 when `check` finds drift, 2 for a bad file or
bad arguments.

## Develop

```sh
mise install && bun install
bun run test:push   # biome, tsc, bun test
```

CI is voidflow's `tool-ci.yml`. Releases use voidflow's `tool-release.yml`:
release-please on `main`, then the npm tarball is attested and staged, and
waits for 2FA approval before it goes live.

## License

MIT
