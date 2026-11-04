import type { OpenAIProvider } from "@ai-sdk/openai";
import type { InferToolInput } from "ai";
import { toBase64, toWorkspaceRelative } from "./filesystem-utils.ts";

// Applies one file operation in the workspace root: an OpenAI apply_patch operation (V4A diff)
// or an Anthropic text editor insert. Runs under node.
const APPLY_SCRIPT = String.raw`
const fs = require('node:fs');
const nodePath = require('node:path');
const op = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
function fail(message) { process.stderr.write(message + '\n'); process.exit(1); }
function diffLines(diff) {
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.filter((line) => line !== '*** End of File');
}
function save(path, text) {
  fs.mkdirSync(nodePath.dirname(path), { recursive: true });
  const fd = fs.openSync(path, 'w');
  try { fs.writeSync(fd, text, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function find(lines, block, from) {
  const forms = [(s) => s, (s) => s.trimEnd(), (s) => s.trim()];
  for (const form of forms) {
    for (let at = from; at + block.length <= lines.length; at++) {
      if (block.every((line, i) => form(lines[at + i]) === form(line))) return at;
    }
  }
  return -1;
}
function update(text, diff) {
  const lines = text.split('\n');
  const chunks = [];
  let chunk;
  for (const line of diffLines(diff)) {
    if (line.startsWith('@@')) { chunk = { anchor: line.slice(2).trim(), old: [], new: [] }; chunks.push(chunk); continue; }
    if (!chunk) { chunk = { anchor: '', old: [], new: [] }; chunks.push(chunk); }
    const body = line.slice(1);
    if (line.startsWith('+')) chunk.new.push(body);
    else if (line.startsWith('-')) chunk.old.push(body);
    else { chunk.old.push(body); chunk.new.push(body); }
  }
  let cursor = 0;
  for (const { anchor, old, new: added } of chunks) {
    if (anchor) {
      const at = lines.findIndex((line, i) => i >= cursor && line.trim() === anchor);
      if (at < 0) fail('Error: context not found: ' + anchor);
      cursor = at + 1;
    }
    const at = old.length === 0 ? (anchor ? cursor : lines.length) : find(lines, old, cursor);
    if (at < 0) fail('Error: patch does not match ' + op.path + ' near: ' + old.slice(0, 3).join(' / '));
    lines.splice(at, old.length, ...added);
    cursor = at + added.length;
  }
  return lines.join('\n');
}
if (op.type === 'delete_file') {
  try { fs.unlinkSync(op.path); } catch (error) { fail('Error: ' + error.message); }
  process.stdout.write('Deleted ' + op.path + '\n');
} else if (op.type === 'insert') {
  let text;
  try { text = fs.readFileSync(op.path, 'utf8'); } catch { fail('Error: file not found: ' + op.path); }
  const lines = text.split('\n');
  const endsWithNewline = lines.at(-1) === '';
  if (endsWithNewline) lines.pop();
  if (!Number.isInteger(op.line) || op.line < 0 || op.line > lines.length) {
    fail('Error: insert_line ' + op.line + ' is outside 0..' + lines.length + ' in ' + op.path);
  }
  const added = op.text.split('\n');
  if (added.at(-1) === '') added.pop();
  lines.splice(op.line, 0, ...added);
  save(op.path, lines.join('\n') + (endsWithNewline ? '\n' : ''));
  process.stdout.write('Inserted after line ' + op.line + ' of ' + op.path + '\n');
} else if (op.type === 'create_file') {
  if (fs.existsSync(op.path)) fail('Error: ' + op.path + ' already exists');
  const lines = diffLines(op.diff).map((line) => (line.startsWith('+') ? line.slice(1) : line));
  save(op.path, lines.join('\n') + '\n');
  process.stdout.write('Created ' + op.path + '\n');
} else {
  let text;
  try { text = fs.readFileSync(op.path, 'utf8'); } catch { fail('Error: file not found: ' + op.path); }
  save(op.path, update(text, op.diff));
  process.stdout.write('Updated ' + op.path + '\n');
}
`;
const APPLY_SCRIPT_BASE64 = toBase64(APPLY_SCRIPT);

// insert_line is the line the text goes after; 0 is the top of the file.
export type FileOperation =
  | InferToolInput<
      ReturnType<OpenAIProvider["tools"]["applyPatch"]>
    >["operation"]
  | { type: "insert"; path: string; line: number; text: string };

export function fileOperationScript(operation: FileOperation): string {
  const path = toWorkspaceRelative(operation.path);
  if (path === ".") throw new Error("Error: path must reference a file");
  const payload = toBase64(JSON.stringify({ ...operation, path: path }));

  return `node -e "$(printf '%s' '${APPLY_SCRIPT_BASE64}' | base64 -d)" '${payload}'`;
}
