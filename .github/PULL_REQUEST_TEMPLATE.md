## Summary

<!-- One or two sentences: what does this PR do? -->

## What & why

<!-- The change and the motivation behind it. Link any related issue (e.g. Closes #123). -->

## Testing

<!-- How did you verify this? Commands run and their results. -->

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`

## Checklist

- [ ] Tests pass locally (lint + typecheck + test + build all green)
- [ ] No secrets committed — only `.env.example` is tracked; no keys, tokens, or `.env` contents in the diff
- [ ] Docs updated where behavior or config changed
- [ ] Commits follow Conventional Commits
- [ ] Config defaults remain forker-safe (conservative spend ceiling, rate limits on)
