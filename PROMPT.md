# Xây dựng ứng dụng OpenVPN Multi-Profile Client cho macOS và Windows

Hãy thiết kế và phát triển một ứng dụng desktop quản lý OpenVPN với mục tiêu:

- Chạy trên macOS và Windows.
- Import nhiều file OpenVPN `.ovpn`.
- Có thể kết nối nhiều profile VPN cùng lúc.
- Mỗi profile chạy độc lập.
- Theo dõi trạng thái, IP, log, thời gian kết nối của từng profile.
- Có thể connect/disconnect/reconnect từng VPN riêng biệt.
- Có giao diện trực quan tương tự các VPN Client hiện đại.

## 1. Technology Stack

Ưu tiên sử dụng:

### Desktop

- Electron.js
- Node.js
- TypeScript
- React
- Vite

UI:

- TailwindCSS
- shadcn/ui hoặc component system tương tự
- Lucide Icons

Backend desktop:

- Node.js child_process
- OpenVPN Community binary

Không tự implement OpenVPN protocol.

Ứng dụng chỉ đóng vai trò:

```text
GUI
  ↓
VPN Manager
  ↓
OpenVPN Process Manager
  ↓
openvpn binary
  ↓
TUN/TAP / Routing
```

Mỗi VPN connection phải là một OpenVPN process riêng biệt.

Ví dụ:

```text
OpenVPN Client App
│
├── Profile A
│      └── openvpn process PID 1001
│
├── Profile B
│      └── openvpn process PID 1002
│
├── Profile C
│      └── openvpn process PID 1003
│
└── Profile D
       └── openvpn process PID 1004
```

Tuyệt đối không giới hạn app ở một VPN connection duy nhất.

---

# 2. Platforms

Ứng dụng phải hỗ trợ:

```text
macOS
  Intel x64
  Apple Silicon arm64

Windows
  x64
```

Thiết kế architecture để về sau có thể hỗ trợ Linux.

Tạo abstraction:

```ts
interface PlatformVpnService {
    connect(profile: VpnProfile): Promise<VpnConnection>;
    disconnect(connectionId: string): Promise<void>;
    reconnect(connectionId: string): Promise<void>;

    getInterfaces(): Promise<NetworkInterface[]>;
    getRoutes(): Promise<RouteInfo[]>;

    addRoute(route: RouteConfig): Promise<void>;
    removeRoute(route: RouteConfig): Promise<void>;
}
```

Implement riêng:

```text
platform/
    macos/
        MacOSVpnService.ts

    windows/
        WindowsVpnService.ts
```

---

# 3. OpenVPN Binary

Ứng dụng sử dụng OpenVPN Community Client.

Cho phép 2 chế độ.

### Bundled OpenVPN

Đóng gói OpenVPN binary cùng ứng dụng:

```text
resources/
    openvpn/
        macos-x64/
        macos-arm64/
        windows-x64/
```

### System OpenVPN

Cho phép user chọn OpenVPN binary đã cài trên máy.

Settings:

```text
OpenVPN binary:

[ Auto detect ]

Detected:

/opt/homebrew/sbin/openvpn

[ Browse... ]
```

Windows có thể kiểm tra:

```text
C:\Program Files\OpenVPN\bin\openvpn.exe
```

macOS:

```text
/usr/local/sbin/openvpn
/opt/homebrew/sbin/openvpn
```

Không hard-code duy nhất một path.

---

# 4. Profile Management

Cho phép import:

```text
.ovpn
.conf
```

Import bằng:

- Browse file
- Drag & drop
- Import nhiều file cùng lúc

Mỗi profile lưu:

```ts
interface VpnProfile {
    id: string;

    name: string;

    configPath: string;

    username?: string;

    password?: string;

    autoConnect: boolean;

    reconnect: boolean;

    routingMode: 'config' | 'custom';

    customRoutes?: RouteRule[];

    dnsMode: 'vpn' | 'system' | 'custom';

    dnsServers?: string[];

    createdAt: Date;

    updatedAt: Date;
}
```

UI cho phép:

```text
Rename
Duplicate
Delete
Edit config
View config
Export profile
```

Sensitive data phải được lưu bằng secure storage của OS.

Ví dụ:

macOS:

```text
Keychain
```

Windows:

```text
Credential Manager / DPAPI
```

Không lưu password plaintext trong JSON.

---

# 5. Main Requirement: Multiple VPN Connections

Đây là yêu cầu quan trọng nhất.

User phải có thể:

```text
VPN A → Connected
VPN B → Connected
VPN C → Connected
```

đồng thời.

Mỗi VPN sử dụng:

```text
1 OpenVPN process
1 management port
1 log stream
1 PID
1 virtual interface
```

Ví dụ:

```ts
interface VpnConnection {
    id: string;

    profileId: string;

    pid: number;

    managementPort: number;

    status: VpnStatus;

    startedAt: Date;

    assignedIp?: string;

    publicIp?: string;

    interfaceName?: string;

    gateway?: string;

    bytesIn: number;

    bytesOut: number;
}
```

VPN process manager:

```text
VpnProcessManager
    ├── connection-uuid-A
    │       ├── pid
    │       ├── management socket
    │       └── log parser
    │
    ├── connection-uuid-B
    │       ├── pid
    │       ├── management socket
    │       └── log parser
    │
    └── connection-uuid-C
            ├── pid
            ├── management socket
            └── log parser
```

Không sử dụng singleton OpenVPN process.

---

# 6. OpenVPN Management Interface

Ưu tiên quản lý OpenVPN thông qua OpenVPN Management Interface thay vì chỉ parse stdout.

Khi start VPN:

```bash
openvpn \
  --config profile.ovpn \
  --management 127.0.0.1 RANDOM_PORT \
  --management-query-passwords \
  --management-hold
```

Tạo một management port riêng cho từng VPN.

Ví dụ:

```text
VPN A
127.0.0.1:25101

VPN B
127.0.0.1:25102

VPN C
127.0.0.1:25103
```

Port phải được lấy dynamic từ free local TCP port.

Thông qua management interface lấy:

```text
state
status
bytecount
log
hold
signal SIGTERM
username
password
```

Theo dõi state:

```text
CONNECTING
WAIT
AUTH
GET_CONFIG
ASSIGN_IP
ADD_ROUTES
CONNECTED
RECONNECTING
DISCONNECTING
DISCONNECTED
ERROR
```

---

# 7. Connection Dashboard

Main window hiển thị dạng cards.

Ví dụ:

```text
┌────────────────────────────────────────────┐
│ Company Singapore                         │
│ ● CONNECTED                               │
│                                            │
│ VPN IP        10.8.0.12                   │
│ Interface     utun5                       │
│ Gateway       10.8.0.1                    │
│                                            │
│ ↓ 12.6 MB      ↑ 3.1 MB                   │
│                                            │
│ Connected  01:24:36                       │
│                                            │
│ [Logs]               [Disconnect]         │
└────────────────────────────────────────────┘
```

Có nhiều card cùng lúc:

```text
Company Singapore       CONNECTED

Development VPN         CONNECTED

Office VPN              CONNECTING

Test VPN                DISCONNECTED
```

---

# 8. Sidebar

Sidebar:

```text
Dashboard

Profiles

Connections

Routes

Network Interfaces

Logs

Settings
```

Phía dưới hiển thị:

```text
OpenVPN
Version 2.x.x

Active connections: 3
```

---

# 9. Profile List

Trang Profiles:

```text
Profiles

Search...

┌──────────────────────────────────────────────┐
│ Singapore                                    │
│ sg-company.ovpn                              │
│                                              │
│ Last connected: 10 minutes ago              │
│                                              │
│ [Connect] [...]                             │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ Office                                       │
│ office.ovpn                                  │
│                                              │
│ ● Connected                                 │
│                                              │
│ [Disconnect] [...]                          │
└──────────────────────────────────────────────┘
```

Cho phép multi-select:

```text
[x] VPN A
[x] VPN B
[x] VPN C

[Connect Selected]
```

Và:

```text
[Disconnect All]
```

---

# 10. Routing

Đây là phần đặc biệt quan trọng khi chạy nhiều OpenVPN cùng lúc.

Không được giả định tất cả VPN đều có thể sử dụng:

```text
redirect-gateway def1
```

vì nhiều VPN cùng thay default route sẽ conflict.

Phải detect:

```text
redirect-gateway
redirect-gateway def1
route
route-ipv6
dhcp-option DNS
```

trong profile.

Nếu profile thứ hai cố thay default route khi đã có một VPN default-route đang active, hiển thị cảnh báo:

```text
Route Conflict

VPN "Office" wants to change the system default route.

Current default VPN:

Singapore VPN

Choose routing mode:

( ) Replace current default VPN
( ) Keep current default VPN
( ) Ignore redirect-gateway for this connection
( ) Configure custom routes
```

Không tự động thay đổi route một cách khó đoán.

---

# 11. Split Tunneling

Mỗi VPN có routing settings.

Ví dụ:

```text
Routing

○ Use routes from OpenVPN configuration

○ Custom routing

    10.10.0.0/16
        → this VPN

    172.16.20.0/24
        → this VPN

    192.168.10.55/32
        → this VPN
```

Cho phép add:

```text
CIDR
IP
Hostname
```

Ví dụ:

```text
10.20.0.0/16
192.168.1.100/32
internal.company.com
```

Với hostname cần resolve và document rõ limitations khi IP thay đổi.

---

# 12. Multi VPN Routing Example

Ví dụ user chạy:

```text
VPN Singapore

10.20.0.0/16 → VPN Singapore
```

và:

```text
VPN Office

172.16.0.0/16 → VPN Office
```

Internet bình thường:

```text
0.0.0.0/0 → local ISP
```

Kết quả:

```text
Internet
    ↓
local network

10.20.x.x
    ↓
VPN Singapore

172.16.x.x
    ↓
VPN Office
```

Architecture phải support use case này.

---

# 13. Interface Detection

App phải detect virtual interface của từng VPN.

macOS thường:

```text
utun0
utun1
utun2
...
```

Windows có thể:

```text
Wintun
TAP-Windows
OpenVPN Data Channel Offload
```

Mapping:

```text
profile
    ↓
openvpn process
    ↓
virtual interface
```

Không giả định interface name cố định.

---

# 14. Route Inspector

Tạo trang:

```text
Routes
```

Hiển thị:

```text
Destination         Gateway        Interface      Source

default             192.168.1.1    en0            System

10.10.0.0/16        10.8.0.1       utun4          Office VPN

172.16.0.0/16       10.9.0.1       utun5          Dev VPN
```

Highlight VPN sở hữu route.

Cho phép filter theo:

```text
All
System
VPN A
VPN B
VPN C
```

---

# 15. Network Interfaces

Trang:

```text
Network Interfaces
```

Hiển thị:

```text
en0

192.168.1.10

Wi-Fi

----------------

utun4

10.8.0.12

VPN: Office

----------------

utun5

10.9.0.8

VPN: Development
```

---

# 16. DNS

Multiple VPN có thể conflict DNS.

Mỗi profile có:

```text
DNS mode:

○ Use VPN DNS
○ Keep system DNS
○ Custom DNS
```

Custom:

```text
1.1.1.1
8.8.8.8
```

Nếu nhiều active VPN cố thay global DNS:

show warning.

Thiết kế DNS manager abstraction:

```ts
interface DnsManager {
    getCurrentDns(): Promise<string[]>;

    setDns(
        connectionId: string,
        servers: string[]
    ): Promise<void>;

    restore(
        connectionId: string
    ): Promise<void>;
}
```

Phải restore DNS đúng khi VPN disconnect/crash.

---

# 17. Authentication

Support:

```text
auth-user-pass
```

Nếu cần username/password:

hiển thị dialog:

```text
VPN Authentication

Username
[                   ]

Password
[                   ]

[x] Remember securely

[Connect]
```

Nếu profile yêu cầu private key password:

support:

```text
Private Key Password
```

Không log password.

Không truyền credentials qua command-line arguments nếu có thể tránh vì process list có thể expose dữ liệu.

Ưu tiên management interface.

---

# 18. Certificates

Support `.ovpn` dạng inline:

```text
<ca>
...
</ca>

<cert>
...
</cert>

<key>
...
</key>
```

và external:

```text
ca ca.crt
cert client.crt
key client.key
```

Khi import profile có external dependency, app phải copy toàn bộ resource liên quan vào thư mục profile.

Ví dụ:

```text
profiles/
   uuid/
       config.ovpn
       ca.crt
       client.crt
       client.key
```

Update path trong config nếu cần.

Không làm hỏng relative path.

---

# 19. Logging

Mỗi VPN có log riêng.

Ví dụ:

```text
17:32:10 Initializing OpenVPN

17:32:10 Connecting to 1.2.3.4:1194

17:32:11 TLS handshake

17:32:12 Authentication successful

17:32:13 Interface utun5 created

17:32:13 VPN IP: 10.8.0.5

17:32:14 Initialization Sequence Completed
```

UI:

```text
Logs

Profile:
[Office VPN ▼]

Level:
[All ▼]

Search:
[......................]

[x] Auto scroll

[Clear]
[Export]
```

Log parser phải detect ít nhất:

```text
AUTH_FAILED
TLS Error
Connection refused
Connection timeout
Initialization Sequence Completed
SIGTERM
route error
DNS error
certificate expired
```

Map sang error message dễ hiểu.

---

# 20. Connection Metrics

Theo dõi:

```text
download bytes
upload bytes
connection duration
reconnect count
```

Nếu OpenVPN management interface hỗ trợ:

```text
bytecount
```

thì dùng nó.

UI cập nhật realtime.

---

# 21. Public IP

Cho phép tùy chọn:

```text
Check Public IP
```

Sau khi VPN connect:

```text
Public IP

103.xxx.xxx.xxx

Country
Singapore
```

Quan trọng:

Trong môi trường multi-VPN, public IP request không nhất thiết đi qua đúng VPN.

Nếu implement feature này phải bind socket/request vào VPN interface hoặc sử dụng route phù hợp.

Nếu không thể đảm bảo chính xác thì không được hiển thị dữ liệu gây hiểu nhầm.

---

# 22. Kill / Crash Handling

Nếu OpenVPN process crash:

```text
CONNECTED
    ↓
PROCESS_EXIT
    ↓
DISCONNECTED / ERROR
```

App phải:

- detect process exit
- remove associated routes
- restore DNS
- cleanup management port
- cleanup temporary files
- update UI

Nếu setting:

```text
Auto reconnect
```

enabled:

thực hiện exponential backoff:

```text
1s
2s
5s
10s
30s
60s max
```

Không reconnect vô hạn khi:

```text
AUTH_FAILED
CERT_EXPIRED
INVALID_CONFIG
```

---

# 23. Disconnect

Khi user click Disconnect:

Ưu tiên management command:

```text
signal SIGTERM
```

Chờ graceful shutdown.

Nếu process không thoát:

```text
SIGTERM
↓
timeout
↓
force kill
```

Sau đó:

```text
cleanup routes

restore DNS

cleanup interface if necessary

release management port
```

---

# 24. App Exit

Nếu user đóng app trong khi VPN vẫn active:

Hiển thị:

```text
3 VPN connections are currently active.

What would you like to do?

[Disconnect All & Quit]

[Keep Running in Background]

[Cancel]
```

Support system tray.

Tray menu:

```text
Open VPN Manager

----------------

Office VPN
● Connected

Development
● Connected

Singapore
○ Disconnected

----------------

Disconnect All

Open Dashboard

Quit
```

---

# 25. Auto Connect

Per profile:

```text
Auto connect on app startup
```

Có setting:

```text
Start app when operating system starts
```

App khởi động có thể connect nhiều VPN:

```text
Office
Development
Staging
```

cùng lúc.

---

# 26. Privileges

OpenVPN có thể cần administrator/root privileges để tạo interface hoặc route.

Không chạy toàn bộ Electron app dưới quyền admin/root nếu không cần thiết.

Thiết kế privilege separation.

Ví dụ:

```text
Electron UI
     │
     │ IPC
     ↓
VPN Service
     │
     ↓
Privileged Helper
     │
     ↓
OpenVPN / Route Commands
```

Mục tiêu:

```text
UI → normal user

network operations → elevated helper
```

macOS nghiên cứu:

```text
Authorization Services
SMAppService
privileged helper
```

Windows:

```text
Windows Service
UAC
```

Không spawn shell commands trực tiếp từ renderer process.

---

# 27. Security

Electron:

```text
contextIsolation: true

nodeIntegration: false

sandbox: true
```

Sử dụng preload với whitelist IPC API.

Ví dụ:

```ts
window.vpn.connect(profileId)

window.vpn.disconnect(connectionId)

window.vpn.getConnections()

window.vpn.getLogs(connectionId)
```

Không expose:

```text
child_process
fs
shell
exec
```

sang renderer.

Validate toàn bộ IPC input bằng Zod.

---

# 28. Command Injection

Không build OpenVPN command bằng string.

Không dùng:

```ts
exec(`openvpn ${userInput}`)
```

Sử dụng:

```ts
spawn(openvpnPath, args)
```

Ví dụ:

```ts
spawn(
    openvpnPath,
    [
        '--config',
        configPath,

        '--management',
        '127.0.0.1',
        String(port)
    ],
    {
        shell: false
    }
);
```

Validate path trước khi sử dụng.

---

# 29. Config Parser

Viết parser `.ovpn`.

Không chỉ đơn giản:

```text
split(' ')
```

Phải handle:

```text
quotes
comments
inline blocks
escaped paths
Windows paths
relative paths
```

Parse các directives quan trọng:

```text
remote

proto

dev

auth-user-pass

ca

cert

key

pkcs12

tls-auth

tls-crypt

redirect-gateway

route

route-ipv6

dhcp-option

script-security

up

down
```

Nếu phát hiện:

```text
script-security
up
down
route-up
plugin
```

show security warning vì config có khả năng thực thi command/plugin.

---

# 30. Profile Security Scanner

Khi import `.ovpn`:

scan config.

Ví dụ:

```text
Profile Security

✓ CA certificate

✓ Client certificate

✓ TLS enabled

⚠ This profile contains:

script-security 2
up ./script.sh

This configuration may execute local commands.

[Cancel]

[Import Anyway]
```

---

# 31. Dashboard Statistics

Header:

```text
OpenVPN Manager

3 Active Connections
```

Summary:

```text
ACTIVE VPN
3

DOWNLOAD
1.24 GB

UPLOAD
230 MB
```

Không cần quá nhiều analytics.

Ưu tiên network management.

---

# 32. Error Handling

Define:

```ts
enum VpnErrorCode {
    AUTH_FAILED,
    TLS_ERROR,
    CERT_EXPIRED,
    NETWORK_UNREACHABLE,
    CONNECTION_TIMEOUT,
    ROUTE_CONFLICT,
    DNS_CONFLICT,
    OPENVPN_NOT_FOUND,
    INVALID_CONFIG,
    PERMISSION_DENIED,
    PROCESS_CRASHED,
    UNKNOWN
}
```

UI phải hiển thị message rõ ràng.

Ví dụ:

```text
Authentication Failed

The VPN server rejected your username or password.

[Retry]

[Edit Credentials]

[View Logs]
```

---

# 33. Persistence

Có thể sử dụng SQLite.

Database:

```text
profiles
connections_history
settings
custom_routes
```

Không lưu:

```text
password
private key password
```

trong SQLite plaintext.

Sensitive secrets dùng:

```text
macOS Keychain
Windows Credential Manager / DPAPI
```

---

# 34. Suggested Project Structure

```text
src/

main/
    index.ts

    vpn/
        VpnManager.ts

        VpnProcess.ts

        VpnProcessManager.ts

        OpenVpnManagementClient.ts

        OpenVpnBinaryManager.ts

        OpenVpnConfigParser.ts

    network/
        RouteManager.ts

        DnsManager.ts

        InterfaceManager.ts

    platform/

        macos/
            MacNetworkService.ts

        windows/
            WindowsNetworkService.ts

    security/
        CredentialStore.ts

        ConfigSecurityScanner.ts

    ipc/
        vpn.ipc.ts

        profile.ipc.ts

        network.ipc.ts

preload/

renderer/

    pages/

        Dashboard/

        Profiles/

        Connections/

        Routes/

        Interfaces/

        Logs/

        Settings/

    components/

shared/

    models/

    types/

    schemas/
```

---

# 35. State Architecture

Central state:

```text
profiles

connections

networkInterfaces

routes

settings
```

Connection state phải index bằng:

```text
connectionId
```

không phải global:

```text
vpnConnected: boolean
```

Sai:

```ts
const [connected, setConnected] = useState(false);
```

Đúng:

```ts
connections = {
    connectionA: {
        profileId: "...",
        status: "CONNECTED"
    },

    connectionB: {
        profileId: "...",
        status: "CONNECTED"
    }
}
```

Đây là yêu cầu bắt buộc để multi-VPN hoạt động đúng.

---

# 36. Testing

Viết unit tests cho:

```text
OVPN parser

route parser

route conflict detector

management protocol parser

VPN state machine

profile importer

security scanner
```

Integration test:

```text
start VPN A

start VPN B

verify:
    A remains connected
    B remains connected
```

Test:

```text
VPN A disconnect

VPN B must remain connected
```

Test:

```text
VPN A crashes

VPN B must remain connected
```

Đây là requirement quan trọng.

---

# 37. Mock VPN Mode

Development environment nên có:

```text
VPN_MOCK_MODE=true
```

để dev frontend mà không cần VPN server thật.

Mock state:

```text
CONNECTING
↓
AUTH
↓
ASSIGN_IP
↓
CONNECTED
```

Random traffic:

```text
↓ 1.4 MB/s

↑ 320 KB/s
```

---

# 38. Build

Electron Builder.

Build output:

macOS:

```text
.dmg

.zip
```

Windows:

```text
.exe installer

portable .exe
```

Architecture:

```text
macOS x64

macOS arm64

Windows x64
```

---

# 39. Development Phases

Không code toàn bộ project trong một lần.

Thực hiện từng phase.

## Phase 1 — Foundation

Tạo:

```text
Electron
React
TypeScript
Tailwind
IPC architecture
```

Implement mock VPN.

Hoàn thiện basic UI.

---

## Phase 2 — OpenVPN Runner

Implement:

```text
OpenVpnBinaryManager

VpnProcess

VpnProcessManager
```

Có thể:

```text
connect

disconnect

multiple concurrent process
```

Chưa cần complex routing.

---

## Phase 3 — Management Interface

Implement:

```text
OpenVpnManagementClient
```

Theo dõi:

```text
state

logs

bytecount

authentication
```

---

## Phase 4 — Profiles

Implement:

```text
import .ovpn

parser

profile storage

certificate dependencies
```

---

## Phase 5 — Multi VPN

Đảm bảo:

```text
VPN A
VPN B
VPN C
```

có thể chạy đồng thời.

Test isolation của:

```text
process
management port
logs
state
interface
```

---

## Phase 6 — Routing

Implement:

```text
RouteManager

route ownership

route conflict detection

split tunnel
```

Đây là phase quan trọng nhất sau multi-process.

---

## Phase 7 — DNS

Implement:

```text
DNS Manager

conflict handling

restore DNS
```

---

## Phase 8 — Security

Implement:

```text
Keychain

Credential Manager

privileged helper

config scanner
```

---

## Phase 9 — Production Build

Implement:

```text
system tray

auto start

auto connect

installer

code signing preparation
```

---

# 40. UX Requirement

Thiết kế theo phong cách:

```text
GitKraken
Docker Desktop
Tailscale
ProtonVPN
```

Nhưng giao diện đơn giản hơn.

Dark / Light mode.

Main view tập trung vào:

```text
VPN Profiles
Active VPNs
Connection Status
Routes
Logs
```

Không làm UI quá nhiều hiệu ứng.

Ưu tiên:

```text
rõ ràng
nhanh
dễ debug
dễ quản lý nhiều VPN
```

---

# 41. Critical Requirements

Các yêu cầu sau là bắt buộc:

1. Không tự implement OpenVPN protocol.

2. Sử dụng OpenVPN Community binary.

3. Một connection = một OpenVPN process riêng.

4. Support nhiều VPN đồng thời.

5. Một VPN disconnect/crash không được ảnh hưởng VPN khác.

6. Mỗi VPN có management interface riêng.

7. Mỗi VPN có log riêng.

8. Detect interface của từng VPN.

9. Detect route conflict.

10. Không để nhiều VPN âm thầm tranh default route.

11. Support split tunneling.

12. Quản lý DNS conflict.

13. Restore route/DNS khi VPN crash.

14. Không chạy Electron renderer với quyền admin.

15. Credentials phải lưu secure storage.

16. Không truyền password bằng command line nếu tránh được.

17. Không dùng shell command có user input.

18. App phải support macOS Intel, macOS Apple Silicon và Windows x64.

---

# 42. Expected Workflow

Ví dụ cuối cùng user có thể:

Import:

```text
company.ovpn

development.ovpn

office.ovpn

staging.ovpn
```

Sau đó:

```text
Company
[Connect]

Development
[Connect]

Office
[Connect]

Staging
[Connect]
```

Dashboard:

```text
4 Active Connections

Company
● Connected
10.8.0.10
utun4

Development
● Connected
10.9.0.12
utun5

Office
● Connected
10.10.0.15
utun6

Staging
● Connected
10.11.0.8
utun7
```

Routing:

```text
10.10.0.0/16
→ Company

172.16.0.0/16
→ Development

192.168.50.0/24
→ Office

10.100.0.0/16
→ Staging

default
→ Local Internet
```

Đây là use case cốt lõi của sản phẩm.

---

# 43. Coding Instructions

Khi bắt đầu implementation:

1. Phân tích architecture trước.
2. Tạo `ARCHITECTURE.md`.
3. Tạo `DEVELOPMENT_PLAN.md`.
4. Tạo project structure.
5. Chỉ sau đó mới implement Phase 1.
6. Sau mỗi phase phải chạy build/typecheck/test.
7. Sửa tất cả lỗi trước khi sang phase tiếp theo.
8. Không tạo placeholder nếu có thể implement thực tế.
9. Không bỏ qua error handling.
10. Code phải production-oriented, modular và dễ mở rộng.

Sau mỗi phase hãy báo cáo:

```text
Completed

Changed files

Architecture decisions

How to test

Known limitations

Next phase
```

Sau đó tiếp tục phase kế tiếp.