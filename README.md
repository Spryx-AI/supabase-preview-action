# supabase-preview-action

GitHub Action that creates a [Supabase preview branch](https://supabase.com/docs/guides/platform/branching) for a pull request and exposes its credentials as reusable outputs.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `supabase_access_token` | ✅ | — | Supabase Management API access token |
| `project_ref` | ✅ | — | Parent Supabase project reference ID |
| `git_branch_name` | | current git ref | Git branch name used to identify the preview branch |
| `branch_name` | | `git_branch_name` | Supabase branch name (defaults to `git_branch_name`) |
| `timeout_seconds` | | `300` | Max seconds to wait for branch migrations to complete |
| `poll_interval_seconds` | | `10` | Polling interval in seconds while waiting for branch |

## Outputs

| Output | Description |
|--------|-------------|
| `project_ref` | Supabase project ref of the preview branch |
| `supabase_url` | Supabase API URL (`https://<ref>.supabase.co`) |
| `anon_key` | Anonymous API key (masked in logs) |
| `service_role_key` | Service role key (masked in logs) |
| `db_host` | PostgreSQL host |
| `db_port` | PostgreSQL port |
| `db_name` | PostgreSQL database name |

The action also sets `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` as environment variables available to all subsequent steps in the job.

## Usage

### Basic — create preview branch on pull requests

```yaml
on:
  pull_request:

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: Spryx-AI/supabase-preview-action@v1
        id: preview
        with:
          supabase_access_token: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
          project_ref: ${{ vars.SUPABASE_PROJECT_REF }}

      - name: Print preview URL
        run: echo "Preview branch URL: ${{ steps.preview.outputs.supabase_url }}"
```

> The `git_branch_name` input is optional — the action reads it from `github.ref` automatically when running on a `pull_request` or `push` event.

### Run integration tests against the preview branch

```yaml
- uses: Spryx-AI/supabase-preview-action@v1
  id: preview
  with:
    supabase_access_token: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
    project_ref: ${{ vars.SUPABASE_PROJECT_REF }}

- name: Run integration tests
  env:
    SUPABASE_URL: ${{ steps.preview.outputs.supabase_url }}
    SUPABASE_SERVICE_ROLE_KEY: ${{ steps.preview.outputs.service_role_key }}
  run: npm run test:integration
```

### Update Railway environment variables

```yaml
- uses: Spryx-AI/supabase-preview-action@v1
  id: preview
  with:
    supabase_access_token: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
    project_ref: ${{ vars.SUPABASE_PROJECT_REF }}

- name: Update Railway env vars
  env:
    RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}
  run: |
    railway variables set SUPABASE_URL=${{ steps.preview.outputs.supabase_url }}
    railway variables set SUPABASE_ANON_KEY=${{ steps.preview.outputs.anon_key }}
    railway variables set SUPABASE_SERVICE_ROLE_KEY=${{ steps.preview.outputs.service_role_key }}
```

### Use env vars set automatically by the action

After the action runs, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are available as environment variables in all subsequent steps without needing `steps.preview.outputs.*`:

```yaml
- uses: Spryx-AI/supabase-preview-action@v1
  with:
    supabase_access_token: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
    project_ref: ${{ vars.SUPABASE_PROJECT_REF }}

- name: Run tests
  # SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY are already set
  run: npm run test:integration
```

### Custom branch name and timeout

```yaml
- uses: Spryx-AI/supabase-preview-action@v1
  id: preview
  with:
    supabase_access_token: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
    project_ref: ${{ vars.SUPABASE_PROJECT_REF }}
    git_branch_name: ${{ github.head_ref }}
    branch_name: preview-${{ github.event.number }}
    timeout_seconds: 600
    poll_interval_seconds: 15
```

## Setup

1. **Enable Supabase branching** for your project in the [Supabase dashboard](https://supabase.com/dashboard).

2. **Create a Supabase access token** at [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens).

3. **Add the token as a secret** in your GitHub repository:
   - Go to **Settings → Secrets and variables → Actions**
   - Add `SUPABASE_ACCESS_TOKEN`

4. **Add your project ref as a variable**:
   - Go to **Settings → Secrets and variables → Actions → Variables**
   - Add `SUPABASE_PROJECT_REF` (found in your Supabase project settings URL)

## Idempotency

The action is idempotent — if a Supabase preview branch already exists for the given git branch, it reuses it instead of creating a new one. This means you can safely run the action multiple times on the same branch (e.g., on every push to a PR).

## Security

- `anon_key` and `service_role_key` are registered with `core.setSecret()` and will appear as `***` in workflow logs.
- Never print outputs containing these values in `run:` steps without masking them first.
