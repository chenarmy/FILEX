import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = (process.argv[2] || process.env.GITHUB_REF_NAME || '').replace(/^v/i, '');

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Expected a stable semantic version, received '${version}'`);
}

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const headerMatch = new RegExp(`^## \\[${escapedVersion}\\][^\\n]*$`, 'm').exec(changelog);
if (!headerMatch) {
  throw new Error(`CHANGELOG.md has no section for version ${version}`);
}

const sectionStart = headerMatch.index + headerMatch[0].length;
const remainder = changelog.slice(sectionStart).replace(/^\r?\n/, '');
const nextSectionIndex = remainder.search(/^## \[/m);
const body = (nextSectionIndex >= 0 ? remainder.slice(0, nextSectionIndex) : remainder).trim();
if (!body) {
  throw new Error(`CHANGELOG.md section ${version} is empty`);
}

if (process.env.GITHUB_OUTPUT) {
  const delimiter = `FILEX_RELEASE_NOTES_${Date.now()}`;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `body<<${delimiter}\n${body}\n${delimiter}\n`);
} else {
  process.stdout.write(body);
}

