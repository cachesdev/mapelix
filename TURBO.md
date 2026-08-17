# Turborepo Guide

The root scripts only delegate work with `turbo run`. Each workspace owns the command that performs its task.

- Use `^build` when a task needs built dependency output.
- Declare generated package files such as `dist/**` as task outputs.
- Keep formatting uncached because it changes source files.
- Run `pnpm quality` for the normal repository check.
- Run `pnpm test:visual` for the committed renderer oracle suite. Set `MAPELIX_VISUAL_WORLD` to render and evaluate a new implementation from a Bedrock world.
- Run `pnpm turbo run build --filter @mapelix/prototype` to work on one package.

The `transit` task is a dependency graph node. It lets validation tasks follow package dependencies without forcing an unrelated build.
