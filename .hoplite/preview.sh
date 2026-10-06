#!/usr/bin/env bash
set -euo pipefail

profile_dir="$(mktemp -d /tmp/vespera-preview.XXXXXX)"
chmod 700 "$profile_dir"

cleanup() {
  if [[ -n "${status_pid:-}" ]]; then
    kill "$status_pid" 2>/dev/null || true
    wait "$status_pid" 2>/dev/null || true
  fi
  rm -rf "$profile_dir"
}
trap cleanup EXIT INT TERM

# The HTTP endpoint is only a truthful status page; the application itself stays Electron.
node -e '
const http = require("node:http");
const page = `<!doctype html><meta charset="utf-8"><title>Vespera desktop preview</title>
<main style="font:16px system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem;color:#ddd;background:#161514">
<h1>Vespera desktop preview</h1>
<p>The application is running in an isolated Electron window. This page is a status endpoint, not a web rendering of the app.</p>
<p>For UI inspection from this workspace, connect agent-browser to the Electron DevTools endpoint on port 9222.</p>
</main>`;
http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("electron preview launcher ready\n");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
}).listen(3000, "0.0.0.0", () => console.log("Electron preview status page listening on 3000"));
' &
status_pid=$!

xvfb-run --auto-servernum --server-args="-screen 0 1440x900x24" \
  ./node_modules/.bin/electron . \
  --no-sandbox \
  --user-data-dir="$profile_dir" \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1
