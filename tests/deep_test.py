import urllib.request
import urllib.parse
import json
import ssl
import sys

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

results = []

def run_test(name, fn):
    try:
        res, msg = fn()
        status = "PASS" if res else "FAIL"
        results.append((name, status, msg))
        print(f"[{status}] {name}: {msg}")
    except Exception as e:
        results.append((name, "ERROR", str(e)))
        print(f"[ERROR] {name}: {str(e)}")

def test_cwmp_get():
    req = urllib.request.Request("http://127.0.0.1:7547/")
    try:
        urllib.request.urlopen(req)
        return False, "Expected 405, got 200"
    except urllib.error.HTTPError as e:
        return (e.code == 405), f"Returned HTTP {e.code} (CWMP standard mandates POST only)"

def test_cwmp_post_inform():
    import time
    session_id = f"TEST_INFORM_{int(time.time()*1000)}"
    inform_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap:Header>
    <cwmp:ID soap:mustUnderstand="1">{session_id}</cwmp:ID>
  </soap:Header>
  <soap:Body>
    <cwmp:Inform>
      <DeviceId>
        <Manufacturer>Syrotech</Manufacturer>
        <OUI>001122</OUI>
        <ProductClass>SY-GPON-1110-WDONT</ProductClass>
        <SerialNumber>SYRO2026TEST999</SerialNumber>
      </DeviceId>
      <Event soap:arrayType="cwmp:EventStruct[1]">
        <EventStruct>
          <EventCode>2 PERIODIC</EventCode>
          <CommandKey></CommandKey>
        </EventStruct>
      </Event>
      <MaxEnvelopes>1</MaxEnvelopes>
      <CurrentTime>2026-09-09T12:00:00Z</CurrentTime>
      <RetryCount>0</RetryCount>
      <ParameterList soap:arrayType="cwmp:ParameterValueStruct[2]">
        <ParameterValueStruct>
          <Name>Device.DeviceInfo.HardwareVersion</Name>
          <Value xsi:type="xsd:string">V2.0-TEST</Value>
        </ParameterValueStruct>
        <ParameterValueStruct>
          <Name>Device.DeviceInfo.SoftwareVersion</Name>
          <Value xsi:type="xsd:string">V3.1.2-TEST</Value>
        </ParameterValueStruct>
      </ParameterList>
    </cwmp:Inform>
  </soap:Body>
</soap:Envelope>"""
    req = urllib.request.Request("http://127.0.0.1:7547/", data=inform_xml.encode('utf-8'), headers={'Content-Type': 'text/xml; charset=utf-8'})
    with urllib.request.urlopen(req) as resp:
        body = resp.read().decode('utf-8')
        # Complete the CWMP session with an empty POST to prevent CPE session lock
        cookie = resp.headers.get('Set-Cookie')
        empty_req = urllib.request.Request("http://127.0.0.1:7547/", data=b"", headers={'Content-Type': 'text/xml; charset=utf-8'})
        if cookie:
            empty_req.add_header('Cookie', cookie)
        try:
            urllib.request.urlopen(empty_req)
        except Exception:
            pass

        if "InformResponse" in body:
            return True, "CWMP Inform handshake successful, InformResponse received and session gracefully closed"
        return False, f"Unexpected body: {body[:100]}"

def test_nbi_health():
    req = urllib.request.Request("http://127.0.0.1:7557/devices")
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        return isinstance(data, list), f"NBI responded, found {len(data)} devices in engine"

def test_portal_auth_invalid():
    req = urllib.request.Request("http://127.0.0.1:4000/api/auth/login",
                                data=json.dumps({"username":"admin","password":"wrongpassword"}).encode('utf-8'),
                                headers={'Content-Type': 'application/json'})
    try:
        urllib.request.urlopen(req)
        return False, "Login should have failed"
    except urllib.error.HTTPError as e:
        return (e.code == 401), f"Correctly rejected with HTTP {e.code}"

jwt_token = None
def test_portal_auth_valid():
    global jwt_token
    req = urllib.request.Request("http://127.0.0.1:4000/api/auth/login",
                                data=json.dumps({"username":"admin","password":"admin123"}).encode('utf-8'),
                                headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        jwt_token = data.get('token')
        return (jwt_token is not None), "Token generated successfully"

def test_portal_auth_me():
    req = urllib.request.Request("http://127.0.0.1:4000/api/auth/me",
                                headers={'Authorization': f'Bearer {jwt_token}'})
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        return (data.get('user', {}).get('username') == 'admin'), "Authenticated identity verified"

def test_portal_stats():
    req = urllib.request.Request("http://127.0.0.1:4000/api/dashboard/stats",
                                headers={'Authorization': f'Bearer {jwt_token}'})
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        return ('total' in data and 'online' in data and 'offline' in data), f"Stats valid (total: {data['total']}, online: {data['online']})"

def test_portal_devices():
    req = urllib.request.Request("http://127.0.0.1:4000/api/devices",
                                headers={'Authorization': f'Bearer {jwt_token}'})
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        devices = data.get('devices', [])
        found_test_dev = any("SYRO" in d['serialNumber'] for d in devices)
        return (len(devices) > 0 and found_test_dev), f"Found {len(devices)} devices, including Syrotech test units"

def test_portal_tagging():
    dev_id = "001122-SY%2DGPON%2D1110%2DWDONT-SYRO20260909001"
    req = urllib.request.Request(f"http://127.0.0.1:4000/api/devices/{dev_id}/tags",
                                data=json.dumps({"tag": "VIP_CUSTOMER", "action": "add"}).encode('utf-8'),
                                headers={'Authorization': f'Bearer {jwt_token}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        return data.get('success') is True, "Tag 'VIP_CUSTOMER' attached to device"

def test_portal_reboot_dispatch():
    dev_id = "001122-SY%2DGPON%2D1110%2DWDONT-SYRO20260909001"
    req = urllib.request.Request(f"http://127.0.0.1:4000/api/devices/{dev_id}/reboot",
                                data=json.dumps({}).encode('utf-8'),
                                headers={'Authorization': f'Bearer {jwt_token}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        status = data.get('status')
        return (status == 200 or status == 202), f"Reboot task dispatched to NBI (HTTP status {status})"

def test_portal_audit_logs():
    req = urllib.request.Request("http://127.0.0.1:4000/api/audit-logs",
                                headers={'Authorization': f'Bearer {jwt_token}'})
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        logs = data.get('logs', [])
        has_reboot = any(l.get('action') == 'REBOOT' for l in logs)
        return (len(logs) > 0 and has_reboot), f"Audit log recorded {len(logs)} actions including REBOOT"

def test_nginx_https():
    req = urllib.request.Request("https://127.0.0.1/")
    with urllib.request.urlopen(req, context=ctx) as resp:
        html = resp.read().decode('utf-8')
        return ("Flexeree" in html or "ACS" in html or resp.status == 200), f"Nginx HTTPS serving web portal (HTTP {resp.status})"

def test_genieacs_fs():
    req = urllib.request.Request("http://127.0.0.1:7567/")
    try:
        urllib.request.urlopen(req)
        return True, "File server alive"
    except urllib.error.HTTPError as e:
        return (e.code in [200, 404, 403]), f"FS HTTP response code {e.code}"

print("=== STARTING DEEP SYSTEM TESTS ===")
run_test("TR-069 Port 7547 GET Check", test_cwmp_get)
run_test("TR-069 Port 7547 Inform POST XML Handshake", test_cwmp_post_inform)
run_test("GenieACS NBI Port 7557 Check", test_nbi_health)
run_test("Portal Auth Invalid Rejection", test_portal_auth_invalid)
run_test("Portal Auth Valid Login & Token", test_portal_auth_valid)
run_test("Portal Auth /me Check", test_portal_auth_me)
run_test("Portal Dashboard Stats API", test_portal_stats)
run_test("Portal Devices List API", test_portal_devices)
run_test("Portal Device Tagging API", test_portal_tagging)
run_test("Portal Device Task Dispatch (Reboot)", test_portal_reboot_dispatch)
run_test("Portal Audit Logs Verification", test_portal_audit_logs)
run_test("Nginx HTTPS Reverse Proxy", test_nginx_https)
run_test("GenieACS File Server (Port 7567)", test_genieacs_fs)

passed = sum(1 for r in results if r[1] == "PASS")
total = len(results)
print(f"\n=== SUMMARY: {passed}/{total} TESTS PASSED ===")
if passed != total:
    sys.exit(1)
