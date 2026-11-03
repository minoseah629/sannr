// HARDENING-5: consume Node's structured events, never assertion bodies or stdout.
// Stream names immediately so a timeout can leave useful, explicitly partial evidence.
const escapeName = (name) => String(name).replace(/[\x00-\x20\x7f-\x9f]+/g, " ")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export default async function* windowsTestReporter(source) {
  yield "### Windows unit tests — experimental, non-blocking\n\n" +
    "Failure names below include failed parent suites. Skips and TODOs are not failures.\n" +
    "Until a final result appears, this report is incomplete; it is not a passing run.\n\n<ul>\n";
  let failures = 0;
  let summary;
  for await (const event of source) {
    if (event.type === "test:fail" && !event.data.skip && !event.data.todo) {
      failures++;
      yield `<li><code>${escapeName(event.data.name)}</code></li>\n`;
    }
    // Node also emits per-file summaries; only the outer runner completes the run.
    if (event.type === "test:summary" && !event.data.file) summary = event.data;
  }
  yield "</ul>\n\n";
  if (!summary) {
    yield "Result: incomplete — no final runner summary; not a passing run.\n";
    return;
  }
  if (!failures) yield "No failing tests reported.\n\n";
  const { tests, passed, failed, skipped, todo } = summary.counts;
  yield `Tests: ${tests}; passed: ${passed}; failed: ${failed}; skipped: ${skipped}; todo: ${todo}.\n\n`;
  yield `Result: ${summary.success ? "passed" : "failed"}.\n`;
}
