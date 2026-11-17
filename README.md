# voidlink

Short links on Cloudflare Workers, kept as reviewed config.

- Links live in a typed `redirects.ts` in a private links repo. You change
  them with a PR, CI shows the plan, and merging applies them.
- Applying sends each site its links over HTTPS, signed by a GitHub Actions
  OIDC token. The site's Worker checks the token and stores the links through
  its own D1 binding. The links repo holds no Cloudflare credential, and sites
  only redeploy when their code changes.
- Browsers that open `/` see the links you mark `public`. The rest still
  redirect but aren't listed.
- Each human click adds one to a count in D1 and, if you set it up, sends one
  anonymous PostHog event.

voidlink holds the code only. Your links, account IDs and secrets stay in
your own repos.

## How it fits together

| Where                        | What                                                               | Example          |
| ---------------------------- | ------------------------------------------------------------------ | ---------------- |
| voidlink (this repo, on npm) | Worker engine and the `voidlink` CLI                               |                  |
| The site's repo              | `voidlink.config.ts`, `wrangler.jsonc`, `src/index.ts`, the deploy | taraxvoid/txv.sh |
| A private links repo         | `redirects.ts`, with links for every site in one account or owner  | taraxvoid/links  |

```
links PR    -> voidlink plan --remote   (diff and checks, in the job summary)
links merge -> voidlink apply           -> PUT https://<host>/_voidlink/links
                                           Authorization: Bearer <GitHub OIDC token>
                                           Worker checks the token, validates, stores in D1
nightly     -> voidlink check           (HEAD every link, exit 1 on drift)
```

## Links: `redirects.ts`

This file goes in your links repo, keyed by site host and then by slug:

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
- **Each apply replaces a site's whole set.** Removing a host from the file
  leaves that site's last set in place: apply an empty set for it first.

## A site: `voidlink.config.ts` and the Worker

The config is plain data, like voidflow's `voidflow.config.ts`:

```ts
// voidlink.config.ts
import type { Site } from '@taraxvoid/voidlink'

export default {
    host: 'txv.sh',
    homeUrl: 'https://example.com/',
    title: 'txv.sh',
    description: 'Short links',
    utmHosts: ['example.com'], // our own sites get utm_ tags
    reserved: ['verify'], // paths the site serves itself
    analytics: { event: 'txv_link_clicked' },
    apply: {
        // The links repo by numeric id, so a renamed or recreated repo with
        // the same name doesn't match: gh api repos/<owner>/<name> --jq .id
        repositoryId: 123456789,
        workflow: '.github/workflows/redirects.yml',
        environment: 'links',
    },
} satisfies Site
```

```ts
// src/index.ts
import { createWorker } from '@taraxvoid/voidlink'
import site from '../voidlink.config'

export default createWorker({ site })
```

- voidlink ships TypeScript source, and it uses the Workers types. Your
  `tsconfig` (and any second one, such as `scripts/`) needs
  `@cloudflare/workers-types` in `types`.
- Bind a D1 database as `DB`. Links and click counts both live there; without
  it the site serves no links.
- `apply` says who may send this site its links. Without it, the site takes
  none. The repository id goes in a public repo: it names the links repo but
  grants nothing.
- Pass `routes` to serve your own paths first. If it returns `undefined`,
  voidlink handles the request. `reserved` stops links from using those
  paths.
- `site.aliases` lists other hosts the same Worker serves, such as
  `dev.example.com`.
- `index: 'home'` makes `/` redirect browsers to `homeUrl` instead of
  showing the list.
- `defineSite()` still works for now, but is deprecated: use
  `satisfies Site`.

### Routes

| Path                   | What                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/`                    | Browsers get the public links as a page. `curl` gets them as `#` comments, so `curl ... \| sh` does nothing |
| `/<slug>`              | 302 to the link, with utm tags added where they apply                                                       |
| `/_health`             | `{ "ok": true }` when D1 answers, or when there is no D1                                                    |
| `PUT /_voidlink/links` | Where `voidlink apply` sends the site's links (see below)                                                   |
| `GET /_voidlink/site`  | `{ host, reserved }`, for `voidlink plan --remote`. No links                                                |
| anything else          | 404: a page for browsers, a body that fails if piped to `sh` for everything else                            |

### How links arrive

`PUT /_voidlink/links` takes `{ version, sha, links }` and a GitHub Actions
OIDC token as `Authorization: Bearer`. The Worker checks, in order:

1. The token is signed by GitHub (RS256, a key from GitHub's JWKS, cached
   for an hour), and is not expired (60 s of leeway).
2. Its claims: issuer `https://token.actions.githubusercontent.com`,
   audience `voidlink:<host>`, `repository_id` from `apply.repositoryId`,
   ref `refs/heads/main`, the `apply.environment` environment, the
   `apply.workflow` file on main, and a `push` or `workflow_dispatch` event.
3. The links pass the same checks as `voidlink plan`, including the site's
   `reserved` paths. Otherwise 422 with every problem.
4. `version` (the links repo's commit time) is newer than the stored one, so
   an old workflow run can't roll links back. The same version and sha again
   is a no-op; the same version with another sha is a 409.

Bodies are capped at 256 KiB. Responses and logs carry counts and versions,
never destinations. Each isolate caches the links for 30 s, so a change is
live everywhere within about 30 s. If D1 fails, the Worker keeps serving the
last set it read; an isolate that never read one answers 503 for slugs.

### Where credentials live

| Step                                 | Credential                                                         | Held by                     |
| ------------------------------------ | ------------------------------------------------------------------ | --------------------------- |
| Deploy the site's Worker             | A deploy token scoped to that Worker                               | The site repo's environment |
| Create the D1 database, once         | Your own wrangler login                                            | Your machine                |
| `voidlink apply` sends the links     | A GitHub OIDC token: short-lived, minted for the job, never stored | The links repo's job        |
| The Worker writes the links to D1    | The Worker's D1 binding; no API token at run time                  | The Worker                  |
| `voidlink check` reads the live site | None                                                               | Anyone                      |

Anyone who can get GitHub to sign a token with those claims can rewrite the
site's links. In practice that is whoever can land a commit on the links
repo's `main` or change its `links` environment, so protect both: a ruleset
on `main`, and an environment that only `main` can deploy to.

If the site's zone runs Bot Fight Mode or WAF rules that challenge GitHub's
runners, `apply` gets a challenge page instead of the Worker. Check before the
first apply, and add a WAF skip for `PUT /_voidlink/links` if needed.

### Click counts (D1)

The Worker creates its own tables (`voidlink_clicks`, `voidlink_meta`,
`voidlink_links`) through its binding the first time it needs them.

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

### The site

The site deploys like any other Worker: voidflow's `cloudflare-deploy` with a
token scoped to that Worker. There's no links step, no `migrate-d1` step, and
in voidflow's token config the site's env doesn't need `d1: true`. Link
changes don't redeploy it.

### The links repo: plan, apply, check

```yaml
on:
    pull_request:
    push:
        branches: [main]
    schedule:
        - cron: "17 5 * * *"
permissions:
    contents: read
jobs:
    plan:
        if: github.event_name == 'pull_request'
        steps:
            - uses: actions/checkout@<sha>
              with: { fetch-depth: 0, persist-credentials: false }
            - run: git show "origin/${BASE_REF}:redirects.ts" > "$RUNNER_TEMP/base.ts" || echo 'export default {}' > "$RUNNER_TEMP/base.ts"
              env: { BASE_REF: "${{ github.base_ref }}" }
            - run: bunx @taraxvoid/voidlink@<version> plan --redirects redirects.ts --base "$RUNNER_TEMP/base.ts" --remote --summary
    apply:
        if: github.event_name == 'push'
        environment: links # deployment branch policy: main only
        permissions:
            contents: read
            id-token: write
        steps:
            - uses: actions/checkout@<sha>
              with: { persist-credentials: false }
            - run: bunx @taraxvoid/voidlink@<version> apply --redirects redirects.ts
    check:
        if: github.event_name == 'schedule'
        steps:
            - uses: actions/checkout@<sha>
              with: { persist-credentials: false }
            - run: bunx @taraxvoid/voidlink@<version> check --redirects redirects.ts --host txv.sh
```

No GitHub App and no Cloudflare secret. Use one links repo per account or
owner, so links for different organizations never share a repo.

## CLI

```sh
voidlink plan  --redirects <file> [--base <file>] [--remote] [--summary]
voidlink apply --redirects <file> [--host <host>] [--origin <url>]
voidlink check --redirects <file> --host <host> [--origin <url>]
voidlink ls    --redirects <file> [--host <host>]
```

| Command | What it does                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan`  | Checks every site in the file and prints what changed against `--base`, as Markdown. `--remote` also checks slugs against each live site's reserved paths. `--summary` adds it to the job summary |
| `apply` | In GitHub Actions, sends each site (or just `--host`) its whole link set, with version and sha from the checkout's `HEAD`. Prints counts, never destinations. Exits 1 if any site refused         |
| `check` | Sends a `HEAD` to every link on the live site, as a bot so nothing is counted, and exits 1 if any redirect doesn't match the file                                                                 |
| `ls`    | Prints the file's links                                                                                                                                                                           |

Exit codes: 0 for success, 1 when `check` finds drift or `apply` was refused,
2 for a bad file or bad arguments.

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
