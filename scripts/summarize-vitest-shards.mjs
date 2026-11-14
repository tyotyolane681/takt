// Temporary Windows CI diagnostics: summarize vitest JSON reports per unit shard.
// Usage: node scripts/summarize-vitest-shards.mjs <label>=<json-path> ...
// The exit code of each shard is read from the VITEST_SHARD_<label>_EXIT environment variable.
import { existsSync, readFileSync } from 'node:fs';

function summarizeShard(label, jsonPath) {
  const exitCode = process.env[`VITEST_SHARD_${label}_EXIT`] ?? 'unknown (step timed out, was cancelled, or did not run)';
  console.log(`=== shard ${label}: exit code ${exitCode} ===`);
  if (!existsSync(jsonPath)) {
    console.log(`JSON なし = vitest が結果を書けずに終了 (${jsonPath})`);
    return;
  }
  const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
  console.log(
    `test files: ${report.testResults.length}, tests: ${report.numTotalTests}, ` +
      `passed: ${report.numPassedTests}, failed: ${report.numFailedTests}, pending: ${report.numPendingTests}`,
  );
  for (const file of report.testResults) {
    const failed = file.assertionResults.filter((test) => test.status === 'failed');
    if (file.status === 'passed' && failed.length === 0) continue;
    console.log(`FAILED FILE: ${file.name} (status: ${file.status})`);
    if (file.message) console.log(`  ${file.message}`);
    for (const test of failed) console.log(`  FAILED TEST: ${test.fullName}`);
  }
}

const shards = process.argv.slice(2);
if (shards.length === 0) {
  console.error('Usage: summarize-vitest-shards.mjs <label>=<json-path> ...');
  process.exit(2);
}
for (const shard of shards) {
  const separator = shard.indexOf('=');
  summarizeShard(shard.slice(0, separator), shard.slice(separator + 1));
}
