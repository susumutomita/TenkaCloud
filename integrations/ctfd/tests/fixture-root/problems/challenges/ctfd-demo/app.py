"""Public fixed flag for disposable local E2E; never a customer challenge."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

FLAG = "TC{ctfd-local-e2e}"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(f"<h1>Isolated exercise</h1><p id='exercise-flag'>{FLAG}</p>".encode())

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"correct": data.get("submission") == FLAG}).encode())


HTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
