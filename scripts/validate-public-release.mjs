import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));

if (manifest.manifest_version !== 3) {
  throw new Error('manifest.json must use Manifest V3');
}

const scripts = new Set([manifest.background?.service_worker]);
for (const entry of manifest.content_scripts ?? []) {
  for (const script of entry.js ?? []) scripts.add(script);
}
scripts.delete(undefined);

for (const relativePath of scripts) {
  await readFile(path.join(root, relativePath));
  const check = spawnSync(process.execPath, ['--check', relativePath], {
    cwd: root,
    encoding: 'utf8',
  });
  if (check.status !== 0) {
    throw new Error(`Syntax check failed for ${relativePath}:\n${check.stderr}`);
  }
}

for (const iconPath of Object.values(manifest.icons ?? {})) {
  await readFile(path.join(root, iconPath));
}

const forbiddenPaths = [
  '.claude',
  '.playwright-mcp',
  'all-transactions.json',
  'financial-dashboard.html',
  'snapshot.md',
];

const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
});
if (listed.status !== 0) {
  throw new Error(`Unable to enumerate public release files:\n${listed.stderr}`);
}
const files = listed.stdout.trim().split(/\r?\n/).filter(Boolean);
const requiredPublicFiles = [
  'docs/screenshots/review-workflow.png',
  'docs/screenshots/rules-manager.png',
];
const approvedScreenshotHashes = {
  'docs/screenshots/review-workflow.png': '31355fd39e798881084aae3da2715bbbd0120efad9e61275de5893c010e01a50',
  'docs/screenshots/rules-manager.png': '94a50facc63e7563c7073dfb9c14ac3e20a3591e1d8a59d44679ff7eb1164503',
};
for (const requiredFile of requiredPublicFiles) {
  if (!files.includes(requiredFile)) {
    throw new Error(`Public release is missing ${requiredFile}`);
  }
}
for (const [screenshot, approvedHash] of Object.entries(approvedScreenshotHashes)) {
  const hash = createHash('sha256').update(await readFile(path.join(root, screenshot))).digest('hex');
  if (hash !== approvedHash) {
    throw new Error('Public screenshot requires privacy and accuracy review: ' + screenshot);
  }
}
for (const forbiddenPath of forbiddenPaths) {
  if (files.some((file) => file.replaceAll('\\', '/').startsWith(forbiddenPath))) {
    throw new Error(`Private artifact must not be included in a public release: ${forbiddenPath}`);
  }
}

const forbiddenContent = [
  /C:\\Users\\/i,
  /AIza[0-9A-Za-z_-]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

for (const file of files) {
  if (/\.(png|ico|jpg|jpeg|webp)$/i.test(file)) continue;
  const contents = await readFile(path.join(root, file), 'utf8');
  for (const pattern of forbiddenContent) {
    if (pattern.test(contents)) {
      throw new Error(`Public-release check failed for ${file}: ${pattern}`);
    }
  }
}

const readme = await readFile(path.join(root, 'README.md'), 'utf8');
for (const screenshot of requiredPublicFiles) {
  if (!readme.includes(screenshot)) {
    throw new Error(`README.md must display ${screenshot}`);
  }
}

console.log(`Validated ${scripts.size} extension scripts and public-release safeguards.`);
