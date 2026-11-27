/** Test helper: a small Mac app bundle for the packaging and signature tests (macOS only). */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A small app bundle around a copy of /usr/bin/true; `sign` seals the whole bundle ad hoc, as the build does. */
export async function fixtureApp(dir, { version = '1.0.0', sign = true } = {}) {
  const app = join(dir, 'Ensemble.app');
  await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
  await mkdir(join(app, 'Contents/Resources'), { recursive: true });
  await writeFile(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Ensemble</string>
<key>CFBundleIdentifier</key><string>com.ensemblework.desktop.fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>
`);
  await writeFile(join(app, 'Contents/Resources/readme.txt'), 'fixture resource\n');
  await copyFile('/usr/bin/true', join(app, 'Contents/MacOS/Ensemble'));
  if (sign) execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app]);
  else execFileSync('/usr/bin/codesign', ['--remove-signature', join(app, 'Contents/MacOS/Ensemble')]);
  return app;
}
