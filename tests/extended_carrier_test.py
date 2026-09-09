import urllib.request, urllib.parse, json, ssl, sys

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# 1. Login
req = urllib.request.Request('http://127.0.0.1:4000/api/auth/login',
    data=json.dumps({'username':'admin','password':'admin123'}).encode('utf-8'),
    headers={'Content-Type':'application/json'})
with urllib.request.urlopen(req) as resp:
    token = json.loads(resp.read().decode('utf-8'))['token']

headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
dev_id = '001122-SY%2DGPON%2D1110%2DWDONT-SYRO20260909001'

tests = []
def record(name, status, details):
    tests.append((name, status, details))
    print(f"[{status}] {name}: {details}")

# Test A: WAN Configuration Dispatch (PPPoE + VLAN 100 + Priority 1 + DNS)
try:
    wan_payload = {
        "connectionType": "PPPoE",
        "username": "customer_gold_01@flexeree",
        "password": "StrongPassword998",
        "vlanId": 100,
        "priority": 1,
        "dns1": "1.1.1.1",
        "dns2": "8.8.8.8"
    }
    req = urllib.request.Request(f'http://127.0.0.1:4000/api/devices/{dev_id}/wan-config',
        data=json.dumps(wan_payload).encode('utf-8'), headers=headers)
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        record("WAN PPPoE & VLAN Provisioning", "PASS" if data.get('status') == 202 else "FAIL", f"HTTP {data.get('status')}")
except Exception as e:
    record("WAN PPPoE & VLAN Provisioning", "FAIL", str(e))

# Test B: Wi-Fi Dual-Band Configuration Dispatch
try:
    wifi_payload = {
        "radio": "1",
        "ssid": "Flexeree_Fiber_5G",
        "password": "UltraFastWifi2026!",
        "enabled": True,
        "channel": 36
    }
    req = urllib.request.Request(f'http://127.0.0.1:4000/api/devices/{dev_id}/wifi-config',
        data=json.dumps(wifi_payload).encode('utf-8'), headers=headers)
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        record("Wi-Fi Radio & SSID Provisioning", "PASS" if data.get('status') == 202 else "FAIL", f"HTTP {data.get('status')}")
except Exception as e:
    record("Wi-Fi Radio & SSID Provisioning", "FAIL", str(e))

# Test C: IP Ping Diagnostics Dispatch
try:
    diag_payload = {
        "type": "IPPing",
        "host": "8.8.8.8"
    }
    req = urllib.request.Request(f'http://127.0.0.1:4000/api/devices/{dev_id}/diagnostics',
        data=json.dumps(diag_payload).encode('utf-8'), headers=headers)
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        record("IPPing Diagnostics Dispatch", "PASS" if data.get('status') == 202 else "FAIL", f"HTTP {data.get('status')}")
except Exception as e:
    record("IPPing Diagnostics Dispatch", "FAIL", str(e))

# Test D: Object Refresh Dispatch
try:
    req = urllib.request.Request(f'http://127.0.0.1:4000/api/devices/{dev_id}/refresh',
        data=json.dumps({}).encode('utf-8'), headers=headers)
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        record("Object Tree Refresh Dispatch", "PASS" if data.get('status') == 202 else "FAIL", f"HTTP {data.get('status')}")
except Exception as e:
    record("Object Tree Refresh Dispatch", "FAIL", str(e))

# Test E: Factory Reset Dispatch
try:
    req = urllib.request.Request(f'http://127.0.0.1:4000/api/devices/{dev_id}/factory-reset',
        data=json.dumps({}).encode('utf-8'), headers=headers)
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        record("Factory Reset Dispatch", "PASS" if data.get('status') == 202 else "FAIL", f"HTTP {data.get('status')}")
except Exception as e:
    record("Factory Reset Dispatch", "FAIL", str(e))

# Test F: ZTP Preset Creation
try:
    preset_payload = {
        "_id": "CARRIER_ZTP_SYROTECH_AUTO",
        "weight": 0,
        "events": { "0 BOOTSTRAP": True, "1 BOOT": True },
        "precondition": "DeviceID.Manufacturer = \"Syrotech\"",
        "configurations": [
            { "type": "provision", "name": "inform_interval", "args": [] }
        ]
    }
    req = urllib.request.Request('http://127.0.0.1:4000/api/presets',
        data=json.dumps(preset_payload).encode('utf-8'), headers=headers)
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        record("ZTP Preset Provisioning", "PASS" if data.get('status') in [200, 201] else "FAIL", f"HTTP {data.get('status')}")
except Exception as e:
    record("ZTP Preset Provisioning", "FAIL", str(e))

# Test G: Automated Backup Script Execution & Verification
try:
    import subprocess
    cmd = "/opt/backups/acs/backup.sh"
    res = subprocess.run([cmd], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    record("Automated Backup Script", "PASS" if res.returncode == 0 else "FAIL", f"Backup code: {res.returncode}")
except Exception as e:
    record("Automated Backup Script", "FAIL", str(e))

passed = sum(1 for t in tests if t[1] == "PASS")
total = len(tests)
print(f"\nEXTENDED TEST SUMMARY: {passed}/{total} PASSED")
if passed != total:
    sys.exit(1)
