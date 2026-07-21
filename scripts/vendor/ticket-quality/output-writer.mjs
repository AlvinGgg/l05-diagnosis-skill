import fs from "node:fs";
import path from "node:path";

function markdown(report) {
  const findings = report.privacy_gate.findings.map((item) => `- ${item.pattern_id}: ${item.file}#${item.location}`).join("\n") || "- None";
  const reasons = report.reasons.map((item) => `- ${item}`).join("\n") || "- None";
  return `# Jira quality decision: ${report.issue_key || "unknown"}\n\n- Decision: ${report.decision}\n- Source status: ${report.source_status || "not promoted"}\n- Ingest ID: ${report.ingest_id || "unknown"}\n- Content hash: ${report.content_hash || "unknown"}\n- Scoring version: ${report.scoring_version}\n- Collection gate: ${report.collection_gate.status}\n- Privacy gate: ${report.privacy_gate.status}\n- Resolution quality: ${report.resolution_quality.score} (${report.resolution_quality.level})\n- Knowledge value: ${report.knowledge_value.score} (${report.knowledge_value.confidence})\n\n## Reasons\n\n${reasons}\n\n## Privacy findings\n\n${findings}\n\n## Evidence pointers\n\n${report.evidence_pointers.map((item) => `- ${item}`).join("\n") || "- None"}\n`;
}

export function writeReport(report, outputDir) {
  const root = path.resolve(outputDir);
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  const stem = report.ingest_id || `unknown-${report.issue_key || "bundle"}`;
  const jsonPath = path.join(root, `${stem}.json`);
  const markdownPath = path.join(root, `${stem}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, {mode: 0o600});
  fs.writeFileSync(markdownPath, markdown(report), {mode: 0o600});
  return {json: jsonPath, markdown: markdownPath};
}
