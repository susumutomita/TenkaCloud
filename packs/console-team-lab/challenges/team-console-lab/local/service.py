"""Small owned reference lab: only the declared Web service is publishable."""
import hashlib
import json
import os
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

mode = sys.argv[1]
seed = os.environ["FLAG_SEED"]
flag = "TC{" + hashlib.sha256(seed.encode()).hexdigest()[:24] + "}"

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def send(self, payload, status=200):
        encoded = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if mode == "web":
            self.send({"flag": flag, "service": "published Web"})
        elif mode == "db":
            with sqlite3.connect("/tmp/private.sqlite") as database:
                database.execute("CREATE TABLE IF NOT EXISTS private_data(value TEXT)")
                self.send({"private": hashlib.sha256(seed.encode()).hexdigest()})
        else:
            self.send({"ready": True})

    def do_POST(self):
        if mode != "verifier" or self.path != "/verify":
            self.send({"error": "not found"}, 404)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 <= size <= 65536:
                raise ValueError("size")
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict) or not isinstance(body.get("submission"), str):
                raise ValueError("submission")
            self.send({"correct": body["submission"] == flag})
        except (ValueError, TypeError):
            self.send({"error": "invalid request"}, 400)

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", {"web": 8080, "db": 9000, "verifier": 8081}[mode]), Handler).serve_forever()
