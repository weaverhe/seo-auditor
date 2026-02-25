# SEO Auditor

A general-purpose Node.js SEO crawler and audit tool. Crawls a website, stores results in SQLite, and exports CSV reports.

## Requirements

- Node.js 18+
- pnpm

## Installation

```bash
pnpm install
```

## Configuration

Copy `.env.example` to `.env` and adjust as needed:

```bash
cp .env.example .env
```

| Variable              | Default             | Description                          |
| --------------------- | ------------------- | ------------------------------------ |
| `CONCURRENCY`         | `3`                 | Parallel page fetches                |
| `REQUEST_TIMEOUT_MS`  | `15000`             | Per-request timeout in ms            |
| `USER_AGENT`          | `SEO-Audit-Bot/1.0` | User-agent string sent with requests |
| `RESPECT_CRAWL_DELAY` | `true`              | Honor crawl-delay from robots.txt    |

## Usage

```bash
# Start a new crawl
pnpm crawl -- --site https://example.com --label "baseline"

# Resume an interrupted crawl
pnpm crawl -- --site https://example.com --resume

# Generate reports for the latest crawl
pnpm report -- --site https://example.com

# List all crawl sessions for a site
pnpm report -- --site https://example.com --list-sessions

# Generate reports for a specific session
pnpm report -- --site https://example.com --session 2

# Compare two sessions
pnpm report -- --site https://example.com --compare 1 2
```

## Output

Results are stored per-site under `audits/`:

```txt
audits/
  example.com/
    crawl.db              # SQLite database (all sessions)
    reports/
      session-1/
        all-pages.csv
        issues-summary.csv
        broken-links.csv
        redirects.csv
        images.csv
```
