const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { MongoClient, ObjectId } = require('mongodb');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const app = express();
const PORT = 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'flexeree_secret_key_2026_secure';
const NBI_BASE = process.env.NBI_BASE || 'http://127.0.0.1:7557';
const FS_BASE  = process.env.FS_BASE  || 'http://127.0.0.1:7567';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'genieacs';

// Online threshold: device counts as online if it informed within the
// last 10 minutes. This covers the ONT-side PeriodicInformInterval (300s
// default) plus jitter. "Active in last 5 sec" style windows are handled
// client-side with the returned _lastInform timestamps instead.
const ONLINE_THRESHOLD_MS = 10 * 60 * 1000;

// CWMP namespace accepted on public port. GenieACS on the VPS sits on
// :7548 after this; the Python proxy on :7547 rewrites cwmp-1-4 → 1-3.
const PUBLIC_CWMP_URL = 'http://103.124.208.56:7547';

app.use(cors());
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let db;
let _initError = null;

async function initDB() {
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 4000 });
  await client.connect();
  db = client.db(DB_NAME);

  const usersCol = db.collection('portal_users');
  const admin = await usersCol.findOne({ username: 'admin' });
  if (!admin) {
    const hash = await bcrypt.hash('admin123', 10);
    await usersCol.insertOne({
      username: 'admin',
      passwordHash: hash,
      role: 'Super Admin',
      fullName: 'Flexeree Administrator',
      createdAt: new Date()
    });
  }
  await db.collection('portal_audit').createIndex({ timestamp: -1 });
}

async function logAudit(user, action, target, details, status = 'SUCCESS') {
  try {
    if (!db) return;
    await db.collection('portal_audit').insertOne({
      user: user ? user.username : 'system',
      role: user ? user.role : 'system',
      action, target, details, status,
      timestamp: new Date()
    });
  } catch (e) {
    console.error('Audit log failed:', e.message);
  }
}

async function getDeviceTasksUrl(devId, immediate = true) {
  if (!db) return '/devices/' + encodeURIComponent(devId) + '/tasks' + (immediate ? '?connection_request' : '');
  // Resolve display/serial/encoded ids to the real GenieACS _id. GenieACS
  // _ids look like OUI-ProductClass-Serial with '-' percent-encoded as %2D.
  let doc = await db.collection('devices').findOne({ _id: devId });
  if (!doc) {
    const decoded = (() => { try { return decodeURIComponent(devId); } catch { return devId; } })();
    const encoded = encodeURIComponent(decoded).replace(/\(/g, '%28').replace(/\)/g, '%29');
    const parts = decoded.split('-');
    const serial = parts[parts.length - 1];
    const candidates = [...new Set([decoded, encoded, serial])];
    doc = await db.collection('devices').findOne({
      $or: [
        ...candidates.map(c => ({ _id: c })),
        ...candidates.map(c => ({ '_deviceId._SerialNumber': c }))
      ]
    });
  }
  const realId = doc ? doc._id : devId;
  return '/devices/' + encodeURIComponent(realId) + '/tasks' + (immediate ? '?connection_request' : '');
}

function nbiRequest(method, urlPath, body = null, base = NBI_BASE) {
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(urlPath, base);
    const options = {
      hostname: fullUrl.hostname,
      port: fullUrl.port,
      path: urlPath,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null });
        } catch (err) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('NBI request timed out')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = auth.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token invalid or expired' });
  }
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }
    next();
  };
}

// ---------- helpers ----------
function csvEscape(s) {
  if (s === null || s === undefined) return '';
  const str = String(s);
  if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}
function toCSV(rows, headers) {
  const head = headers.join(',');
  const body = rows.map(r => headers.map(h => csvEscape(r[h])).join(',')).join('\n');
  return head + '\n' + body + '\n';
}
function xmlSafe(v) {
  return String(v).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function toExcelXml(rows, headers, title = 'Export') {
  let xml = '<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>';
  xml += '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">';
  xml += `<Styles><Style ss:ID="h"><Font ss:Bold="1"/></Style></Styles>`;
  xml += `<Worksheet ss:Name="${xmlSafe(title)}"><Table><Row>`;
  headers.forEach(h => xml += `<Cell ss:StyleID="h"><Data ss:Type="String">${xmlSafe(h)}</Data></Cell>`);
  xml += '</Row>';
  rows.forEach(r => {
    xml += '<Row>';
    headers.forEach(h => xml += `<Cell><Data ss:Type="String">${xmlSafe(r[h])}</Data></Cell>`);
    xml += '</Row>';
  });
  xml += '</Table></Worksheet></Workbook>';
  return xml;
}

// ---------- AUTH ----------
app.post('/api/auth/login', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database initializing...' });
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username & password required' });
    const user = await db.collection('portal_users').findOne({ username });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({
      id: user._id, username: user.username, role: user.role, fullName: user.fullName
    }, JWT_SECRET, { expiresIn: '12h' });
    logAudit(user, 'LOGIN', 'auth', 'Successful dashboard login');
    res.json({
      token,
      user: { username: user.username, role: user.role, fullName: user.fullName }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// ---------- CONFIG (CWMP URL etc) ----------
app.get('/api/config', authenticate, (req, res) => {
  res.json({
    cwmpUrl: PUBLIC_CWMP_URL,
    onlineThresholdMs: ONLINE_THRESHOLD_MS,
    nbi: NBI_BASE,
    fs: FS_BASE
  });
});

// ---------- STATS ----------
app.get('/api/dashboard/stats', authenticate, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database initializing...' });
    const devices = await db.collection('devices').find({}).toArray();
    const total = devices.length;
    const now = Date.now();
    let online = 0, offline = 0;
    const modelsMap = {}, vendorsMap = {};
    devices.forEach(d => {
      const lastInform = d._lastInform ? new Date(d._lastInform).getTime() : 0;
      const isOnline = lastInform && (now - lastInform) <= ONLINE_THRESHOLD_MS;
      if (isOnline) online++; else offline++;
      const model = (d._deviceId && d._deviceId._ProductClass) || 'Generic ONT';
      const vendor = (d._deviceId && d._deviceId._Manufacturer) || 'Syrotech';
      modelsMap[model] = (modelsMap[model] || 0) + 1;
      vendorsMap[vendor] = (vendorsMap[vendor] || 0) + 1;
    });
    const recentEvents = await db.collection('portal_audit').find().sort({ timestamp: -1 }).limit(10).toArray();
    res.json({
      total, online, offline,
      onlineThresholdMs: ONLINE_THRESHOLD_MS,
      models: modelsMap, vendors: vendorsMap, recentEvents
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- DEVICES ----------
// Deep search: device trees nest params 4-6 levels deep (e.g.
// WANDevice.1.X_CT-COM_EponInterfaceConfig.RXPower), so a top-level
// scan always missed RX/TX/PPPoE/WAN_IP. Walk the whole tree.
function findParam(obj, suffix) {
  if (!obj) return null;
  const all = findAllParamsEndingWith(obj, suffix);
  return all.length ? all[0].value : null;
}
function findAllParamsEndingWith(root, suffix) {
  const out = [];
  function walk(o, prefix) {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      if (k.startsWith('_')) continue;
      const v = o[k];
      const path = prefix ? prefix + '.' + k : k;
      // Case-insensitive: vendors mix RxPower / RXPower / RxOpticalPower,
      // and an exact-case endsWith silently missed whole models.
      if (path.toLowerCase().endsWith(String(suffix).toLowerCase()) && v && v._value !== undefined) {
        out.push({ path, value: v._value });
      } else if (v && typeof v === 'object') {
        walk(v, path);
      }
    }
  }
  walk(root, '');
  return out;
}

// Band label for a WLANConfiguration instance, from live vendor params
// (proven on hardware): Syrotech X_CT-COM_RFBand 1=5GHz / 0=2.4GHz,
// TP-Link X_TP_Band '5GHz'/'2.4GHz'. Falls back to Standard/SSID hints.
function wifiBandOf(w, ssid) {
  const rf = w && w['X_CT-COM_RFBand'] && w['X_CT-COM_RFBand']._value;
  if (rf !== undefined && rf !== null && String(rf) !== '') {
    return String(rf) === '1' ? '5GHz' : '2.4GHz';
  }
  const tp = w && w['X_TP_Band'] && w['X_TP_Band']._value;
  if (tp) {
    const s = String(tp);
    if (/5/.test(s)) return '5GHz';
    if (/2\.4/.test(s)) return '2.4GHz';
    return s;
  }
  const std = w && w['Standard'] && w['Standard']._value;
  if (std) {
    const s = String(std).toLowerCase();
    if (s.includes('ac') || s.includes('ax')) return '5GHz';
  }
  const nm = String(ssid || '').toLowerCase();
  if (/5\s?g/.test(nm)) return '5GHz';
  if (/2\.4|2\s?g/.test(nm)) return '2.4GHz';
  return null;
}
// First Ethernet MAC under LANDevice (stable device identity for search /
// table), else any MACAddress in the tree, upper-cased.
function deviceMac(igd) {
  const lan = igd && igd.LANDevice;
  const m1 = lan && findParam(lan, 'MACAddress');
  if (m1) return String(m1).toUpperCase();
  const m2 = findParam(igd, 'MACAddress');
  return m2 ? String(m2).toUpperCase() : null;
}
// First dotted TR-098 path of a connection object, e.g.
// 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1'.
// Lets WAN writes target the instance the ONT actually uses instead of a
// hardcoded '.1' that is empty on some models.
function findFirstInstancePath(igd, targetKey) {
  let found = null;
  function walk(o, prefix) {
    if (!o || typeof o !== 'object' || found) return;
    for (const k of Object.keys(o)) {
      if (k.startsWith('_') || found) continue;
      const v = o[k];
      const path = prefix ? prefix + '.' + k : k;
      if (k === targetKey && v && typeof v === 'object') {
        const inst = Object.keys(v).filter(x => !x.startsWith('_'))[0];
        if (inst) { found = path + '.' + inst; return; }
      }
      if (v && typeof v === 'object') walk(v, path);
    }
  }
  walk(igd, 'InternetGatewayDevice');
  return found;
}
async function wanBases(devId) {
  const realId = await resolveDeviceId(devId);
  const doc = realId ? await db.collection('devices').findOne({ _id: realId }) : null;
  const igd = doc && (doc.InternetGatewayDevice || doc.Device);
  const ppp = (igd && findFirstInstancePath(igd, 'WANPPPConnection'))
    || 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1';
  const ip = (igd && findFirstInstancePath(igd, 'WANIPConnection'))
    || 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1';
  return { pppBase: ppp, ipBase: ip, realId };
}
// WLAN instance key for a band ('2.4GHz'/'5GHz'): first live match in the
// WLANConfiguration tree, else model-aware fallback (Syrotech radio1=5GHz,
// radio5=2.4GHz; Archer 2.4GHz=1, 5GHz=3 — all proven on hardware).
function wlanRadioForBand(doc, band) {
  const igd = doc && (doc.InternetGatewayDevice || doc.Device);
  const wl = igd && igd.LANDevice && igd.LANDevice['1'] && igd.LANDevice['1'].WLANConfiguration;
  if (wl) {
    for (const k of Object.keys(wl)) {
      if (k.startsWith('_')) continue;
      const w = wl[k];
      const ssid = w.SSID && w.SSID._value;
      if (wifiBandOf(w, ssid) === band) return k;
    }
  }
  const pc = (doc && doc._deviceId && String(doc._deviceId._ProductClass + ' ' + doc._deviceId._Manufacturer)) || '';
  const isSyro = /SY-GPON|Syrotech/i.test(pc);
  const isTplink = /TP-Link|Archer/i.test(pc);
  if (band === '5GHz') return isSyro ? '1' : isTplink ? '3' : '2';
  return isSyro ? '5' : '1';
}
// Shared PPPoE provision used by wan-config and the auto-provision API:
// writes Username/Password (+VLAN/DNS when given) to the ONT's real
// WANPPPConnection instance via a single setParameterValues task.
async function provisionPppoe(devId, opts, user) {
  const { username, password, vlanId, priority, dns1, dns2 } = opts || {};
  if (!username && !password) {
    const e = new Error('username or password required');
    e.statusCode = 400;
    throw e;
  }
  const { pppBase } = await wanBases(devId);
  const paramValues = [];
  if (username) paramValues.push([`${pppBase}.Username`, username, 'xsd:string']);
  if (password) paramValues.push([`${pppBase}.Password`, password, 'xsd:string']);
  const vlan = parseInt(vlanId);
  if (!isNaN(vlan)) paramValues.push([`${pppBase}.X_BROADCOM_COM_VlanMuxID`, vlan, 'xsd:int']);
  const pri = parseInt(priority);
  if (!isNaN(pri)) paramValues.push([`${pppBase}.X_BROADCOM_COM_VlanMux8021p`, pri, 'xsd:int']);
  if (dns1 || dns2) {
    paramValues.push([`${pppBase}.DNSServers`, [dns1, dns2].filter(Boolean).join(','), 'xsd:string']);
  }
  const task = { name: 'setParameterValues', parameterValues: paramValues };
  const taskUrl = await getDeviceTasksUrl(devId);
  const resp = await nbiRequest('POST', taskUrl, task);
  logAudit(user, 'WAN_CONFIG', devId, `PPPoE provision on ${pppBase}, user: ${username || '(unchanged)'}`);
  return { resp, pppBase };
}

// One portal-wide summary shape for a raw GenieACS device doc. Used by the
// list, the CSV/XLSX export and the detail modal — so optical power,
// WAN/PPPoE and Wi-Fi readback can never disagree between views.
function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    return v;
  }
  return null;
}
// Some ONTs report masked passwords (literal '******') instead of the real
// key. Treat those as unknown, not as a configured password.
function cleanPassword(v) {
  if (v === undefined || v === null) return null;
  const s = String(v);
  if (s.trim() === '' || /^\*+$/.test(s.trim())) return null;
  return s;
}
function summarizeDevice(d, now) {
  const lastInform = d._lastInform ? new Date(d._lastInform) : null;
  const isOnline = !!(lastInform && (now - lastInform.getTime() <= ONLINE_THRESHOLD_MS));
  const igd = d.InternetGatewayDevice || d.Device;

  // Wi-Fi readback (TR-098 paths). Password location is model-specific:
  // flat KeyPassphrase (most), vendor X_TP_PreSharedKey (TP-Link Archer),
  // nested PreSharedKey.1.KeyPassphrase (Syrotech).
  const wifiReadback = [];
  const wlanBase = igd && igd.LANDevice && igd.LANDevice['1'] && igd.LANDevice['1'].WLANConfiguration;
  if (wlanBase) {
    for (const k of Object.keys(wlanBase)) {
      if (k.startsWith('_')) continue;
      const w = wlanBase[k];
      const ssid = w.SSID && w.SSID._value;
      wifiReadback.push({
        radio: k,
        ssid,
        band: wifiBandOf(w, ssid),
        password: cleanPassword(firstNonEmpty(
          w.KeyPassphrase && (w.KeyPassphrase._value !== undefined ? w.KeyPassphrase._value : w.KeyPassphrase),
          w.X_TP_PreSharedKey && (w.X_TP_PreSharedKey._value !== undefined ? w.X_TP_PreSharedKey._value : w.X_TP_PreSharedKey),
          w.PreSharedKey && w.PreSharedKey['1'] && w.PreSharedKey['1'].KeyPassphrase && w.PreSharedKey['1'].KeyPassphrase._value
        )),
        enabled: w.Enable && w.Enable._value,
        channel: w.Channel && w.Channel._value
      });
    }
  }

  return {
    id: d._id,
    serialNumber: (d._deviceId && d._deviceId._SerialNumber) || d._id,
    manufacturer: (d._deviceId && d._deviceId._Manufacturer) || 'Unknown',
    productClass: (d._deviceId && d._deviceId._ProductClass) || 'ONT',
    hardwareVersion: (igd && igd.DeviceInfo && igd.DeviceInfo.HardwareVersion && igd.DeviceInfo.HardwareVersion._value) || '-',
    softwareVersion: (igd && igd.DeviceInfo && igd.DeviceInfo.SoftwareVersion && igd.DeviceInfo.SoftwareVersion._value) || '-',
    lastInform: lastInform ? lastInform.toISOString() : null,
    isOnline,
    wanIp: findParam(igd, 'ExternalIPAddress'),
    // Search WAN subtree FIRST: a global 'Username' search matches
    // ManagementServer.ConnectionRequestUsername ('admin') before the
    // real PPPoE user (proven live on Archer C6, 2026-09-15).
    pppoeUser: (igd && igd.WANDevice && findParam(igd.WANDevice, 'Username')) || findParam(igd, 'Username'),
    rxPower: findParam(igd, 'RxOpticalPower') || findParam(igd, 'RXPower'),
    txPower: findParam(igd, 'TxOpticalPower') || findParam(igd, 'TXPower'),
    mac: deviceMac(igd),
    tags: d._tags || [],
    wifiReadback
  };
}

app.get('/api/devices', authenticate, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database initializing...' });
    const { query, tag, online, model, page = 1, pageSize = 50 } = req.query;
    let filter = {};
    if (query) {
      const q = String(query);
      // MAC lives deep under LANDevice.1.LANEthernetInterfaceConfig (TR-098,
      // proven live). Colons/dashes differ between input and stored value,
      // so match the separator-stripped tail against both dotted paths and
      // the raw tree via a targeted $where on the two live-checked spots.
      const macQ = q.replace(/[:-]/g, '').toUpperCase();
      filter['$or'] = [
        { '_id': { $regex: q, $options: 'i' } },
        { '_deviceId._SerialNumber': { $regex: q, $options: 'i' } },
        { '_deviceId._ProductClass': { $regex: q, $options: 'i' } },
        { '_deviceId._Manufacturer': { $regex: q, $options: 'i' } },
        { '_tags': { $regex: q, $options: 'i' } },
        { 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress._value': { $regex: q, $options: 'i' } },
        { 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.2.MACAddress._value': { $regex: q, $options: 'i' } }
      ];
      if (macQ && macQ.length >= 4) {
        filter['$or'].push({ 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress._value': { $regex: macQ, $options: 'i' } });
      }
    }
    if (tag) filter['_tags'] = tag;
    if (model) filter['_deviceId._ProductClass'] = model;
    // Online filter BEFORE pagination so total + page agree. Accepts both
    // 'true'/'false' and the 'online'/'offline' values the UI sends.
    const onlineCutoff = new Date(Date.now() - ONLINE_THRESHOLD_MS);
    if (online === 'true' || online === 'online') filter['_lastInform'] = { $gte: onlineCutoff };
    else if (online === 'false' || online === 'offline') filter['$or'] = (filter['$or'] || []).concat([{ _lastInform: { $lt: onlineCutoff } }, { _lastInform: { $exists: false } }]);

    const total = await db.collection('devices').countDocuments(filter);
    const pg = Math.max(1, parseInt(page));
    const ps = Math.min(500, Math.max(5, parseInt(pageSize)));
    const skip = (pg - 1) * ps;

    const rawDevices = await db.collection('devices').find(filter)
      .sort({ _lastInform: -1, _id: 1 })
      .skip(skip).limit(ps).toArray();

    const now = Date.now();
    // Single shared summary shape (optical, WAN/PPPoE, Wi-Fi) — the list,
    // export and detail modal all render from this, so they cannot disagree.
    const devices = rawDevices.map(d => summarizeDevice(d, now));

    res.json({ total, page: pg, pageSize: ps, devices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/devices/export', authenticate, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database initializing...' });
    const fmt = (req.query.fmt || 'csv').toLowerCase();
    const rawDevices = await db.collection('devices').find({}).toArray();
    const now = Date.now();
    const rows = rawDevices.map(d => {
      const s = summarizeDevice(d, now);
      return {
        Serial: s.serialNumber,
        Manufacturer: s.manufacturer,
        Model: s.productClass,
        LastInform: s.lastInform || '',
        WAN_IP: s.wanIp || '',
        PPPoE: s.pppoeUser || '',
        MAC: s.mac || '',
        RX_dBm: (s.rxPower === null || s.rxPower === undefined) ? '' : s.rxPower,
        TX_dBm: (s.txPower === null || s.txPower === undefined) ? '' : s.txPower,
        Tags: (s.tags || []).join('|')
      };
    });
    const headers = ['Serial','Manufacturer','Model','LastInform','WAN_IP','PPPoE','MAC','RX_dBm','TX_dBm','Tags'];
    if (fmt === 'xlsx' || fmt === 'excel') {
      res.setHeader('Content-Type', 'application/vnd.ms-excel');
      res.setHeader('Content-Disposition', 'attachment; filename="devices.xml"');
      res.send(toExcelXml(rows, headers, 'Devices'));
    } else {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="devices.csv"');
      res.send(toCSV(rows, headers));
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/devices/:id', authenticate, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database initializing...' });
    const realId = await resolveDeviceId(req.params.id);
    if (!realId) return res.status(404).json({ error: 'Device not found' });
    const d = await db.collection('devices').findOne({ _id: realId });
    if (!d) return res.status(404).json({ error: 'Device not found' });
    // Raw tree (for refresh logic) plus the same summary shape the list
    // uses — the modal must render identical optical/WAN/Wi-Fi values.
    res.json({ device: d, summary: summarizeDevice(d, Date.now()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Every task route shares this wrapper: 503 when Mongo is down, 502 when the
// NBI call fails — never a hung request or unhandled rejection.
function taskRoute(handler) {
  return async (req, res) => {
    try {
      if (!db) return res.status(503).json({ error: 'Database initializing...' });
      await handler(req, res);
    } catch (e) {
      const msg = /timed out|ECONNREFUSED|ENOTFOUND/.test(e.message)
        ? 'GenieACS NBI unreachable: ' + e.message : e.message;
      res.status(502).json({ error: msg });
    }
  };
}

app.post('/api/devices/:id/tags', authenticate, requireRoles('Super Admin', 'Admin', 'Technician'), taskRoute(async (req, res) => {
  const { tag, action } = req.body;
  const devId = req.params.id;
  const update = action === 'remove' ? { $pull: { _tags: tag } } : { $addToSet: { _tags: tag } };
  await db.collection('devices').updateOne({ _id: devId }, update);
  logAudit(req.user, 'TAG_UPDATE', devId, `${action === 'remove' ? 'Removed' : 'Added'} tag: ${tag}`);
  res.json({ success: true });
}));

app.post('/api/devices/:id/refresh', authenticate, requireRoles('Super Admin', 'Admin', 'Technician'), taskRoute(async (req, res) => {
  const devId = req.params.id;
  const task = { name: 'refreshObject', objectName: '' };
  const taskUrl = await getDeviceTasksUrl(devId);
  const resp = await nbiRequest('POST', taskUrl, task);
  logAudit(req.user, 'REFRESH_DEVICE', devId, 'Triggered full object refresh');
  res.json(resp);
}));

app.post('/api/devices/:id/parameters', authenticate, requireRoles('Super Admin', 'Admin', 'Technician'), taskRoute(async (req, res) => {
  const devId = req.params.id;
  const { parameterValues } = req.body;
  const task = { name: 'setParameterValues', parameterValues };
  const taskUrl = await getDeviceTasksUrl(devId);
  const resp = await nbiRequest('POST', taskUrl, task);
  logAudit(req.user, 'SET_PARAMETERS', devId, JSON.stringify(parameterValues));
  res.json(resp);
}));

app.post('/api/devices/:id/reboot', authenticate, requireRoles('Super Admin', 'Admin', 'Technician'), taskRoute(async (req, res) => {
  const devId = req.params.id;
  const task = { name: 'reboot' };
  const taskUrl = await getDeviceTasksUrl(devId);
  const resp = await nbiRequest('POST', taskUrl, task);
  logAudit(req.user, 'REBOOT', devId, 'Remote ONT reboot executed');
  res.json(resp);
}));

app.post('/api/devices/:id/factory-reset', authenticate, requireRoles('Super Admin', 'Admin'), taskRoute(async (req, res) => {
  const devId = req.params.id;
  const task = { name: 'factoryReset' };
  const taskUrl = await getDeviceTasksUrl(devId);
  const resp = await nbiRequest('POST', taskUrl, task);
  logAudit(req.user, 'FACTORY_RESET', devId, 'Remote Factory Reset executed');
  res.json(resp);
}));

app.post('/api/devices/:id/firmware-upgrade', authenticate, requireRoles('Super Admin', 'Admin'), taskRoute(async (req, res) => {
  const devId = req.params.id;
  const { fileName } = req.body;
  if (!fileName) return res.status(400).json({ error: 'fileName required' });
  const task = { name: 'download', fileName, fileType: '1 Firmware Upgrade Image' };
  const taskUrl = await getDeviceTasksUrl(devId);
  const resp = await nbiRequest('POST', taskUrl, task);
  logAudit(req.user, 'FIRMWARE_UPGRADE', devId, `Firmware file: ${fileName}`);
  res.json(resp);
}));

// ---------- BULK (incl. by tag) ----------
app.post('/api/devices/bulk-action', authenticate, requireRoles('Super Admin', 'Admin'), async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database initializing...' });
    const { deviceIds, tag, model, action, payload } = req.body;
    let ids = deviceIds || [];
    if (tag) {
      const tagged = await db.collection('devices').find({ _tags: tag }, { projection: { _id: 1 } }).toArray();
      ids = tagged.map(d => d._id);
    } else if (model) {
      const modeled = await db.collection('devices').find({
        $or: [
          { '_deviceId._ProductClass': model },
          { '_deviceId._ModelName': model },
          { '_deviceId._ProductClass': { $regex: model, $options: 'i' } },
          { '_id': { $regex: model, $options: 'i' } }
        ]
      }, { projection: { _id: 1 } }).toArray();
      ids = modeled.map(d => d._id);
    }
    if (!ids.length) return res.status(400).json({ error: 'No devices selected' });

    const results = [];
    for (const id of ids) {
      let task;
      if (action === 'reboot') task = { name: 'reboot' };
      else if (action === 'refresh') task = { name: 'refreshObject', objectName: '' };
      else if (action === 'setParams') task = { name: 'setParameterValues', parameterValues: payload };
      else return res.status(400).json({ error: 'Unknown bulk action: ' + action });

      if (task) {
        const taskUrl = await getDeviceTasksUrl(id, false);
        const resp = await nbiRequest('POST', taskUrl, task);
        results.push({ id, status: resp.status });
      }
    }
    logAudit(req.user, 'BULK_ACTION', `${ids.length} devices${tag ? ` (tag=${tag})` : model ? ` (model=${model})` : ''}`, `Action: ${action}`);
    res.json({ success: true, processed: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resolve a display/serial/encoded id to the real GenieACS _id for Mongo ops.
// Returns the doc's _id, or null when nothing matches.
async function resolveDeviceId(devId) {
  let doc = await db.collection('devices').findOne({ _id: devId });
  if (doc) return doc._id;
  const decoded = (() => { try { return decodeURIComponent(devId); } catch { return devId; } })();
  const encoded = encodeURIComponent(decoded).replace(/\(/g, '%28').replace(/\)/g, '%29');
  const parts = decoded.split('-');
  const serial = parts[parts.length - 1];
  const candidates = [...new Set([decoded, encoded, serial])];
  doc = await db.collection('devices').findOne({
    $or: [
      ...candidates.map(c => ({ _id: c })),
      ...candidates.map(c => ({ '_deviceId._SerialNumber': c }))
    ]
  });
  return doc ? doc._id : null;
}

// ---------- DELETE devices (single + bulk) ----------
app.delete('/api/devices/:id', authenticate, requireRoles('Super Admin', 'Admin'), async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database initializing...' });
    const realId = await resolveDeviceId(req.params.id);
    if (!realId) return res.status(404).json({ error: 'Device not found' });
    const resp = await nbiRequest('DELETE', '/devices/' + encodeURIComponent(realId));
    // Delete local Mongo copy only when NBI confirms (else the ONT
    // reappears on next Inform and the operator thinks delete is broken).
    if (resp.status >= 200 && resp.status < 300) {
      await db.collection('devices').deleteOne({ _id: realId });
    }
    logAudit(req.user, 'DELETE_DEVICE', realId, `Device removed from ACS inventory (NBI status ${resp.status})`);
    res.json({ success: resp.status >= 200 && resp.status < 300, nbiStatus: resp.status });
  } catch (e) {
    res.status(502).json({ error: 'GenieACS NBI unreachable: ' + e.message });
  }
});

app.delete('/api/devices', authenticate, requireRoles('Super Admin', 'Admin'), async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database initializing...' });
    const { deviceIds } = req.body || {};
    if (!deviceIds || !deviceIds.length) return res.status(400).json({ error: 'No devices selected' });
    const results = [];
    for (const id of deviceIds) {
      try {
        const realId = await resolveDeviceId(id);
        if (!realId) { results.push({ id, status: 404 }); continue; }
        const resp = await nbiRequest('DELETE', '/devices/' + encodeURIComponent(realId));
        if (resp.status >= 200 && resp.status < 300) {
          await db.collection('devices').deleteOne({ _id: realId });
        }
        results.push({ id, status: resp.status });
      } catch (err) {
        results.push({ id, status: 'error', error: err.message });
      }
    }
    const ok = results.filter(r => r.status === 200 || r.status === 202 || r.status === 204).length;
    logAudit(req.user, 'BULK_DELETE_DEVICES', `${deviceIds.length} devices`, `Deleted ${ok}/${deviceIds.length} from ACS inventory`);
    res.json({ success: true, deleted: ok, total: deviceIds.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- WAN / WiFi / Diagnostics ----------
app.post('/api/devices/:id/wan-config', authenticate, requireRoles('Super Admin', 'Admin', 'Technician'), taskRoute(async (req, res) => {
  const devId = req.params.id;
  const { connectionType, username, password, vlanId, priority, dns1, dns2, ip, subnet, gateway } = req.body;
  const { pppBase, ipBase } = await wanBases(devId);
  const paramValues = [];
  if (connectionType === 'PPPoE' || username || password) {
    if (username) paramValues.push([`${pppBase}.Username`, username, 'xsd:string']);
    if (password) paramValues.push([`${pppBase}.Password`, password, 'xsd:string']);
    const vlan = parseInt(vlanId);
    if (!isNaN(vlan)) paramValues.push([`${pppBase}.X_BROADCOM_COM_VlanMuxID`, vlan, 'xsd:int']);
    const pri = parseInt(priority);
    if (!isNaN(pri)) paramValues.push([`${pppBase}.X_BROADCOM_COM_VlanMux8021p`, pri, 'xsd:int']);
    if (dns1 || dns2) {
      paramValues.push([`${pppBase}.DNSServers`, [dns1, dns2].filter(Boolean).join(','), 'xsd:string']);
    }
  }
  if (connectionType === 'Static') {
    // Static IP lives on the WANIPConnection sibling, not the PPP node —
    // writing it to the PPP path silently did nothing (the 'static not
    // active' complaint). AddressingType Static + address fields together.
    if (!ip) return res.status(400).json({ error: 'Static IP address required' });
    paramValues.push([`${ipBase}.AddressingType`, 'Static', 'xsd:string']);
    paramValues.push([`${ipBase}.ExternalIPAddress`, ip, 'xsd:string']);
    if (subnet) paramValues.push([`${ipBase}.SubnetMask`, subnet, 'xsd:string']);
    if (gateway) paramValues.push([`${ipBase}.DefaultGateway`, gateway, 'xsd:string']);
    if (dns1 || dns2) {
      paramValues.push([`${ipBase}.DNSServers`, [dns1, dns2].filter(Boolean).join(','), 'xsd:string']);
    }
  }
  if (connectionType === 'DHCP') {
    paramValues.push([`${ipBase}.AddressingType`, 'DHCP', 'xsd:string']);
  }
  if (!paramValues.length) return res.status(400).json({ error: 'Nothing to configure' });
  const task = { name: 'setParameterValues', parameterValues: paramValues };
  const taskUrl = await getDeviceTasksUrl(devId);
  const resp = await nbiRequest('POST', taskUrl, task);
  logAudit(req.user, 'WAN_CONFIG', devId, `Configured ${connectionType || 'WAN'} (ppp=${pppBase}, ip=${ipBase}), VLAN: ${vlanId}`);
  res.json({ ...resp, pppBase, ipBase });
}));

// Auto-provision: push PPPoE (and optional VLAN/DNS/Wi-Fi) to one device by
// id, or to many by tag/model — one API for onboarding new ONTs as requested.
app.post('/api/devices/provision-pppoe', authenticate, requireRoles('Super Admin', 'Admin'), async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database initializing...' });
    const { deviceId, deviceIds, tag, model, username, password, vlanId, priority, dns1, dns2, wifi24, wifi5 } = req.body || {};
    if (!username && !password) return res.status(400).json({ error: 'username or password required' });
    let ids = [];
    if (deviceId) ids = [deviceId];
    else if (Array.isArray(deviceIds) && deviceIds.length) ids = deviceIds;
    else if (tag) {
      ids = (await db.collection('devices').find({ _tags: tag }, { projection: { _id: 1 } }).toArray()).map(d => d._id);
    } else if (model) {
      ids = (await db.collection('devices').find({
        $or: [
          { '_deviceId._ProductClass': model },
          { '_deviceId._ModelName': model },
          { '_deviceId._ProductClass': { $regex: model, $options: 'i' } },
          { '_id': { $regex: model, $options: 'i' } }
        ]
      }, { projection: { _id: 1 } }).toArray()).map(d => d._id);
    } else {
      return res.status(400).json({ error: 'deviceId, deviceIds, tag or model required' });
    }
    if (!ids.length) return res.status(404).json({ error: 'No matching devices' });
    const results = [];
    for (const id of ids) {
      try {
        const { resp, pppBase } = await provisionPppoe(id, { username, password, vlanId, priority, dns1, dns2 }, req.user);
        results.push({ id, status: resp.status, pppBase });
      } catch (err) {
        results.push({ id, status: 'error', error: err.message });
      }
    }
    // Optional Wi-Fi push alongside PPPoE (same call, per-band SSID/pass)
    async function pushWifi(id, band, cfg) {
      if (!cfg || (!cfg.ssid && !cfg.password)) return null;
      const realId2 = await resolveDeviceId(id);
      const doc2 = realId2 ? await db.collection('devices').findOne({ _id: realId2 }) : null;
      const radio = wlanRadioForBand(doc2, band);
      const base = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${radio}`;
      const realId = await resolveDeviceId(id);
      const doc = realId ? await db.collection('devices').findOne({ _id: realId }) : null;
      const pc = (doc && doc._deviceId && (doc._deviceId._ProductClass + ' ' + doc._deviceId._Manufacturer)) || '';
      const passPath = /TP-Link|Archer/i.test(pc) ? `${base}.X_TP_PreSharedKey` : `${base}.KeyPassphrase`;
      const pv = [];
      if (cfg.ssid) pv.push([`${base}.SSID`, cfg.ssid, 'xsd:string']);
      if (cfg.password) pv.push([passPath, cfg.password, 'xsd:string']);
      if (cfg.enabled !== undefined) pv.push([`${base}.Enable`, Boolean(cfg.enabled), 'xsd:boolean']);
      if (cfg.channel) pv.push([`${base}.Channel`, parseInt(cfg.channel), 'xsd:unsignedInt']);
      const url = await getDeviceTasksUrl(id);
      return nbiRequest('POST', url, { name: 'setParameterValues', parameterValues: pv });
    }
    for (const r of results) {
      if (r.status === 'error') continue;
      try {
        const w24 = wifi24 ? await pushWifi(r.id, '2.4GHz', wifi24) : null;
        const w5 = wifi5 ? await pushWifi(r.id, '5GHz', wifi5) : null;
        r.wifi = { band24: w24 && w24.status, band5: w5 && w5.status };
      } catch (e) { r.wifi = { error: e.message }; }
    }
    const ok = results.filter(r => r.status === 200 || r.status === 202).length;
    logAudit(req.user, 'AUTO_PROVISION', `${ids.length} devices`, `PPPoE user ${username}, ok ${ok}/${ids.length}`);
    res.json({ success: true, provisioned: ok, total: ids.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/devices/:id/wifi-config', authenticate, requireRoles('Super Admin', 'Admin', 'Technician'), taskRoute(async (req, res) => {
  const devId = req.params.id;
  const { radio, ssid, password, enabled, channel } = req.body;
  const base = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${radio || '1'}`;
  // Model-aware password path (proven live 2026-09-15): TP-Link Archer C6
  // rejects KeyPassphrase with 9007 (whole task incl. SSID is lost), its
  // writable key is the vendor param X_TP_PreSharedKey. Syrotech ONTs use
  // the standard KeyPassphrase.
  const realId = await resolveDeviceId(devId);
  const doc = realId ? await db.collection('devices').findOne({ _id: realId }) : null;
  const pc = (doc && doc._deviceId && (doc._deviceId._ProductClass + ' ' + doc._deviceId._Manufacturer)) || '';
  const isTplink = /TP-Link|Archer/i.test(pc);
  const passPath = isTplink ? `${base}.X_TP_PreSharedKey` : `${base}.KeyPassphrase`;
  const paramValues = [];
  if (ssid) paramValues.push([`${base}.SSID`, ssid, 'xsd:string']);
  if (password) paramValues.push([passPath, password, 'xsd:string']);
  if (enabled !== undefined) paramValues.push([`${base}.Enable`, Boolean(enabled), 'xsd:boolean']);
  if (channel) paramValues.push([`${base}.Channel`, parseInt(channel), 'xsd:unsignedInt']);
  const task = { name: 'setParameterValues', parameterValues: paramValues };
  const taskUrl = await getDeviceTasksUrl(devId);
  const resp = await nbiRequest('POST', taskUrl, task);
  logAudit(req.user, 'WIFI_CONFIG', devId, `Radio ${radio}: SSID=${ssid} (${isTplink ? 'TP-Link key' : 'standard key'})`);
  res.json(resp);
}));

app.post('/api/devices/:id/diagnostics', authenticate, requireRoles('Super Admin', 'Admin', 'Technician'), taskRoute(async (req, res) => {
  const devId = req.params.id;
  const { type, host } = req.body;
  if (!host) return res.status(400).json({ error: 'host required' });
  // DiagnosticsState None → set Host → Requested, in ONE task's parameter
  // order (some ONTs ignore Requested while a previous run is still
  // 'Completed'), then read back via GET so the panel shows real results.
  const objName = type === 'TraceRoute'
    ? 'InternetGatewayDevice.TraceRouteDiagnostics'
    : 'InternetGatewayDevice.IPPingDiagnostics';
  const paramValues = [
    [`${objName}.DiagnosticsState`, 'None', 'xsd:string'],
    [`${objName}.Host`, host, 'xsd:string'],
    [`${objName}.DiagnosticsState`, 'Requested', 'xsd:string']
  ];
  const task = { name: 'setParameterValues', parameterValues: paramValues };
  const taskUrl = await getDeviceTasksUrl(devId);
  const resp = await nbiRequest('POST', taskUrl, task);
  logAudit(req.user, 'DIAGNOSTICS', devId, `Requested ${type} to ${host}`);
  res.json(resp);
}));

app.get('/api/devices/:id/diagnostics', authenticate, taskRoute(async (req, res) => {
  const realId = await resolveDeviceId(req.params.id);
  if (!realId) return res.status(404).json({ error: 'Device not found' });
  const d = await db.collection('devices').findOne({ _id: realId });
  if (!d) return res.status(404).json({ error: 'Device not found' });
  const igd = d.InternetGatewayDevice || d.Device || {};
  const pick = (o) => {
    if (!o) return null;
    const g = (k) => (o[k] && o[k]._value !== undefined ? o[k]._value : null);
    return {
      state: g('DiagnosticsState'), host: g('Host'),
      successCount: g('SuccessCount'), failureCount: g('FailureCount'),
      avgMs: g('AverageResponseTime'), minMs: g('MinimumResponseTime'), maxMs: g('MaximumResponseTime'),
      lastResult: g('LastResult') ?? g('Result')
    };
  };
  res.json({
    ping: pick(igd.IPPingDiagnostics),
    traceroute: pick(igd.TraceRouteDiagnostics),
    lastInform: d._lastInform || null
  });
}));

// ---------- PRESETS ----------
app.get('/api/presets', authenticate, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database initializing...' });
    const presets = await db.collection('presets').find({}).toArray();
    res.json({ presets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/presets', authenticate, requireRoles('Super Admin', 'Admin'), async (req, res) => {
  try {
    const preset = req.body;
    if (!preset._id) return res.status(400).json({ error: 'Preset _id required' });
    const resp = await nbiRequest('PUT', `/presets/${encodeURIComponent(preset._id)}`, preset);
    logAudit(req.user, 'PRESET_CREATE', preset._id, 'Created/updated ZTP preset');
    res.json(resp);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/presets/:name', authenticate, requireRoles('Super Admin', 'Admin'), async (req, res) => {
  try {
    const resp = await nbiRequest('DELETE', `/presets/${encodeURIComponent(req.params.name)}`);
    logAudit(req.user, 'PRESET_DELETE', req.params.name, 'Deleted ZTP preset');
    res.json(resp);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- AUDIT ----------
app.get('/api/audit-logs', authenticate, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database initializing...' });
    const { user, action, from, to, page = 1, pageSize = 100 } = req.query;
    const filter = {};
    if (user) filter.user = { $regex: user, $options: 'i' };
    if (action) filter.action = { $regex: action, $options: 'i' };
    if (from || to) {
      filter.timestamp = {};
      if (from) filter.timestamp.$gte = new Date(from);
      if (to) filter.timestamp.$lte = new Date(to);
    }
    const total = await db.collection('portal_audit').countDocuments(filter);
    const pg = Math.max(1, parseInt(page));
    const ps = Math.min(500, Math.max(10, parseInt(pageSize)));
    const logs = await db.collection('portal_audit').find(filter)
      .sort({ timestamp: -1 }).skip((pg-1)*ps).limit(ps).toArray();
    res.json({ total, page: pg, pageSize: ps, logs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/audit-logs/export', authenticate, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database initializing...' });
    const fmt = (req.query.fmt || 'csv').toLowerCase();
    const logs = await db.collection('portal_audit').find().sort({ timestamp: -1 }).limit(5000).toArray();
    const rows = logs.map(l => ({
      Timestamp: new Date(l.timestamp).toISOString(),
      Operator: l.user,
      Role: l.role,
      Action: l.action,
      Target: l.target || '',
      Details: l.details || '',
      Status: l.status || 'SUCCESS'
    }));
    const headers = ['Timestamp','Operator','Role','Action','Target','Details','Status'];
    if (fmt === 'xlsx' || fmt === 'excel') {
      res.setHeader('Content-Type', 'application/vnd.ms-excel');
      res.setHeader('Content-Disposition', 'attachment; filename="audit-log.xml"');
      res.send(toExcelXml(rows, headers, 'AuditLog'));
    } else {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
      res.send(toCSV(rows, headers));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/audit-logs', authenticate, requireRoles('Super Admin'), async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database initializing...' });
    const r = await db.collection('portal_audit').deleteMany({});
    logAudit(req.user, 'CLEAR_AUDIT', 'portal_audit', `Removed ${r.deletedCount} entries`);
    res.json({ success: true, removed: r.deletedCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- USERS ----------
app.get('/api/users', authenticate, requireRoles('Super Admin', 'Admin'), async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database initializing...' });
    const { page = 1, pageSize = 50 } = req.query;
    const pg = Math.max(1, parseInt(page));
    const ps = Math.min(200, Math.max(5, parseInt(pageSize)));
    const total = await db.collection('portal_users').countDocuments();
    const users = await db.collection('portal_users').find({}, { projection: { passwordHash: 0 } })
      .sort({ createdAt: -1 }).skip((pg-1)*ps).limit(ps).toArray();
    res.json({ total, page: pg, pageSize: ps, users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', authenticate, requireRoles('Super Admin'), async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database initializing...' });
    const { username, password, role, fullName } = req.body;
    if (!username || !password || !role) return res.status(400).json({ error: 'Missing fields' });
    const exists = await db.collection('portal_users').findOne({ username });
    if (exists) return res.status(400).json({ error: 'Username already exists' });
    const hash = await bcrypt.hash(password, 10);
    await db.collection('portal_users').insertOne({
      username, passwordHash: hash, role, fullName, createdAt: new Date()
    });
    logAudit(req.user, 'CREATE_USER', username, `Role: ${role}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', authenticate, requireRoles('Super Admin'), async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database initializing...' });
    if (req.user.id === req.params.id) return res.status(400).json({ error: 'Cannot delete self' });
    await db.collection('portal_users').deleteOne({ _id: new ObjectId(req.params.id) });
    logAudit(req.user, 'DELETE_USER', req.params.id, 'User removed');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- FIRMWARE FS list & upload ----------
app.get('/api/firmware-files', authenticate, requireRoles('Super Admin', 'Admin'), async (req, res) => {
  try {
    const files = await nbiRequest('GET', '/files', null, FS_BASE);
    res.json(files);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/firmware-files/upload', authenticate, requireRoles('Super Admin', 'Admin'), async (req, res) => {
  try {
    const filename = req.headers['x-filename'] || req.query.filename || `firmware_${Date.now()}.bin`;
    const targetUrl = new URL(`/files/${encodeURIComponent(filename)}`, FS_BASE);
    const proxyReq = http.request(targetUrl, {
      method: 'PUT',
      headers: {
        'content-type': req.headers['content-type'] || 'application/octet-stream',
        'content-length': req.headers['content-length']
      }
    }, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          logAudit(req.user, 'UPLOAD_FIRMWARE', filename, 'Uploaded firmware to GenieACS');
          res.json({ success: true, filename });
        } else {
          res.status(proxyRes.statusCode).json({ error: `GenieACS FS error: ${data || proxyRes.statusCode}` });
        }
      });
    });
    proxyReq.on('error', (err) => {
      res.status(502).json({ error: `Failed to reach GenieACS File Server: ${err.message}` });
    });
    req.pipe(proxyReq);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- STUN ----------
app.get('/api/stun/status', authenticate, (req, res) => {
  res.json({
    stun_server: 'stun.l.google.com:19302',
    stun_server_alt: 'stun1.l.google.com:19302',
    stun_port_default: 3478,
    cwmp_url: PUBLIC_CWMP_URL,
    notes: [
      'Configure Syrotech ONT STUN: Server = ' + 'stun.l.google.com',
      'Port = 3478',
      'Username/Password = blank (or match your TR-069 ACS)',
      'NAT-traversal will route ACS connection-request through STUN',
      'ACS URL must remain: ' + PUBLIC_CWMP_URL
    ]
  });
});

// Run a command with fixed argv (no shell) and a short timeout.
function runCmd(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ err: err ? String(err.message || err) : null, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}
function safeIp(s) {
  return /^[A-Za-z0-9.\-:]+$/.test(String(s || '')) ? String(s) : null;
}

// ONT reachability check from the VPS: ping / TCP connect / CWMP log tail.
app.post('/api/diagnostics/ont-reachability', authenticate, requireRoles('Super Admin', 'Admin', 'Technician'), async (req, res) => {
  try {
    const ip = safeIp(req.body && req.body.ip);
    if (!ip) return res.status(400).json({ error: 'Valid ip required' });
    const ping = await runCmd('ping', ['-c', '3', '-W', '2', ip]);
    const tcp = await runCmd('bash', ['-c', `timeout 5 bash -c 'cat < /dev/null > /dev/tcp/${ip}/7547' 2>&1 && echo TCP7547_OPEN || echo TCP7547_CLOSED`]);
    res.json({ ip, pingOk: !ping.err, ping: (ping.stdout + ping.stderr).slice(0, 1500), tcp: (tcp.stdout + tcp.stderr).slice(0, 500) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Recent 7547 connection attempts seen by the proxy (journal tail, parsed).
app.get('/api/diagnostics/cwmp-hits', authenticate, requireRoles('Super Admin', 'Admin', 'Technician'), async (req, res) => {
  try {
    const j = await runCmd('journalctl', ['-u', 'cwmp-proxy', '--no-pager', '--since', '24 hours ago']);
    const lines = (j.stdout || '').split('\n').filter(l => l.includes('ONT connect from'));
    const hits = lines.slice(-50).map(l => {
      const m = l.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}).*ONT connect from \('([^']+)',\s*(\d+)\)/);
      return m ? { time: m[1], ip: m[2], port: m[3] } : { raw: l.slice(0, 160) };
    });
    res.json({ count24h: lines.length, hits });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- SPA fallback ----------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDB().then(() => {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Flexeree ISP Management Portal API running on http://127.0.0.1:${PORT}`);
  });
}).catch(err => {
  _initError = err.message;
  console.error('DB init failed:', err.message);
  // Start anyway so /api/config returns CWMP URL even if Mongo down
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Portal API running (DB UNAVAILABLE): http://127.0.0.1:${PORT}`);
  });
});
