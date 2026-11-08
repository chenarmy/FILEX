import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = path.join(root, 'package.json');
const cargoPath = path.join(root, 'Cargo.toml');
const tauriPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const lockPath = path.join(root, 'Cargo.lock');
const workspacePackageNames = [
  'filex-contracts',
  'filex-core',
  'filex-credentials',
  'filex-desktop',
  'filex-ssh',
  'filex-storage',
];

const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const cargoText = fs.readFileSync(cargoPath, 'utf8');
const tauriJson = JSON.parse(fs.readFileSync(tauriPath, 'utf8'));
const lockText = fs.readFileSync(lockPath, 'utf8');
const workspaceVersionMatch = cargoText.match(/\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);

if (!workspaceVersionMatch) {
  throw new Error('Unable to find [workspace.package] version in Cargo.toml');
}

const lockVersions = Object.fromEntries(
  [...lockText.matchAll(/\[\[package\]\]\r?\nname = "([^"]+)"\r?\nversion = "([^"]+)"/g)]
    .filter((match) => workspacePackageNames.includes(match[1]))
    .map((match) => [match[1], match[2]]),
);

const versions = {
  package: packageJson.version,
  cargo: workspaceVersionMatch[1],
  tauri: tauriJson.version,
  lock: lockVersions,
};

if (process.argv.includes('--check')) {
  const expected = versions.package;
  const uniqueVersions = new Set([versions.cargo, versions.tauri, ...Object.values(versions.lock)]);
  const missingLockEntries = workspacePackageNames.filter((name) => !(name in versions.lock));
  if (uniqueVersions.size !== 1 || !uniqueVersions.has(expected) || missingLockEntries.length > 0) {
    console.error('Version mismatch:', { expected, versions, missingLockEntries });
    process.exit(1);
  }
  console.log(`Version files and Cargo.lock are synchronized at ${expected}.`);
  process.exit(0);
}

const requestedVersion = process.argv[2]?.replace(/^v/i, '');
if (!requestedVersion || !/^\d+\.\d+\.\d+$/.test(requestedVersion)) {
  console.error('Usage: pnpm version:set <major.minor.patch>');
  process.exit(1);
}

packageJson.version = requestedVersion;
tauriJson.version = requestedVersion;
const nextCargoText = cargoText.replace(
  /(\[workspace\.package\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/m,
  `$1${requestedVersion}$2`,
);

fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
fs.writeFileSync(tauriPath, `${JSON.stringify(tauriJson, null, 2)}\n`);
fs.writeFileSync(cargoPath, nextCargoText);
console.log(
  `Updated package, Cargo and Tauri versions to ${requestedVersion}. `
  + 'Run `cargo check --workspace --locked` after updating Cargo.lock.',
);

