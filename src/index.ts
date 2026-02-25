import * as core from '@actions/core'
import * as github from '@actions/github'
import { SupabaseManagementAPI } from 'supabase-management-js'

const SUPABASE_API_BASE = 'https://api.supabase.com'
const READY_STATUS = 'ACTIVE_HEALTHY'
const FAILED_STATUSES = ['INIT_FAILED', 'REMOVED', 'GOING_DOWN']

// These endpoints are not exposed as SDK class methods, so we call them directly
interface ProjectDetails {
  id: string
  region: string
}

interface BranchListItem {
  id: string
  name: string
  project_ref: string
  parent_project_ref: string
  is_default: boolean
  git_branch?: string
  reset_on_push: boolean
  created_at: string
  updated_at: string
}

interface CreateBranchResponse extends BranchListItem {}

interface BranchReadyDetails {
  ref: string
  db_host: string
  db_port: number
  db_pass: string
  db_user: string
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function supabaseFetch<T>(
  method: string,
  path: string,
  accessToken: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(`${SUPABASE_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Supabase Management API ${response.status}: ${text}`)
  }

  return response.json() as Promise<T>
}

async function waitForBranch(
  client: SupabaseManagementAPI,
  branchId: string,
  timeoutMs: number,
  pollMs: number
): Promise<BranchReadyDetails> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const details = await client.getBranchDetails(branchId)

    if (!details) {
      throw new Error(`Branch ${branchId} not found`)
    }

    if (details.status === READY_STATUS) {
      return {
        ref: details.ref,
        db_host: details.db_host,
        db_port: details.db_port,
        db_pass: details.db_pass ?? '',
        db_user: details.db_user ?? 'postgres',
      }
    }

    if (FAILED_STATUSES.includes(details.status)) {
      throw new Error(`Branch entered a failed state: ${details.status}`)
    }

    core.info(`Branch status: ${details.status} — polling again in ${pollMs / 1000}s...`)
    await sleep(pollMs)
  }

  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for branch to become active`)
}

async function run(): Promise<void> {
  // 1. Read inputs
  const accessToken = core.getInput('supabase_access_token', { required: true })
  const parentRef = core.getInput('project_ref', { required: true })
  const timeoutSeconds = parseInt(core.getInput('timeout_seconds') || '300', 10)
  const pollIntervalSeconds = parseInt(core.getInput('poll_interval_seconds') || '10', 10)
  const timeoutMs = timeoutSeconds * 1000
  const pollMs = pollIntervalSeconds * 1000

  // 2. Resolve git branch name: explicit input → GitHub Actions context → error
  let gitBranchName = core.getInput('git_branch_name')
  if (!gitBranchName) {
    const ref = github.context.ref
    if (ref.startsWith('refs/heads/')) {
      gitBranchName = ref.replace('refs/heads/', '')
    } else if (ref.startsWith('refs/pull/')) {
      const prHead = github.context.payload.pull_request?.head?.ref
      if (typeof prHead === 'string') {
        gitBranchName = prHead
      }
    }
  }
  if (!gitBranchName) {
    throw new Error(
      'Could not determine git branch name. ' +
        'Provide the `git_branch_name` input or run this action on a branch/PR event.'
    )
  }

  const branchName = core.getInput('branch_name') || gitBranchName

  core.info(`Parent project ref: ${parentRef}`)
  core.info(`Git branch: ${gitBranchName}`)
  core.info(`Supabase branch name: ${branchName}`)

  // 3. Initialize Supabase Management API client
  const client = new SupabaseManagementAPI({ accessToken })

  // 4. Check for existing branch (idempotency)
  core.info('Listing existing Supabase branches...')
  const branches = await supabaseFetch<BranchListItem[]>(
    'GET',
    `/v1/projects/${parentRef}/branches`,
    accessToken
  )

  // Skip the default branch — it's the main project, not a preview
  const existing = branches.find(
    b => !b.is_default && (b.git_branch === gitBranchName || b.name === branchName)
  )

  let branchId: string
  let branchProjectRef: string
  let dbHost: string
  let dbPort: number
  let dbPass: string
  let dbUser: string

  if (existing) {
    core.info(`Found existing preview branch: ${existing.id}`)
    branchId = existing.id
    branchProjectRef = existing.project_ref
    core.info('Waiting for branch to become active...')
    const ready = await waitForBranch(client, branchId, timeoutMs, pollMs)
    branchProjectRef = ready.ref
    dbHost = ready.db_host
    dbPort = ready.db_port
    dbPass = ready.db_pass
    dbUser = ready.db_user
  } else {
    // 5. Create new preview branch
    core.info(`Creating Supabase preview branch: ${branchName}`)
    const created = await supabaseFetch<CreateBranchResponse>(
      'POST',
      `/v1/projects/${parentRef}/branches`,
      accessToken,
      { branch_name: branchName, git_branch: gitBranchName }
    )
    branchId = created.id
    branchProjectRef = created.project_ref

    core.info(`Branch created (id: ${branchId}) — waiting for it to become active...`)
    const ready = await waitForBranch(client, branchId, timeoutMs, pollMs)
    branchProjectRef = ready.ref
    dbHost = ready.db_host
    dbPort = ready.db_port
    dbPass = ready.db_pass
    dbUser = ready.db_user
  }

  core.info(`Preview branch is active. Project ref: ${branchProjectRef}`)

  // 6. Fetch API keys for the preview branch
  const apiKeys = await client.getProjectApiKeys(branchProjectRef)

  const anonKey = apiKeys?.find(k => k.name === 'anon')?.api_key ?? ''
  const serviceRoleKey = apiKeys?.find(k => k.name === 'service_role')?.api_key ?? ''

  if (!anonKey) core.warning('anon key not found in API keys response')
  if (!serviceRoleKey) core.warning('service_role key not found in API keys response')

  // 7. Fetch parent project region to build the pooler (IPv4) connection string.
  // Preview branches are sub-projects and return 404 on GET /v1/projects/{ref};
  // the parent project is always in the same region as its branches.
  const parentProject = await supabaseFetch<ProjectDetails>(
    'GET',
    `/v1/projects/${parentRef}`,
    accessToken
  )
  const poolerHost = `aws-1-${parentProject.region}.pooler.supabase.com`
  const poolerPort = '5432' // session mode — supports full SQL (migrations, psql, advisory locks)
  const poolerUser = `postgres.${branchProjectRef}`

  // 8. Construct remaining outputs
  const supabaseUrl = `https://${branchProjectRef}.supabase.co`
  const dbPortStr = String(dbPort || 5432)
  const dbName = 'postgres'
  const dbConnectionString = `postgresql://${poolerUser}:${dbPass}@${poolerHost}:${poolerPort}/${dbName}`

  // 9. Mask secrets BEFORE any logging or output
  if (anonKey) core.setSecret(anonKey)
  if (serviceRoleKey) core.setSecret(serviceRoleKey)
  if (dbPass) core.setSecret(dbPass)

  // 10. Set GitHub Actions outputs
  core.setOutput('project_ref', branchProjectRef)
  core.setOutput('supabase_url', supabaseUrl)
  core.setOutput('anon_key', anonKey)
  core.setOutput('service_role_key', serviceRoleKey)
  core.setOutput('db_host', dbHost)
  core.setOutput('db_port', dbPortStr)
  core.setOutput('db_name', dbName)
  core.setOutput('db_user', dbUser)
  core.setOutput('db_password', dbPass)
  core.setOutput('db_pooler_host', poolerHost)
  core.setOutput('db_pooler_port', poolerPort)
  core.setOutput('db_connection_string', dbConnectionString)

  // 11. Export non-sensitive env vars for convenient use in subsequent steps.
  // Sensitive credentials (SUPABASE_SERVICE_ROLE_KEY, PGPASSWORD) are intentionally
  // NOT exported globally — pass them via step-level `env:` from the action outputs.
  core.exportVariable('SUPABASE_URL', supabaseUrl)
  core.exportVariable('SUPABASE_ANON_KEY', anonKey)
  core.exportVariable('PGUSER', poolerUser)
  core.exportVariable('PGHOST', poolerHost)
  core.exportVariable('PGPORT', poolerPort)

  core.info(`Supabase preview branch ready: ${supabaseUrl}`)
  core.info(`Pooler host (IPv4): ${poolerHost}`)
}

run().catch(error => {
  core.setFailed(error instanceof Error ? error.message : String(error))
})
