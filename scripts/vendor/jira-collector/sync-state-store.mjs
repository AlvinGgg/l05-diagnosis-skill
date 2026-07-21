import fs from "node:fs";
import path from "node:path";

export class SyncStateStore {
  constructor(file) { this.file = file; this.state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {version: 1, issues: {}}; }
  unchanged(sourceIdentity, contentHash) { return this.state.issues[sourceIdentity]?.content_hash === contentHash; }
  record(sourceIdentity, entry) {
    this.state.issues[sourceIdentity] = entry;
    fs.mkdirSync(path.dirname(this.file), {recursive: true});
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`);
    fs.renameSync(temp, this.file);
  }
}
