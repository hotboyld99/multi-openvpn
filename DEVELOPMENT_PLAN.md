# Development Plan

Each phase ends with `npm run typecheck && npm test && npm run build` green and a
short report (Completed / Changed files / Decisions / How to test / Limitations / Next).

| Phase | Scope | Exit criteria |
|---|---|---|
| 1 Foundation | Electron + React + TS + Vite + Tailwind, secure window, typed preload, zod IPC, `VpnManager` state machine with driver seam, `MockVpnDriver`, profile/settings stores, UI: sidebar, dashboard cards, profiles (search, multi-select, connect selected, disconnect all), connections, logs, interfaces, settings, dark/light | Mock mode runs several connections concurrently; state machine + isolation tests pass |
| 2 OpenVPN runner | `OpenVpnBinaryManager` (bundled/system/browse, version), `VpnProcess`, `VpnProcessManager`, `DirectLauncher`, free-port allocator, graceful stop → SIGTERM → force kill | Two real `openvpn` processes start/stop independently |
| 3 Management | `OpenVpnManagementClient` + protocol parser, hold release, state/log/bytecount, auth dialog via `>PASSWORD:`, `LogClassifier` → `VpnErrorCode`, reconnect backoff with non-retryable errors | Parser tests; real connection reports state/bytes; bad password → `AUTH_FAILED`, no retry loop |
| 4 Profiles | `.ovpn` tokenizer/parser/serializer, importer (file dialog, drag & drop, multi-file), external cert copy + path rewrite, `ConfigSecurityScanner` + confirm dialog, rename/duplicate/delete/view/edit/export | Parser, importer, scanner tests |
| 5 Multi VPN | Interface detection per connection, per-connection temp dirs, crash isolation | Integration tests: A+B up; A down → B up; A crash → B up |
| 6 Routing | Route table reader (macOS/Windows), ownership attribution, default-route conflict detector + dialog, custom routes (CIDR/IP/hostname), Route Inspector | Conflict detector + route parser tests |
| 7 DNS | `DnsManager` macOS (scutil) / Windows, modes vpn/system/custom, conflict warning, restore on disconnect/crash | Restore verified after kill -9 |
| 8 Security | `CredentialStore` (safeStorage), remember-securely, privileged helper + `HelperLauncher`, install flow | App runs as user; helper owns network ops |
| 9 Production | Tray menu, quit dialog (disconnect all / keep running / cancel), auto-start, auto-connect, electron-builder dmg/zip/nsis/portable for x64+arm64, signing hooks | Installers build |

## Conventions

- TypeScript strict. No `any` across IPC boundaries.
- Pure logic (parsers, classifiers, state transitions) lives in files without Electron
  imports so vitest runs it directly.
- No `exec`, no `shell: true`, no string-built commands.
- Mock mode: `VPN_MOCK_MODE=true npm run dev`.

## Status

| Phase | State |
|---|---|
| 1 Foundation | done |
| 2 OpenVPN runner | done |
| 3 Management interface | done |
| 4 Profiles | done |
| 5 Multi VPN | done |
| 6 Routing | done |
| 7 DNS | done |
| 8–9 | pending |

## Testing real OpenVPN without root

`tests/helpers/openvpnLab.ts` builds a throwaway PKI with `openssl` and runs
point-to-point TLS servers with `--dev null`, so real `openvpn` clients connect
without a tun device or root. Integration tests (management interface, private key
prompt, TLS errors, 3 concurrent connections, crash isolation, orphan cleanup) run
against it and are skipped automatically when `openvpn` or `openssl` is missing.
Server mode (`auth-user-pass`, pushed routes/DNS, real tun interfaces) needs root and
is covered by a fake management server plus manual testing.
