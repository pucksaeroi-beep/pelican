// Package the built app as a DMG and publish it as a GitHub release (run via `npm run release`).
// The app is signed ad-hoc (no Apple developer account), so on first launch macOS asks the user to
// allow it once (see README → Download).
import { cpSync, rmSync, mkdirSync, existsSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const name = pkg.build.productName;
const tag = `v${pkg.version}`;
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

const rel = 'release';
const dir = readdirSync(rel).find((d) => d.startsWith('mac') && existsSync(join(rel, d, `${name}.app`)));
if (!dir) { console.error(`${name}.app not found — run \`npm run dist\` first`); process.exit(1); }

const stage = join(rel, 'dmg');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage);
const app = join(stage, `${name}.app`);
cpSync(join(rel, dir, `${name}.app`), app, { recursive: true, verbatimSymlinks: true });
symlinkSync('/Applications', join(stage, 'Applications'));
run('codesign', ['--force', '--deep', '--sign', '-', app]);

const dmg = join(rel, `${name}-mac-arm64.dmg`);
rmSync(dmg, { force: true });
run('hdiutil', ['create', '-volname', name, '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg]);
rmSync(stage, { recursive: true, force: true });

let exists = true;
try { execFileSync('gh', ['release', 'view', tag], { stdio: 'ignore' }); } catch { exists = false; }
if (exists) run('gh', ['release', 'upload', tag, dmg, '--clobber']);
else run('gh', ['release', 'create', tag, dmg, '--title', `${name} ${pkg.version}`, '--notes', `${name} ${pkg.version} for macOS (Apple Silicon). Open the DMG and drag ${name} into Applications.`]);
console.log(`Released ${dmg} → ${tag}`);
