/**
 * Locate a Chromium-family browser for the CDP harnesses.
 *
 * Only the tools/ acceptance scripts need one; running the service does not.
 * MYOBS_CHROME wins so people with a non-standard install are never blocked.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_BINARIES = [
  'Google Chrome.app/Contents/MacOS/Google Chrome',
  'Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  'Chromium.app/Contents/MacOS/Chromium',
  'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'Brave Browser.app/Contents/MacOS/Brave Browser',
];

/** @returns {string | null} absolute executable path, or null when none found */
export function findChrome() {
  const fromEnv = process.env.MYOBS_CHROME;
  if (fromEnv && fromEnv.trim()) {
    const resolved = path.resolve(fromEnv.trim());
    return fs.existsSync(resolved) ? resolved : null;
  }
  for (const root of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    for (const rel of APP_BINARIES) {
      const candidate = path.join(root, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}
