# Flexeree Carrier ACS — NOC Command Center

Enterprise & Carrier-Grade TR-069 Auto Configuration Server (ACS) and ISP Management Dashboard engineered for managing 1,000+ Syrotech GPON ONTs and multi-vendor CPE units.
<img width="1919" height="913" alt="image" src="https://github.com/user-attachments/assets/f24e4e64-daad-4db3-be16-158aea140ff1" />

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![TR-069](https://img.shields.io/badge/TR--069-CWMP%20v1.4-00d2ff.svg)
![GenieACS](https://img.shields.io/badge/GenieACS-v1.2.16-emerald.svg)
![NodeJS](https://img.shields.io/badge/Node.js-v20%2B-green.svg)
![MongoDB](https://img.shields.io/badge/MongoDB-v7.0%2B-forestgreen.svg)

---

## 🚀 Key Features

- **TR-069 / CWMP v1.4 Compliance:** Strictly adheres to TR-069 specs (SOAP/XML Inform handshakes, clean session terminations, 405 Method Not Allowed on HTTP GET).
- **Syrotech & Multi-Vendor GPON Support:** Tailored for Syrotech dual-band ONTs, Huawei, ZTE, and generic TR-098/TR-181 devices.
- **Bespoke Carrier NOC Command Center:** Zero generic AI tropes. High-density data layout, instant search, responsive controls, and custom SVG optical power telemetry (RX/TX dBm signal meters).
- **Carrier Provisioning Wizards:**
  - **WAN / PPPoE / VLAN:** 802.1Q VLAN tagging, priority, credentials, and custom DNS.
  - **Dual-Band Wi-Fi:** Independent 2.4 GHz and 5 GHz SSID, passphrase, and radio state management.
  - **Diagnostics:** Remote ping (`IPPingDiagnostics`) and traceroute (`TraceRouteDiagnostics`).
  - **Remote Actions:** Reboot, object refresh, and factory reset dispatch.
- **Zero-Touch Provisioning (ZTP):** Event-based preset rules (e.g., `0 BOOTSTRAP`, `1 BOOT`) for automated onboarding without manual technician intervention.
- **Role-Based Access Control (RBAC):** `Super Admin`, `Admin`, `Technician`, and `Viewer` with cryptographic audit trails (`portal_audit`).

---

## 🏗 System Architecture

```text
       +-----------------------------------------+
       |           Subscriber ONTs (CPE)         |
       +--------------------+--------------------+
                            | TR-069 SOAP (Port 7547)
                            v
       +--------------------+--------------------+
       |          GenieACS Engine (CWMP)         |
       |  - Port 7547: CWMP Service              |
       |  - Port 7557: Northbound API (NBI)      |
       |  - Port 7567: Firmware Storage (FS)     |
       +--------------------+--------------------+
                            |
           +----------------+----------------+
           | MongoDB (Storage & Engine Sync) |
           +----------------+----------------+
                            |
                            v
       +--------------------+--------------------+
       |       Portal Express Backend (4000)     |
       |  - JWT Authentication & RBAC            |
       |  - NBI Encoded Task URL Dispatcher      |
       |  - Audit Logging & Telemetry Collector  |
       +--------------------+--------------------+
                            |
                            v
       +--------------------+--------------------+
       |       Nginx Reverse Proxy & SSL (443)   |
       |  - /             -> Portal GUI (4000)   |
       |  - /genieacs-ui/ -> GenieACS Native UI  |
       +-----------------------------------------+
```

---

## 🛠 Quick Installation & Deployment

### 1. Prerequisites
- Ubuntu 22.04 LTS or 24.04 LTS
- Node.js 20+ & npm
- MongoDB 7.0+
- GenieACS 1.2.16+
- Nginx

### 2. Clone & Install Dependencies
```bash
git clone https://github.com/hasanzadekhalil/flexeree-carrier-acs.git
cd flexeree-carrier-acs
npm install
```

### 3. Environment Configuration
Create a `.env` file in the project root:
```env
PORT=4000
JWT_SECRET=your_super_secret_jwt_key_change_in_production
NBI_BASE=http://127.0.0.1:7557
MONGO_URI=mongodb://127.0.0.1:27017
DB_NAME=genieacs
```

### 4. Start the Application
```bash
npm start
```
Or manage via `systemd`:
```bash
sudo systemctl enable --now isp-portal
```

---

## 🧪 Comprehensive Automated Testing Suite

The repository includes a 20-point test suite covering protocol integrity, backend APIs, and carrier provisioning flows:

```bash
# 1. Deep Protocol & Health Tests (13 tests)
python tests/deep_test.py

# 2. Extended Carrier Provisioning Tests (7 tests)
python tests/extended_carrier_test.py
```

### Test Coverage Highlights:
- [x] CWMP Port 7547 HTTP GET 405 Method Not Allowed validation
- [x] SOAP Inform/InformResponse handshake and empty POST session completion
- [x] GenieACS NBI connection and device collection reachability
- [x] JWT authentication, invalid rejection, and `/auth/me` identity validation
- [x] Real-time optical power calculations (RX/TX dBm)
- [x] Remote reboot, diagnostics, and factory reset queueing (HTTP 202)
- [x] Immutable audit trail verification
- [x] Zero-Touch Provisioning (ZTP) preset injection
- [x] Automated MongoDB carrier backup routines

---

## 🔒 Security & Best Practices

- **Zero Hardcoded Secrets:** Passwords and JWT tokens are managed strictly via environment variables.
- **Session Locking Protection:** Test routines and provisioning scripts always complete the CWMP session to avoid locking CPE worker threads.
- **Role Authority Validation:** Technicians and Viewers are strictly blocked from destructive actions (e.g., Factory Reset, Staff Account Deletion).

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for details.
