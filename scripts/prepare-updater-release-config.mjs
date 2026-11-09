import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { parseUpdaterPublicKey } from './updater-signature.mjs';

const configPath = process.argv[2];
if (!configPath) {
  throw new Error('Usage: node scripts/prepare-updater-release-config.mjs <tauri-config-path>');
}

const publicKey = (process.env.FILEX_UPDATER_PUBLIC_KEY ?? '').trim();
parseUpdaterPublicKey(publicKey);

const config = JSON.parse(await readFile(configPath, 'utf8'));
if (!config || typeof config !== 'object' || Array.isArray(config)) {
  throw new Error('Tauri release configuration must be a JSON object');
}

const plugins = config.plugins && typeof config.plugins === 'object' && !Array.isArray(config.plugins)
  ? config.plugins
  : {};
const updater = plugins.updater && typeof plugins.updater === 'object' && !Array.isArray(plugins.updater)
  ? plugins.updater
  : {};

config.plugins = {
  ...plugins,
  updater: {
    ...updater,
    pubkey: publicKey,
  },
};

await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log('Prepared signed updater release configuration.');
