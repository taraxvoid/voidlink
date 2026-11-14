# CLAUDE.md

voidlink: the shared short-link engine (Cloudflare Worker + CLI) behind
txv.sh and rvnflt.com. See README.md for the model.

## Rules that matter

- **Public repo, no content.** No links, hosts of real deployments in code
  paths, account ids or secrets. Those live in each site's repo and in the
  private links repos. Test fixtures use `*.example`.
- **CI never writes D1.** Links are bundled at build time; click tables are
  created by the Worker through its binding (`src/clicks.ts`). A REST D1
  grant is account-wide, so nothing here may need one. New schema: append a
  step to `SCHEMA`, idempotent, never edit a shipped one.
- **No runtime dependencies.** Sites that serve install scripts bundle this.
- **Never log destinations** from the CLI's build path: it runs in public
  sites' CI.
- **Analytics stay anonymous** (no IP, no user-agent, no person profile). A
  new event property goes in README's Analytics section too.
- Style: voidflow's biome config. Pure logic in `src/`, a test in `test/`.
  `bun run test:push` before pushing. Conventional commits.
