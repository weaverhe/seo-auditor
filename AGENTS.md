# AGENTS.md

Project-specific conventions for AI coding agents.

## Package Manager

- Always use **pnpm** — never npm or yarn.
  - Install deps: `pnpm install`
  - Add a package: `pnpm add <pkg>`
  - Run scripts: `pnpm run <script>` or `pnpm crawl` / `pnpm report`

## Best Practices

- Always run `pnpm lint`, `pnpm format` and `pnpm test` before committing code, or when you consider it "done". This ensures code quality and consistency across the project.