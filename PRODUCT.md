# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary operators are ISP Network Operations Center (NOC) engineers, network administrators, and field support technicians managing 1,000+ subscriber GPON ONT/ONU devices across client networks.

## Product Purpose

A production-grade TR-069 / CWMP Auto Configuration Server (ACS) and ISP Management Portal for Flexeree ISP. It enables centralized remote provisioning, telemetry, diagnostics, WAN/Wi-Fi configuration, and lifecycle management for subscriber ONTs (primarily Syrotech GPON ONTs, with multi-vendor support).

## Positioning

A unified carrier-grade NOC interface sitting directly on top of GenieACS CWMP and MongoDB. Unlike raw GenieACS UI, it translates complex TR-069/TR-098 data models into one-click ISP operations: instant optical RX/TX power diagnostics, PPPoE/VLAN provisioning wizards, dual-band Wi-Fi management, and zero-touch auto-provisioning (ZTP).

## Operating Context

- **Environment:** ISP NOC command center screens, high-density table views, real-time subscriber diagnostics during support calls.
- **Workflow:** Real-time search by Serial/MAC/Customer/IP -> Instant optical power evaluation -> WAN/Wi-Fi adjustment -> Remote reboot/reset -> Automated audit trail.
- **Network Topography:** ONT devices communicate via TR-069 SOAP/XML on port 7547 (direct IP bypass), while operators access the web portal over HTTPS via Nginx reverse proxy.

## Capabilities and Constraints

- **Protocol:** TR-069 CWMP v1.4 via GenieACS backend (`genieacs-cwmp`, `genieacs-nbi`, `genieacs-fs`).
- **Core Capabilities:**
  - Auto-discovery and auto-registration of ONTs.
  - Live status tracking: Online / Offline / Last Inform with auto-refresh.
  - Optical power monitoring (RX / TX power in dBm with health threshold gauges).
  - One-click remote operations: Reboot, Factory Reset, Object Refresh.
  - WAN configuration wizard: PPPoE credentials, DHCP/Static, VLAN ID & 802.1p Priority, DNS.
  - Wi-Fi management wizard: 2.4GHz & 5GHz SSID, WPA2/WPA3 passphrase, radio enable/disable, channel assignment.
  - Network diagnostics: IPPingDiagnostics, TraceRouteDiagnostics.
  - Bulk actions across multi-selected devices.
  - Zero-Touch Provisioning (ZTP) presets triggered on `0 BOOTSTRAP` and `1 BOOT`.
  - Immutable audit logs of every operator action.
  - Role-Based Access Control (Super Admin, Admin, Technician, Viewer).
  - Daily automated MongoDB backups with retention policy.
- **Hardware Target:** Syrotech GPON ONTs (primary), extensible to Huawei, ZTE, Fiberhome via TR-098/TR-181 data models.

## Brand Commitments

- **Identity:** Flexeree ISP ACS Management Portal (`acs01.flexereeisp.com`).
- **Tone:** Dense, utilitarian, high-contrast carrier NOC command center. Crisp operational hierarchy.

## Evidence on Hand

- Backend API running on Node.js/Express (`/opt/isp-portal/server.js`, port 4000).
- GenieACS v1.2.16 microservices active on VPS `103.124.208.56` with MongoDB 7.
- Working prototype interface (`/opt/isp-portal/public/index.html`).
- Automated backup suite at `/opt/backups/acs/backup.sh`.

## Product Principles

1. **Zero Guesswork in Outages:** Optical power, WAN status, and device reachability must be visible within one click.
2. **Safety First on Carrier Actions:** Destructive actions (factory reset, bulk reboot, WAN rewrite) require confirmation with clear blast-radius warnings.
3. **High Density, Fast Scan:** Prioritize tabular data density and immediate status badges over empty decorative space.
4. **Audit Everything:** Every operator interaction, parameter change, and remote task dispatch must produce an immutable audit log entry.
