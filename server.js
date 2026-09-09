const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { MongoClient, ObjectId } = require('mongodb');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'flexeree_secret_key_2026_secure';
const NBI_BASE = 'http://127.0.0.1:7557';
const MONGO_URI = 'mongodb://127.0.0.1:27017';
const DB_NAME = 'genieacs';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;

async function initDB() {
  const client = new MongoClient(MONGO_URI);
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
    await db.collection('portal_audit').insertOne({
      user: user ? user.username : 'system',
      role: user ? user.role : 'system',
      action,
      target,
      details,
      status,
      timestamp: new Date()
    });
  } catch (e) {
    console.error('Audit log failed:', e.message);
  }
}

async function getDeviceTasksUrl(devId) {
  let doc = await db.collection('devices').findOne({ _id: devId });
  if (!doc) {
    // Try matching by serial (last segment) or fuzzy ID
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
  return '/devices/' + encodeURIComponent(realId) + '/tasks?connection_request';
}

function nbiRequest(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(urlPath, NBI_BASE);
    const options = {
      hostname: fullUrl.hostname,
      port: fullUrl.port,
      path: urlPath, // Preserve raw encoded path
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

// --- AUTH ---
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username & password required' });

  const user = await db.collection('portal_users').findOne({ username });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({
    id: user._id,
    username: user.username,
    role: user.role,
    fullName: user.fullName
  }, JWT_SECRET, { expiresIn: '12h' });

  logAudit(user, 'LOGIN', 'auth', 'Successful dashboard login');

  res.json({
    token,
    user: {
      username: user.username,
      role: user.role,
      fullName: user.fullName
    }
  });
});

app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// --- STATS ---
app.get('/api/dashboard/stats', authenticate, async (req, res) => {
  try {
    const devices = await db.collection('devices').find({}).toArray();
    const total = devices.length;
    const now = Date.now();
    const onlineThresholdMs = 10 * 60 * 1000;

    let online = 0;
    let offline = 0;
    const modelsMap = {};
    const vendorsMap = {};

    devices.forEach(d => {
      const lastInform = d._lastInform ? new Date(d._lastInform).getTime() : 0;
      const isOnline = (now - lastInform) <= onlineThresholdMs;
      if (isOnline) online++; else offline++;

      const model = (d._deviceId && d._deviceId._ProductClass) || 'Generic ONT';
      const vendor = (d._deviceId && d._deviceId._Manufacturer) || 'Syrotech';
      modelsMap[model] = (modelsMap[model] || 0) + 1;
      vendorsMap[vendor] = (vendorsMap[vendor] || 0) + 1;
    });

    const recentEvents = await db.collection('portal_audit').find().sort({ timestamp: -1 }).limit(10).toArray();

    res.json({
      total,
      online,
      offline,
      models: modelsMap,
      vendors: vendorsMap,
      recentEvents
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- DEVICES ---
app.get('/api/devices', authenticate, async (req, res) => {
  try {
    const { query, tag } = req.query;
    let filter = {};

    if (query) {
      filter['$or'] = [
        { '_id': { $regex: query, $options: 'i' } },
        { '_deviceId._SerialNumber': { $regex: query, $options: 'i' } },
        { '_deviceId._ProductClass': { $regex: query, $options: 'i' } },
        { '_deviceId._Manufacturer': { $regex: query, $options: 'i' } }
      ];
    }

    if (tag) {
      filter['_tags'] = tag;
    }

    const rawDevices = await db.collection('devices').find(filter).toArray();
    const now = Date.now();

    const devices = rawDevices.map(d => {
      const lastInform = d._lastInform ? new Date(d._lastInform) : null;
      const isOnline = lastInform && (now - lastInform.getTime() <= 10 * 60 * 1000);

      let rxPower = null;
      let txPower = null;
      let wanIp = null;
      let pppoeUser = null;

      function findParam(obj, suffix) {
        if (!obj) return null;
        for (const k of Object.keys(obj)) {
          if (k.endsWith(suffix) && obj[k]) return obj[k]._value;
        }
        return null;
      }

      const igd = d.InternetGatewayDevice || d.Device;
      if (igd) {
        rxPower = findParam(igd, 'RxOpticalPower') || findParam(igd, 'RXPower');
        txPower = findParam(igd, 'TxOpticalPower') || findParam(igd, 'TXPower');
        wanIp = findParam(igd, 'ExternalIPAddress');
        pppoeUser = findParam(igd, 'Username');
      }

      return {
        id: d._id,
        serialNumber: (d._deviceId && d._deviceId._SerialNumber) || d._id,
        manufacturer: (d._deviceId && d._deviceId._Manufacturer) || 'Unknown',
        productClass: (d._deviceId && d._deviceId._ProductClass) || 'ONT',
        hardwareVersion: (d.InternetGatewayDevice && d.InternetGatewayDevice.DeviceInfo && d.InternetGatewayDevice.DeviceInfo.HardwareVersion && d.InternetGatewayDevice.DeviceInfo.HardwareVersion._value) || '-',
        softwareVersion: (d.InternetGatewayDevice && d.InternetGatewayDevice.DeviceInfo && d.InternetGatewayDevice.DeviceInfo.SoftwareVersion && d.InternetGatewayDevice.DeviceInfo.SoftwareVersion._value) || '-',
        lastInform: lastInform ? lastInform.toISOString() : null,
        isOnline,
        wanIp,
        pppoeUser,
        rxPower,
        txPower,
        tags: d._tags || []
      };
    });

    res.json({ devices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/devices/:id', authenticate, async (req, res) => {
  try {
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
  logAudit(req.user, 'WIFI_CONFIG', devId, `Updated Wi-Fi Radio ${radio}: SSID=${ssid}`);
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

app.post('/api/devices/bulk-action', authenticate, requireRoles('Super Admin', 'Admin'), async (req, res) => {
  const { deviceIds, action, payload } = req.body;
  if (!deviceIds || !deviceIds.length) return res.status(400).json({ error: 'No devices specified' });

  const results = [];
  for (const id of deviceIds) {
    let task;
    if (action === 'reboot') task = { name: 'reboot' };
    else if (action === 'refresh') task = { name: 'refreshObject', objectName: '' };
    else if (action === 'setParams') task = { name: 'setParameterValues', parameterValues: payload };

    if (task) {
      const taskUrl = await getDeviceTasksUrl(id);
      const resp = await nbiRequest('POST', taskUrl, task);
      results.push({ id, status: resp.status });
    }
  }

  logAudit(req.user, 'BULK_ACTION', `${deviceIds.length} devices`, `Action: ${action}`);
  res.json({ success: true, processed: results.length, results });
});

// --- PRESETS ---
app.get('/api/presets', authenticate, async (req, res) => {
  const presets = await db.collection('presets').find().toArray();
  res.json({ presets });
});

app.post('/api/presets', authenticate, requireRoles('Super Admin', 'Admin'), async (req, res) => {
  const preset = req.body;
  const resp = await nbiRequest('PUT', `/presets/${encodeURIComponent(preset._id)}`, preset);
  logAudit(req.user, 'PRESET_CREATE', preset._id, 'Created / updated ZTP preset');
  res.json(resp);
});

app.delete('/api/presets/:name', authenticate, requireRoles('Super Admin', 'Admin'), async (req, res) => {
  const resp = await nbiRequest('DELETE', `/presets/${encodeURIComponent(req.params.name)}`);
  logAudit(req.user, 'PRESET_DELETE', req.params.name, 'Deleted ZTP preset');
  res.json(resp);
});

// --- AUDIT ---
app.get('/api/audit-logs', authenticate, async (req, res) => {
  const logs = await db.collection('portal_audit').find().sort({ timestamp: -1 }).limit(150).toArray();
  res.json({ logs });
});

// --- USERS ---
app.get('/api/users', authenticate, requireRoles('Super Admin', 'Admin'), async (req, res) => {
  const users = await db.collection('portal_users').find({}, { projection: { passwordHash: 0 } }).toArray();
  res.json({ users });
});

app.post('/api/users', authenticate, requireRoles('Super Admin'), async (req, res) => {
  const { username, password, role, fullName } = req.body;
  const hash = await bcrypt.hash(password, 10);
  await db.collection('portal_users').insertOne({
    username,
    passwordHash: hash,
    role,
    fullName,
    createdAt: new Date()
  });
  logAudit(req.user, 'CREATE_USER', username, `Role: ${role}`);
  res.json({ success: true });
});

app.delete('/api/users/:id', authenticate, requireRoles('Super Admin'), async (req, res) => {
  if (req.user.id === req.params.id) return res.status(400).json({ error: 'Cannot delete self' });
  await db.collection('portal_users').deleteOne({ _id: new ObjectId(req.params.id) });
  logAudit(req.user, 'DELETE_USER', req.params.id, 'User removed');
  res.json({ success: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDB().then(() => {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Flexeree ISP Management Portal API running on http://127.0.0.1:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize portal API:', err);
  process.exit(1);
});
