# Mapelix Agent Guide

Mapelix is a TypeScript monorepo. Use pnpm only.

- For production-rewrite scope, baseline gates, or progress, read `REWRITE.md` first.
- Put runnable applications in `apps/*` and reusable modules in `packages/*`.
- Run repository tasks from the root through Turborepo.
- Keep Bedrock format code independent from Node.js and image-output adapters.
- Preserve the small public interface described in `CONTEXT-MAP.md`.
- See `TURBO.md` before changing tasks or package boundaries.
