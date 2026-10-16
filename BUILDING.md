# Building, running and releasing

## Development

```bash
npm install
npm run dev:mock          # UI with simulated VPNs (no OpenVPN, no admin rights)
npm run dev               # real OpenVPN; see "Privileges" below
npm run typecheck && npm test
```

Tests run real `openvpn` processes without root (point-to-point TLS with `--dev null`,
see `tests/helpers/openvpnLab.ts`); they are skipped when `openvpn` or `openssl` is missing.

> When launching Electron from a shell that has `ELECTRON_RUN_AS_NODE=1` set (some IDE
> terminals do), Electron starts as plain Node and the app crashes at startup. Unset it.

### Privileges

Creating tunnel interfaces, routes and DNS settings needs root/administrator. The app itself
always runs as the user; privileged work goes through the helper (see ARCHITECTURE.md §7).

- Development (macOS/Linux): `npm run build && npm run helper:dev` asks for your sudo password and
  runs the helper from this repo (config in `.dev-helper/`, socket `/tmp/mov-dev-<uid>.sock`).
  Start `npm run dev` in another terminal; Settings shows "Installed and running".
- Packaged macOS app: Settings → Privileged helper → Install helper… (administrator prompt).
- Windows: the installer registers the helper ("MultiOpenVPN Helper" SYSTEM task, started at boot).
  The portable .exe has no helper and can only run profiles that need no admin rights.

After upgrading OpenVPN, reinstall the helper: it only runs binaries whose SHA-256 was approved
at install time.

## Packaging

```bash
npm run icons             # regenerate build/icon.png and resources/tray/*.png (no dependencies)
npm run dist:mac          # dist/*.dmg + *.zip for x64 and arm64
npm run dist:win          # dist/*-Setup-*.exe (NSIS) + *-portable.exe for x64
npm run dist:dir          # unpacked app for the current platform (quick check)
```

Unsigned local builds: if the keychain contains certificates that cannot sign code,
electron-builder may pick one and fail ("this identity cannot be used for signing code"). Build
with `CSC_IDENTITY_AUTO_DISCOVERY=false` to produce an ad-hoc signed app instead.

The packaged app contains only `out/**` (main, helper, preload, renderer are bundled; no
`node_modules`). Electron fuses: `RunAsNode` stays enabled because the helper is the same binary in
Node mode; `NODE_OPTIONS`, `--inspect`, and loading code outside the integrity-checked `app.asar`
are disabled.

### Bundling OpenVPN (optional)

Put binaries in `resources/openvpn/<os>-<arch>/` (`mac-x64`, `mac-arm64`, `win-x64`); they are copied
to `<resources>/openvpn/…` and used before any system installation.

- macOS: OpenVPN Community does not ship a standalone macOS binary; build it (e.g. from Homebrew's
  formula) with its OpenSSL/LZO/LZ4 libraries made relocatable, or rely on the user's
  `/opt/homebrew/sbin/openvpn` / `/usr/local/sbin/openvpn`.
- Windows: copy `openvpn.exe`, its DLLs (`libcrypto-3-x64.dll`, `libssl-3-x64.dll`,
  `libpkcs11-helper-1.dll`, …) and `wintun.dll` from an OpenVPN Community 2.6 install, or require
  the OpenVPN Community installer (it also installs the DCO/TAP drivers).

## Code signing

macOS (Developer ID):

```bash
export CSC_LINK=/path/DeveloperID_Application.p12 CSC_KEY_PASSWORD=…
export APPLE_API_KEY=/path/AuthKey_XXXX.p8 APPLE_API_KEY_ID=XXXX APPLE_API_ISSUER=…
npx electron-vite build && npx electron-builder --mac -c.mac.notarize=true
```

Hardened runtime is on; the only entitlement is `com.apple.security.cs.allow-jit`
(`build/entitlements.mac.plist`). A notarized app is required for the helper's launchd daemon on
end-user machines (Gatekeeper must accept the root-owned copy).

Windows (Authenticode): set `CSC_LINK` / `CSC_KEY_PASSWORD` to a `.pfx`, or configure
`win.azureSignOptions` in `electron-builder.yml` for Azure Trusted Signing.

## Release checklist

1. `npm run typecheck && npm test`
2. Bump `version` in `package.json`
3. `npm run dist:mac` on macOS, `npm run dist:win` (or on macOS: NSIS builds there too)
4. On a clean machine: install, install the helper, import two profiles, connect both,
   check Routes / DNS, quit with "Disconnect All & Quit", confirm routes and DNS are restored.
