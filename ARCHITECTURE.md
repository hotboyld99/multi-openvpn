# Architecture — Multi OpenVPN Client

Desktop app (Electron, macOS x64/arm64, Windows x64; Linux-ready) that runs **many
OpenVPN Community processes at the same time**, one per profile, and manages their
state, routes, DNS, logs and credentials. The app never implements the OpenVPN
protocol — it only drives the `openvpn` binary.

## 1. Process model

```text
┌──────────────────────────────┐
│ Renderer (React)             │  sandbox: true, contextIsolation: true,
│  - UI only, no Node APIs     │  nodeIntegration: false
└──────────────┬───────────────┘
               │ window.vpn.*  (preload, whitelisted, typed)
┌──────────────▼───────────────┐
│ Main process (normal user)   │
│  ipc/*        zod-validated handlers
│  VpnManager   connection state machine, reconnect/backoff, conflicts
│  VpnProcess   one per connection, owns its management client
│  ProfileStore / SettingsStore / CredentialStore (safeStorage)
│  RouteManager / DnsManager / InterfaceManager (read side)
└──────────────┬───────────────┘
               │ ProcessLauncher (JSON-RPC over unix socket / named pipe)
┌──────────────▼───────────────┐
│ Privileged helper (root/SYSTEM)
│  spawn/kill openvpn, route add/delete, DNS set/restore
│  narrow allow-listed RPC, no shell, validates every argument
└──────────────┬───────────────┘
               │ spawn(openvpnPath, args, { shell: false })
     ┌─────────┼─────────┬─────────┐
   openvpn   openvpn   openvpn   openvpn     ← one process per connection
   :mgmtA    :mgmtB    :mgmtC    :mgmtD      ← one management port each
   utun4     utun5     utun6     utun7       ← one virtual interface each
```

Rules that follow from this:

- The renderer can only call the functions exposed in `src/preload/index.ts`.
  `child_process`, `fs`, `shell` are never exposed.
- Every IPC payload is parsed with a zod schema in `src/shared/schemas` before the
  main process touches it.
- Main never builds a command string. All process creation is
  `spawn(binary, argsArray, { shell: false })`, in main (dev/mock) or in the helper.
- Only the helper has elevated rights. Main and renderer run as the normal user.

## 2. Connection model (the core of the product)

State is **always indexed by `connectionId`**, never a global `connected` flag.

```ts
connections: Record<ConnectionId, VpnConnection>
```

- A profile has at most one live connection at a time (two copies of the same tunnel
  would fight over the same routes). Different profiles are fully independent.
- `connectionId` is stable across reconnects of the same session; a new
  `connect()` after a full disconnect creates a new id.
- The last connection of each profile is kept (status `DISCONNECTED`/`ERROR`) so the
  user can still read its logs and error.

### Driver seam

`VpnManager` owns the state machine. It does not know whether the tunnel is real:

```text
VpnManager ──creates──► VpnDriver (per connection)
                          ├── OpenVpnDriver   (real: VpnProcess + management client)
                          └── MockVpnDriver   (VPN_MOCK_MODE=true)
```

A driver only emits raw events — `state`, `log`, `bytes`, `exit`. Status
transitions, metrics, reconnect backoff, error classification and cleanup live in
`VpnManager`, so the same logic is unit-tested with a fake driver and runs
identically in mock and real mode. A driver crash or exit only affects its own
connection entry.

### State machine

```text
            connect()
DISCONNECTED ───────► CONNECTING ─► WAIT ─► AUTH ─► GET_CONFIG ─► ASSIGN_IP ─► ADD_ROUTES ─► CONNECTED
     ▲                    │                                                                   │
     │                    └──────────── error / exit ─────────────┐                           │
     │                                                            ▼                           │
     │                                        retryable && autoReconnect ? RECONNECTING ◄─────┤ exit/crash
     │                                                            │ backoff 1,2,5,10,30,60s   │
     │                                                            ▼                           │
     └──────── DISCONNECTING ◄── disconnect() ──────────────── ERROR (non-retryable:          │
                                                                AUTH_FAILED, CERT_EXPIRED,    │
                                                                INVALID_CONFIG, ...)  ◄───────┘
```

OpenVPN management `STATE` names map 1:1 where they exist (`RESOLVE`/`TCP_CONNECT`
→ `CONNECTING`, `AUTH_PENDING` → `AUTH`, `EXITING` → `DISCONNECTING`).

## 3. OpenVPN integration

- **Binary**: `OpenVpnBinaryManager` resolves in order: user-chosen path → bundled
  `resources/openvpn/<platform>-<arch>/` → well-known system paths
  (`/opt/homebrew/sbin`, `/usr/local/sbin`, `C:\Program Files\OpenVPN\bin`) → `PATH`.
  Version from `openvpn --version`.
- **Launch** (args array, never a string):
  ```text
  --config <runtime.ovpn> --cd <profileDir>
  --management 127.0.0.1 <freePort> <mgmtPasswordFile>
  --management-hold --management-query-passwords
  [--pull-filter ignore redirect-gateway] [--route ...]   (routing policy)
  ```
- **Management port**: picked dynamically by binding `127.0.0.1:0`; unique per
  connection. A per-connection random password file (mode 0600, temp dir) protects the
  port from other local users, because openvpn runs privileged.
- **Management client** (`OpenVpnManagementClient`): line protocol parser handling
  `>STATE:`, `>LOG:`, `>BYTECOUNT:`, `>HOLD:`, `>PASSWORD:`, `>FATAL:`, `SUCCESS:`,
  `ERROR:` and multi-line `END` responses. After connect: `state on`, `log on all`,
  `bytecount 1`, then `hold release`.
- **Credentials** flow only over the management socket (`username "Auth" …`,
  `password "Private Key" …`), never over argv or env, never logged.
- **Runtime config**: the stored profile is not modified on connect; a runtime copy
  is generated in the connection temp dir when the routing/DNS policy needs to drop
  directives (e.g. `redirect-gateway` inside the file, which a CLI flag cannot remove).

## 4. Profiles

```text
<userData>/profiles/<profileId>/
    config.ovpn          normalized copy, external refs rewritten to local names
    ca.crt client.crt client.key ta.key ...
<userData>/profiles.json   metadata (no secrets)
<userData>/secrets.json    safeStorage ciphertext only
```

- `OpenVpnConfigParser` is a real tokenizer: quotes, backslash escapes, `#`/`;`
  comments, `<ca>…</ca>` inline blocks, Windows paths, relative paths. It can
  serialize back, which lets the importer rewrite paths without breaking anything else.
- Importer copies every referenced file (`ca`, `cert`, `key`, `pkcs12`, `tls-auth`,
  `tls-crypt`, `auth-user-pass <file>`, …) resolved relative to the source file.
- `ConfigSecurityScanner` flags `script-security`, `up`, `down`, `route-up`,
  `plugin`, etc., and reports positive checks (CA, client cert, TLS auth/crypt).
  The user must confirm "Import anyway".

## 5. Routing (multi-VPN safety)

- OpenVPN itself installs/removes the routes it is told to. The app decides **what**
  it is told, per connection:
  - `config` mode: routes from the config/server as-is.
  - `custom` mode: `pull-filter ignore` for `redirect-gateway`, `route`, `route-ipv6`,
    plus explicit `--route` entries for each user rule (CIDR/IP; hostnames resolved at
    connect time — documented limitation: if DNS changes, reconnect to refresh).
- **Default-route ownership**: at most one active VPN may own `0.0.0.0/0` (or
  `def1` halves). Before connecting a profile whose config wants
  `redirect-gateway`, `RouteConflictDetector` checks the current owner and asks the
  user: replace (reconnect the current owner with redirect ignored), keep, ignore for
  this connection, or switch to custom routes. Nothing changes silently.
- `RouteManager` reads the OS route table (macOS `netstat -rn`, Windows
  `Get-NetRoute`) and attributes each route to a connection by its interface, which
  powers the Route Inspector and crash cleanup (remove leftovers owned by a dead
  connection).

## 6. DNS

`DnsManager` (per platform) keeps per-connection ownership so restore is exact:

- macOS: one `scutil` key per connection (`State:/Network/Service/mov-<id>/DNS`).
  With `dhcp-option DOMAIN` it is a *supplemental* resolver (no conflict between
  VPNs); without domains it becomes a global override → only one owner allowed,
  others get a `DNS_CONFLICT` warning. Restore = delete our key (crash-safe: the
  helper removes orphaned `mov-*` keys at start).
- Windows: per-adapter DNS (set by openvpn / helper), NRPT rules for split domains.
- Modes per profile: `vpn`, `system` (pull-filter ignore `dhcp-option`), `custom`.

## 7. Privilege separation

| Platform | Helper install | Transport |
|---|---|---|
| macOS | Settings → Install helper: administrator prompt; the app bundle is copied to `/Library/Application Support/MultiOpenVPN/Helper.app` (root-owned), `helper.js --setup` writes the config, a launchd daemon `com.multiopenvpn.helper` runs it | unix socket `/var/run/multi-openvpn-helper.sock`, mode 0600, owned by the installing user |
| Windows | Windows Service registered by the installer (Phase 9) | named pipe `\\.\pipe\multi-openvpn-helper` |
| Dev | `npm run build && npm run helper:dev` (sudo, config in `.dev-helper/`) | `/tmp/mov-dev-<uid>.sock` |

The helper is `out/main/helper.js`, run by the app's own Electron binary with
`ELECTRON_RUN_AS_NODE=1`. It does not trust the app:

- **Auth**: first message must be `hello` with the install-time token (readable only by the
  installing user); compared in constant time.
- **Binary**: only OpenVPN binaries approved at install time, pinned by SHA-256 (re-install after
  upgrading OpenVPN).
- **Arguments**: `validateOpenVpnArgs` accepts exactly the grammar the app produces (`--cd`,
  `--config`, `--management 127.0.0.1 <port> <pwfile>`, pull filters, `--route`,
  `--route-ipv6`); every path must be inside the user's profile/temp roots (symlinks resolved).
- **Config**: copied into a root-owned run directory before validation (no TOCTOU);
  `plugin`, nested `config`, `iproute` are refused; file writers (`status`, `log`, `writepid`…)
  and script hooks are removed; file references must be plain names inside the profile folder;
  `--script-security 1` is always appended.
- **Session cleanup**: when the app disconnects (quit, crash) the helper stops that session's
  openvpn processes and restores their DNS. Its own children PIDs are persisted so a killed helper
  cleans up on restart.
- Route and DNS changes go through the helper; everything is validated again there.

Main uses the helper whenever it is connected (`HelperClient.launcher` for `VpnProcess`,
`HelperClient.platform()` for route/DNS changes) and falls back to direct, unprivileged execution
otherwise.

### Credentials

`CredentialStore` keeps remembered passwords as Electron `safeStorage` ciphertext (Keychain key on
macOS, DPAPI on Windows) in `secrets.json`; it refuses to store anything when only the Linux
"basic_text" fallback is available. A typed secret marked "Remember securely" is saved only after
the tunnel comes up; a remembered secret rejected by the server is deleted. Importing a profile
with `auth-user-pass <file>` moves that password to secure storage instead of copying the file.

## 8. Errors

`VpnErrorCode` (shared) + `LogClassifier` maps OpenVPN output to user-facing messages:
`AUTH_FAILED`, `TLS Error`, `Connection refused`, timeouts, `certificate has expired`,
route/DNS errors, missing binary, permission denied, process crash. The code decides
whether automatic reconnect is allowed.

## 9. Persistence

JSON files with atomic write (write temp + rename) under `app.getPath('userData')`.
SQLite was considered; the data set is tiny and a native module would need rebuilding
for three architectures. Passwords and private-key passwords are encrypted with
Electron `safeStorage` (Keychain-backed key on macOS, DPAPI on Windows) and stored
only as ciphertext.

## 10. Source layout

```text
src/
  main/       Electron main: index.ts, ipc/, vpn/, network/, platform/, security/, store/
  helper/     privileged helper entry (Phase 8)
  preload/    contextBridge whitelist (window.vpn)
  renderer/   React UI: pages/, components/, store/
  shared/     types, zod schemas, IPC contract, pure logic shared by both sides
tests/        vitest unit + multi-connection integration tests
resources/    bundled openvpn binaries per platform-arch, tray icons
```

## 11. Linux readiness

Platform specifics are behind `PlatformVpnService` / `DnsManager` / `RouteManager`
implementations chosen by `process.platform`. Linux needs a `platform/linux`
implementation (`ip route`, `resolvectl`) and a systemd helper unit; nothing else
changes.
