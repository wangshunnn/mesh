import {
  runAllEvaluations,
  runCountingEvaluation,
  runCursorRecoveryEvaluation,
  runIdempotencyEvaluation,
  runStaleRebaseEvaluation,
  runTaskClaimEvaluation,
  runUnrelatedActivityEvaluation,
  type EvaluationReport,
} from "./scenarios.js";

const scenario = process.argv[2] ?? "all";
const reports = await selectEvaluations(scenario);

for (const report of reports) {
  printReport(report);
}

const passed = reports.every((report) => report.passed);
console.log(`\nPhase 0 evaluations: ${passed ? "PASS" : "FAIL"} (${reports.filter((r) => r.passed).length}/${reports.length})`);
if (!passed) {
  process.exitCode = 1;
}

async function selectEvaluations(name: string): Promise<readonly EvaluationReport[]> {
  switch (name) {
    case "all":
      return runAllEvaluations();
    case "counting":
      return [await runCountingEvaluation()];
    case "isolation":
      return [runUnrelatedActivityEvaluation()];
    case "claim":
      return [await runTaskClaimEvaluation()];
    case "idempotency":
      return [runIdempotencyEvaluation()];
    case "recovery":
      return [runCursorRecoveryEvaluation()];
    case "rebase":
      return [runStaleRebaseEvaluation()];
    default:
      console.error(`Unknown evaluation: ${name}`);
      console.error("Available: all, counting, isolation, claim, idempotency, recovery, rebase");
      process.exitCode = 2;
      return [];
  }
}

function printReport(report: EvaluationReport): void {
  console.log(`\n[${report.passed ? "PASS" : "FAIL"}] ${report.name}`);
  for (const [key, value] of Object.entries(report.metrics)) {
    console.log(`  ${key}: ${String(value)}`);
  }
  if (report.failure !== undefined) {
    console.log(`  failure: ${report.failure}`);
  }
}
