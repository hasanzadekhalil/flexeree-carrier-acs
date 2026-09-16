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
  let doc = await db.collection('devices').findOne({ _id: devId });
  if (!doc) {
    const parts = devId.split('-');
    const serial = parts[parts.length - 1];
    doc = await db.collection('devices').findOne({
      $or: [
        { '_deviceId._SerialNumber': serial },
        { '_deviceId._SerialNumber': devId },
        { _id: devId.replace(/-/g, '%2D') }
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
function findParam(obj, suffix) {
  if (!obj) return null;
  for (const k of Object.keys(obj)) {
    if (k.endsWith(suffix) && obj[k]) return obj[k]._value;
  }
  return null;
}
function findAllParamsEndingWith(root, suffix) {
  const out = [];
  function walk(o, prefix) {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      if (k.startsWith('_')) continue;
      const v = o[k];
      const path = prefix ? prefix + '.' + k : k;
      if (path.endsWith(suffix) && v && v._value !== undefined) {
        out.push({ path, value: v._value });
      } else if (v && typeof v === 'object') {
        walk(v, path);
      }
    }
  }
  walk(root, '');
  return out;
}

app.get('/api/devices', authenticate, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database initializing...' });
    const { query, tag, online, model, page = 1, pageSize = 50 } = req.query;
    let filter = {};
    if (query) {
      const q = String(query);
      filter['$or'] = [
        { '_id': { $regex: q, $options: 'i' } },
        { '_deviceId._SerialNumber': { $regex: q, $options: 'i' } },
        { '_deviceId._ProductClass': { $regex: q, $options: 'i' } },
        { '_deviceId._Manufacturer': { $regex: q, $options: 'i' } },
        { '_tags': { $regex: q, $options: 'i' } }
      ];
    }
    if (tag) filter['_tags'] = tag;
    if (model) filter['_deviceId._ProductClass'] = model;

    const total = await db.collection('devices').countDocuments(filter);
    const pg = Math.max(1, parseInt(page));
    const ps = Math.min(500, Math.max(5, parseInt(pageSize)));
    const skip = (pg - 1) * ps;

    const rawDevices = await db.collection('devices').find(filter)
      .sort({ _lastInform: -1, _id: 1 })
      .skip(skip).limit(ps).toArray();

    const now = Date.now();
    const devices = rawDevices.map(d => {
      const lastInform = d._lastInform ? new Date(d._lastInform) : null;
      const isOnline = lastInform && (now - lastInform.getTime() <= ONLINE_THRESHOLD_MS);
      const igd = d.InternetGatewayDevice || d.Device;

      // Wi-Fi readback (TR-098 paths)
      const wifiReadback = [];
      const wlanBase = igd && igd.LANDevice && igd.LANDevice['1'] && igd.LANDevice['1'].WLANConfiguration;
      if (wlanBase) {
        for (const k of Object.keys(wlanBase)) {
          if (k.startsWith('_')) continue;
          const w = wlanBase[k];
          wifiReadback.push({
            radio: k,
            ssid: w.SSID && w.SSID._value,
            password: w.PreSharedKey && w.PreSharedKey['1'] && w.PreSharedKey['1'].KeyPassphrase && w.PreSharedKey['1'].KeyPassphrase._value,
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
        pppoeUser: findParam(igd, 'Username'),
        rxPower: findParam(igd, 'RxOpticalPower') || findParam(igd, 'RXPower'),
        txPower: findParam(igd, 'TxOpticalPower') || findParam(igd, 'TXPower'),
        tags: d._tags || [],
        wifiReadback
      };
    });

    let filtered = devices;
    if (online === 'true') filtered = filtered.filter(d => d.isOnline);
    else if (online === 'false') filtered = filtered.filter(d => !d.isOnline);

    res.json({ total, page: pg, pageSize: ps, devices: filtered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/devices/export', authenticate, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database initializing...' });
    const fmt = (req.query.fmt || 'csv').toLowerCase();
    const rawDevices = await db.collection('devices').find({}).toArray();
    const rows = rawDevices.map(d => {
      const igd = d.InternetGatewayDevice || d.Device;
      return {
        Serial: (d._deviceId && d._deviceId._SerialNumber) || d._id,
        Manufacturer: (d._deviceId && d._deviceId._Manufacturer) || '',
        Model: (d._deviceId && d._deviceId._ProductClass) || '',
        LastInform: d._lastInform ? new Date(d._lastInform).toISOString() : '',
        WAN_IP: findParam(igd, 'ExternalIPAddress') || '',
        PPPoE: findParam(igd, 'Username') || '',
        RX_dBm: findParam(igd, 'RxOpticalPower') || '',
        TX_dBm: findParam(igd, 'TxOpticalPower') || '',
        Tags: (d._tags || []).join('|')
      };
    });
    const headers = ['Serial','Manufacturer','Model','LastInform','WAN_IP','PPPoE','RX_dBm','TX_dBm','Tags'];
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
    const d = await db.collection('devices').findOne({ _id: req.params.id });
    if (!d) return res.status(404).json({ error: 'Device not found' });
    res.json({ device: d });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/devices/:id/tags', authenticate, requireRoles('Super Admin', 'Admin', 'Technician'), async (req, res) => {
  const { tag, action } = req.body;
  const devId = req.params.id;
  const update = action === 'remove' ? { $pull: { _tags: tag } } : { $addToSet: { _tags: tag } };
  await db.collection('devices').updateOne({ _id: devId }, update);
  logAudit(req.user, 'TAG_UPDATE', devId, `${action === 'remove' ? 'Removed' : 'Added'} tag: ${tag}`);
  res.json({ success: true });
});

app.post('/api/devices/:id/refresh', authenticate, requireRoles('Super Admin', 'Admin', 'Technician'), async (req, res) => {
  const devId = req.params.id;
  const task = { name: 'refreshObject', objectName: '' };
  const taskUrl = await getDeviceTasksUrl(devId);
  const resp = await nbiRequest('POST', taskUrl, task);
  logAudit(req.user, 'REFRESH_DEVICE', devId, 'Triggered full object refresh');
  res.json(resp);
});

app.post('/api/devices/:id/parameters', authenticate, requireRoles('Super Admin', 'Admin', 'Technician'), async (req, res) => {
  const devId = req.params.id;
  const { parameterValues } = req.body;
  const task = { name: 'setParameterValues', parameterValues };
  const taskUrl = await getDeviceTasksUrl(devId);
  const resp = await nbiRequest('POST', taskUrl, task);
  logAudit(req.user, 'SET_PARAMETERS', devId, JSON.stringify(parameterValues));
  res.json(resp);
});

app.post('/api/devices/:id/reboot', authenticate, requireRoles('Super Admin', 'Admin', 'Technician'), async (req, res) => {
  const devId = req.params.id;
  const task = { name: 'reboot' };
  const taskUrl = await getDeviceTasksUrl(devId);
  const resp = await nbiRequest('POST', taskUrl, task);
  logAudit(req.user, 'REBOOT', devId, 'Remote ONT reboot executed');
  res.json(resp);
});

app.post('/api/devices/:id/factory-reset', authenticate, requireRoles('Super Admin', 'Admin'), async (req, res) => {
  const devId = req.params.id;
  const task = { name: 'factoryReset' };
  const taskUrl = await getDeviceTasksUrl(devId);
  const resp = await nbiRequest('POST', taskUrl, task);
  logAudit(req.user, 'FACTORY_RESET', devId, 'Remote Factory Reset executed');
  res.json(resp);
});

app.post('/api/devices/:id/firmware-upgrade', authenticate, requireRoles('Super Admin', 'Admin'), async (req, res) => {
  const devId = req.params.id;
  const { fileName } = req.body;
  if (!fileName) return res.status(400).json({ error: 'fileName required' });
  const task = { name: 'download', fileName, fileType: '1 Firmware Upgrade Image' };
  const taskUrl = await getDeviceTasksUrl(devId);
  const resp = await nbiRequest('POST', taskUrl, task);
  logAudit(req.user, 'FIRMWARE_UPGRADE', devId, `Firmware file: ${fileName}`);
  res.json(resp);
});

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

// ---------- WAN / WiFi / Diagnostics ----------
app.post('/api/devices/:id/wan-config', authenticate, requireRoles('Super Admin', 'Admin', 'Technician'), async (req, res) => {
  const devId = req.params.id;
  const { connectionType, username, password, vlanId, priority, dns1, dns2 } = req.body;
  const paramValues = [];
  const pppBase = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1';
  if (connectionType === 'PPPoE') {
    if (username) paramValues.push([`${pppBase}.Username`, username, 'xsd:string']);
    if (password) paramValues.push([`${pppBase}.Password`, password, 'xsd:string']);
    if (vlanId) paramValues.push([`${pppBase}.X_BROADCOM_COM_VlanMuxID`, parseInt(vlanId), 'xsd:int']);
    if (priority) paramValues.push([`${pppBase}.X_BROADCOM_COM_VlanMux8021p`, parseInt(priority), 'xsd:int']);
    if (dns1 || dns2) {
      const dns = [dns1, dns2].filter(Boolean).join(',');
      paramValues.push([`${pppBase}.DNSServers`, dns, 'xsd:string']);
    }
  }
  const task = { name: 'setParameterValues', parameterValues: paramValues };
  const taskUrl = await getDeviceTasksUrl(devId);
  const resp = await nbiRequest('POST', taskUrl, task);
  logAudit(req.user, 'WAN_CONFIG', devId, `Configured ${connectionType} WAN, VLAN: ${vlanId}`);
  res.json(resp);
});

app.post('/api/devices/:id/wifi-config', authenticate, requireRoles('Super Admin', 'Admin', 'Technician'), async (req, res) => {
  const devId = req.params.id;
  const { radio, ssid, password, enabled, channel } = req.body;
  const base = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${radio || '1'}`;
  const paramValues = [];
  if (ssid) paramValues.push([`${base}.SSID`, ssid, 'xsd:string']);
  if (password) paramValues.push([`${base}.PreSharedKey.1.KeyPassphrase`, password, 'xsd:string']);
  if (enabled !== undefined) paramValues.push([`${base}.Enable`, Boolean(enabled), 'xsd:boolean']);
  if (channel) paramValues.push([`${base}.Channel`, parseInt(channel), 'xsd:unsignedInt']);
  const task = { name: 'setParameterValues', parameterValues: paramValues };
  const taskUrl = await getDeviceTasksUrl(devId);
  const resp = await nbiRequest('POST', taskUrl, task);
  logAudit(req.user, 'WIFI_CONFIG', devId, `Radio ${radio}: SSID=${ssid}`);
  res.json(resp);
});

app.post('/api/devices/:id/diagnostics', authenticate, requireRoles('Super Admin', 'Admin', 'Technician'), async (req, res) => {
  const devId = req.params.id;
  const { type, host } = req.body;
  const objName = type === 'TraceRoute'
    ? 'InternetGatewayDevice.TraceRouteDiagnostics'
    : 'InternetGatewayDevice.IPPingDiagnostics';
  const paramValues = [
    [`${objName}.Host`, host, 'xsd:string'],
    [`${objName}.DiagnosticsState`, 'Requested', 'xsd:string']
  ];
  const task = { name: 'setParameterValues', parameterValues: paramValues };
  const taskUrl = await getDeviceTasksUrl(devId);
  const resp = await nbiRequest('POST', taskUrl, task);
  logAudit(req.user, 'DIAGNOSTICS', devId, `Requested ${type} to ${host}`);
  res.json(resp);
});

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
