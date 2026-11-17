# CLAUDE.md

voidlink: the shared short-link engine (Cloudflare Worker + CLI) behind
txv.sh and rvnflt.com. See README.md for the model.

## Rules that matter

- **Public repo, no content.** No links, hosts of real deployments in code
  paths, account ids or secrets. Those live in each site's repo and in the
  private links repos. Test fixtures use `*.example`.
- **CI holds no Cloudflare credential for links.** `voidlink apply` sends
  links to the Worker with a GitHub OIDC token (`src/oidc.ts`); the Worker
  writes them, and creates every table, through its own D1 binding
  (`src/store.ts`, `src/clicks.ts`). A REST D1 grant is account-wide, so
  nothing here may need one. New schema: append a step to `SCHEMA`,
  idempotent, never edit a shipped one.
- **The apply path is the attack surface.** `src/oidc.ts` and
  `src/apply.ts` decide who may rewrite a site's links. Any change there
  comes with a test for the case it could let through.
- **No runtime dependencies.** Sites that serve install scripts bundle this.
- **Never log or echo destinations** from `voidlink apply` or the Worker's
  apply path (responses included): counts and versions only.
- **Analytics stay anonymous** (no IP, no user-agent, no person profile). A
  new event property goes in README's Analytics section too.
- Style: voidflow's biome config. Pure logic in `src/`, a test in `test/`.
  `bun run test:push` before pushing. Conventional commits.
