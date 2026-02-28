import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as core from '@actions/core'
import * as github from '@actions/github'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Resolves a path to the supabase CLI binary.
// Uses the system binary if available; otherwise downloads the latest release.
async function resolveSupabaseCLI(): Promise<string> {
  try {
    execFileSync('supabase', ['--version'], { stdio: 'pipe' })
    return 'supabase'
  } catch {
    // not in PATH — download it
  }

  core.info('Supabase CLI not found in PATH — downloading latest release...')

  const platform = os.platform()
  const arch = os.arch()

  const platformMap: Record<string, string> = {
    linux: 'linux',
    darwin: 'darwin',
    win32: 'windows',
  }
  const archMap: Record<string, string> = {
    x64: 'amd64',
    arm64: 'arm64',
  }

  const osPlatform = platformMap[platform]
  const osArch = archMap[arch]

  if (!osPlatform || !osArch) {
    throw new Error(`Unsupported platform for auto-download: ${platform}/${arch}`)
  }

  const releaseRes = await fetch('https://api.github.com/repos/supabase/cli/releases/latest')
  if (!releaseRes.ok) throw new Error(`Failed to fetch Supabase CLI release info: ${releaseRes.status}`)
  const release = (await releaseRes.json()) as { tag_name: string }
  const version = release.tag_name

  const tarName = `supabase_${osPlatform}_${osArch}.tar.gz`
  const downloadUrl = `https://github.com/supabase/cli/releases/download/${version}/${tarName}`

  core.info(`Downloading Supabase CLI ${version} for ${osPlatform}/${osArch}...`)

  const dlRes = await fetch(downloadUrl)
  if (!dlRes.ok) throw new Error(`Failed to download Supabase CLI: ${dlRes.status}`)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supabase-cli-'))
  const tarPath = path.join(tmpDir, tarName)
  fs.writeFileSync(tarPath, Buffer.from(await dlRes.arrayBuffer()))

  execFileSync('tar', ['-xzf', tarPath, '-C', tmpDir], { stdio: 'pipe' })

  const binaryPath = path.join(tmpDir, platform === 'win32' ? 'supabase.exe' : 'supabase')
  if (platform !== 'win32') fs.chmodSync(binaryPath, 0o755)

  core.info(`Supabase CLI ${version} ready.`)
  return binaryPath
}

async function waitForCheck(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  ref: string,
  checkName: string,
  timeoutMs: number,
  pollMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    let data: Awaited<ReturnType<typeof octokit.rest.checks.listForRef>>['data']
    try {
      const res = await octokit.rest.checks.listForRef({
        owner,
        repo,
        ref,
        check_name: checkName,
        filter: 'latest',
      })
      data = res.data
    } catch (err: unknown) {
      if (err instanceof Error && 'status' in err && (err as { status: number }).status === 403) {
        throw new Error(
          'GitHub API returned 403 when listing check runs. ' +
            'The workflow must grant the `checks: read` permission:\n\n' +
            '  permissions:\n' +
            '    checks: read'
        )
      }
      throw err
    }

    if (data.check_runs.length > 0) {
      const run = data.check_runs[0]
      if (run.status === 'completed') {
        if (run.conclusion === 'success') {
          core.info(`Check "${checkName}" passed.`)
          return
        }
        throw new Error(`Check "${checkName}" completed with conclusion: ${run.conclusion}`)
      }
      core.info(`Check "${checkName}": ${run.status} — polling in ${pollMs / 1000}s...`)
    } else {
      core.info(`Waiting for check "${checkName}" to appear — polling in ${pollMs / 1000}s...`)
    }

    await sleep(pollMs)
  }

  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for check "${checkName}"`)
}

async function run(): Promise<void> {
  // 1. Read inputs
  const accessToken = core.getInput('supabase_access_token', { required: true })
  const parentRef = core.getInput('project_ref', { required: true })
  const githubToken = core.getInput('github_token', { required: true })
  const checkName = core.getInput('check_name') || 'Supabase Preview'
  const timeoutSeconds = parseInt(core.getInput('timeout_seconds') || '300', 10)
  const pollIntervalSeconds = parseInt(core.getInput('poll_interval_seconds') || '10', 10)
  const includeSeed = core.getInput('include_seed') === 'true'
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
  const commitSha = (github.context.payload.pull_request?.head?.sha as string | undefined) ?? github.context.sha

  core.info(`Git branch: ${gitBranchName}`)
  core.info(`Supabase branch name: ${branchName}`)
  core.info(`Commit SHA: ${commitSha}`)

  // 3. Wait for the "Supabase Preview" GitHub check to pass
  const octokit = github.getOctokit(githubToken)
  const { owner, repo } = github.context.repo

  core.info(`Waiting for GitHub check "${checkName}"...`)
  await waitForCheck(octokit, owner, repo, commitSha, checkName, timeoutMs, pollMs)

  // 4. Resolve Supabase CLI
  const supabaseBin = await resolveSupabaseCLI()

  // 5. Fetch branch details via CLI
  core.info(`Fetching branch details for: ${branchName}`)
  const envOutput = execFileSync(
    supabaseBin,
    ['--experimental', 'branches', 'get', branchName, '--project-ref', parentRef, '-o', 'env'],
    {
      encoding: 'utf8',
      env: { ...process.env, SUPABASE_ACCESS_TOKEN: accessToken },
    }
  )

  // 6. Parse KEY=value output
  const vars: Record<string, string> = {}
  for (const line of envOutput.split('\n')) {
    const eqIdx = line.indexOf('=')
    if (eqIdx > 0) {
      const key = line.slice(0, eqIdx).trim()
      const value = line.slice(eqIdx + 1).trim()
      if (key) vars[key] = value
    }
  }

  core.info(`Branch env vars received: ${Object.keys(vars).join(', ')}`)

  // Helper to resolve a value from multiple candidate variable names
  const pick = (...keys: string[]) => keys.map(k => vars[k]).find(v => v) ?? ''

  const branchProjectRef = pick('PROJECT_REF', 'SUPABASE_PROJECT_REF')
  const dbHost = pick('DB_HOST', 'POSTGRES_HOST', 'SUPABASE_DB_HOST')
  const dbPort = pick('DB_PORT', 'POSTGRES_PORT', 'SUPABASE_DB_PORT') || '5432'
  const dbUser = pick('DB_USER', 'POSTGRES_USER', 'SUPABASE_DB_USER') || 'postgres'
  const dbPass = pick('DB_PASS', 'DB_PASSWORD', 'POSTGRES_PASSWORD', 'SUPABASE_DB_PASSWORD')
  const anonKey = pick('ANON_KEY', 'SUPABASE_ANON_KEY')
  const serviceRoleKey = pick('SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY')
  const supabaseUrl = pick('SUPABASE_URL') || (branchProjectRef ? `https://${branchProjectRef}.supabase.co` : '')
  const dbConnectionString = pick('DATABASE_URL', 'DB_URL', 'SUPABASE_DB_URL')

  // 7. Optionally run supabase db push --include-seed
  if (includeSeed) {
    const pushRef = branchProjectRef || parentRef
    core.info('Running supabase db push --include-seed...')
    execFileSync(
      supabaseBin,
      ['db', 'push', '--include-seed', '--project-ref', pushRef],
      {
        stdio: 'inherit',
        env: { ...process.env, SUPABASE_ACCESS_TOKEN: accessToken },
      }
    )
    core.info('supabase db push --include-seed completed successfully.')
  }

  // 8. Mask secrets BEFORE any logging or output
  if (anonKey) core.setSecret(anonKey)
  if (serviceRoleKey) core.setSecret(serviceRoleKey)
  if (dbPass) core.setSecret(dbPass)

  // 9. Export all raw vars to $GITHUB_ENV for convenience
  for (const [key, value] of Object.entries(vars)) {
    core.exportVariable(key, value)
  }

  // 10. Set structured action outputs
  core.setOutput('project_ref', branchProjectRef)
  core.setOutput('supabase_url', supabaseUrl)
  core.setOutput('anon_key', anonKey)
  core.setOutput('service_role_key', serviceRoleKey)
  core.setOutput('db_host', dbHost)
  core.setOutput('db_port', dbPort)
  core.setOutput('db_name', 'postgres')
  core.setOutput('db_user', dbUser)
  core.setOutput('db_password', dbPass)
  core.setOutput('db_connection_string', dbConnectionString)

  core.info(`Supabase preview branch ready: ${supabaseUrl}`)
}

run().catch(error => {
  core.setFailed(error instanceof Error ? error.message : String(error))
})
