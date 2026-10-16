import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';

const LABEL = 'com.multiopenvpn.helper';

// Runs as root once the user authenticates. Arguments: $1 = app bundle, $2 = setup JSON.
// The app bundle is copied to a root-owned location: a root daemon must never execute code
// from /Applications, which the user (and anything running as the user) can modify.
const INSTALL_SCRIPT = `set -euo pipefail
APP="$1"; SETUP="$2"
BASE="/Library/Application Support/MultiOpenVPN"
LABEL="${LABEL}"
PLIST="/Library/LaunchDaemons/$LABEL.plist"
launchctl bootout "system/$LABEL" 2>/dev/null || true
mkdir -p "$BASE"; chown root:wheel "$BASE"; chmod 755 "$BASE"
rm -rf "$BASE/Helper.app"
/usr/bin/ditto "$APP" "$BASE/Helper.app"
chown -R root:wheel "$BASE/Helper.app"; chmod -R go-w "$BASE/Helper.app"
EXE_NAME="$(/usr/bin/defaults read "$BASE/Helper.app/Contents/Info" CFBundleExecutable)"
EXE="$BASE/Helper.app/Contents/MacOS/$EXE_NAME"
JS="$BASE/Helper.app/Contents/Resources/app.asar/out/main/helper.js"
ELECTRON_RUN_AS_NODE=1 "$EXE" "$JS" --setup "$SETUP"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$EXE</string><string>$JS</string></array>
  <key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$BASE/helper.log</string>
</dict></plist>
PLIST
chown root:wheel "$PLIST"; chmod 644 "$PLIST"
launchctl bootstrap system "$PLIST"
`;

const UNINSTALL_SCRIPT = `set -uo pipefail
launchctl bootout "system/${LABEL}" 2>/dev/null || true
rm -f "/Library/LaunchDaemons/${LABEL}.plist"
rm -rf "/Library/Application Support/MultiOpenVPN"
`;

/** Runs a bash script as root after the standard macOS administrator prompt. Values go through argv, never string concatenation. */
function runAsAdmin(script: string, args: string[]): Promise<void> {
  const osa = [
    'on run argv',
    'set cmd to "/bin/bash -c " & quoted form of (item 1 of argv) & " installer"',
    'repeat with i from 2 to count of argv',
    'set cmd to cmd & " " & quoted form of (item i of argv)',
    'end repeat',
    'do shell script cmd with administrator privileges',
    'end run',
  ];
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', [...osa.flatMap((l) => ['-e', l]), script, ...args], { timeout: 300_000 }, (err, _out, stderr) => {
      if (!err) return resolve();
      reject(new Error(/User canceled|-128/.test(String(stderr)) ? 'Installation cancelled' : `Helper installation failed: ${String(stderr || err.message).trim()}`));
    });
  });
}

export interface InstallOptions {
  /** Path of the running executable (process.execPath) of the packaged app. */
  execPath: string;
  allowedRoots: string[];
  binaries: string[];
}

export async function installHelper(opts: InstallOptions): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('On Windows the privileged helper is installed as a service by the installer.');
  }
  const bundle = dirname(dirname(dirname(opts.execPath))); // X.app/Contents/MacOS/X → X.app
  if (!bundle.endsWith('.app')) throw new Error('The helper can only be installed from the packaged app (in development use `npm run helper:dev`).');
  const setup = JSON.stringify({ ownerUid: process.getuid?.(), allowedRoots: opts.allowedRoots, binaries: opts.binaries });
  await runAsAdmin(INSTALL_SCRIPT, [bundle, setup]);
}

export async function uninstallHelper(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Use the Windows installer to remove the helper service.');
  await runAsAdmin(UNINSTALL_SCRIPT, []);
}

export const helperTokenFile = (base: string): string => join(base, 'token');
