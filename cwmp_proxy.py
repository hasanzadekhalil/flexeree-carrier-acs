#!/usr/bin/env python3
"""
CWMP namespace fixer — runs as a TCP proxy on port 7547.
Rewrites `urn:dslforum-org:cwmp-1-4` → `urn:dslforum-org:cwmp-1-3`
in every SOAP request before forwarding to GenieACS, so ONTs that
send cwmp-1-4 are accepted without touching GenieACS itself.
"""
import socket, threading, sys

GENIEACS_HOST = "103.124.208.56"
GENIEACS_PORT = 7548
LISTEN_PORT   = 7547

def pipe(src, dst, label, rewrite=False):
    try:
        while True:
            data = src.recv(8192)
            if not data:
                break
            if rewrite:
                data = data.replace(
                    b"urn:dslforum-org:cwmp-1-4",
                    b"urn:dslforum-org:cwmp-1-3"
                )
            dst.sendall(data)
    except Exception as e:
        sys.stderr.write(f"[{label}] {e}\n")
    finally:
        try:
            src.shutdown(socket.SHUT_RDWR)
            src.close()
        except: pass
        try:
            dst.shutdown(socket.SHUT_RDWR)
            dst.close()
        except: pass

def handle(client, addr):
    sys.stderr.write(f"[+] ONT connect from {addr}\n")
    try:
        genie = socket.create_connection((GENIEACS_HOST, GENIEACS_PORT), timeout=10)
        sys.stderr.write(f"[+] connected to GenieACS\n")
    except Exception as e:
        sys.stderr.write(f"[-] GenieACS connect fail: {e}\n")
        client.close()
        return

    t1 = threading.Thread(target=pipe, args=(client, genie, "ONT→ACS", True),  daemon=True)
    t2 = threading.Thread(target=pipe, args=(genie, client, "ACS→ONT", False), daemon=True)
    t1.start(); t2.start()
    t1.join(); t2.join()
    sys.stderr.write(f"[-] session closed {addr}\n")

s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", LISTEN_PORT))
s.listen(64)
sys.stderr.write(f"[*] CWMP proxy listening on :{LISTEN_PORT} -> {GENIEACS_HOST}:{GENIEACS_PORT}\n")
while True:
    client, addr = s.accept()
    t = threading.Thread(target=handle, args=(client, addr), daemon=True)
    t.start()
