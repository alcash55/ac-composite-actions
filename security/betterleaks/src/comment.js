import * as core from '@actions/core';
import { readFileSync, statSync } from 'node:fs';

export function validateReport(report, run, pr, repository) {
  if (report.version !== 1 || String(report.runId) !== String(run.id)
    || !Number.isSafeInteger(report.prNumber) || report.prNumber < 1
    || !/^[a-f0-9]{40}$/.test(report.headSha || '')
    || report.headSha !== run.head_sha || run.event !== 'pull_request'
    || run.repository.full_name !== repository
    || !Number.isInteger(report.total) || report.total < 0
    || !Array.isArray(report.findings) || report.findings.length > 100
    || report.findings.length !== Math.min(report.total, 100)) {
    throw new Error('Secret scan artifact does not match the triggering PR run.');
  }
  for (const f of report.findings) {
    if (typeof f.file !== 'string' || f.file.length > 500
      || typeof f.rule !== 'string' || f.rule.length > 100
      || !Number.isSafeInteger(f.line) || f.line < 1 || !/^[a-f0-9]{40}$/.test(f.commit || '')) {
      throw new Error('Secret scan artifact has invalid finding metadata.');
    }
  }
  if (pr.number !== report.prNumber || pr.base.repo.full_name !== repository
    || pr.head.repo?.full_name !== run.head_repository.full_name) {
    throw new Error('Secret scan artifact does not identify a PR in this repository.');
  }
  // A newer push or a closed PR must not acquire an old run's comment.
  if (pr.state !== 'open' || pr.head.sha !== report.headSha) return null;
  return {
    findings: report.findings.map(({ file, line, rule, commit }) => ({ file, line, rule, commit, match: '[REDACTED]' })),
    total: report.total,
  };
}

export async function run(env = process.env) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const source = event.workflow_run;
  if (env.GITHUB_EVENT_NAME !== 'workflow_run' || source?.event !== 'pull_request' || source.status !== 'completed') {
    throw new Error('The secret comment reporter requires a completed pull_request workflow_run.');
  }
  if (statSync(env.REPORT_PATH).size > 120000) throw new Error('Secret scan artifact is too large.');
  let report;
  try { report = JSON.parse(readFileSync(env.REPORT_PATH, 'utf8')); }
  catch { throw new Error('Secret scan artifact is not valid JSON.'); }
  if (!Number.isSafeInteger(report.prNumber) || report.prNumber < 1) throw new Error('Secret scan artifact has an invalid PR number.');
  const response = await fetch(`${env.GITHUB_API_URL || 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/pulls/${report.prNumber}`, {
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`Could not verify the source pull request, HTTP ${response.status}.`);
  const data = validateReport(report, source, await response.json(), env.GITHUB_REPOSITORY);
  if (!data) { core.notice('Skipped an outdated secret scan report.'); return; }
  core.setOutput('DATA', JSON.stringify(data));
  core.setOutput('PR_NUMBER', String(report.prNumber));
}

if (process.env.NODE_ENV !== 'test') run().catch((error) => core.setFailed(error.message));
