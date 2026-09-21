const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const PORT = 8092;
const TUNNEL_URL_FILE = path.join(__dirname, "tunnel-url.txt");

const localCloudflared = path.join(__dirname, "cloudflared.exe");
const cmd = fs.existsSync(localCloudflared) ? localCloudflared : "cloudflared";

console.log(`[tunnel] Starting tunnel using ${cmd}...`);

const tunnel = spawn(cmd, [
  "tunnel",
  "--protocol", "http2",
  "--url", `http://localhost:${PORT}`
]);

let urlFound = false;

function parseOutput(data) {
  const text = data.toString();
  process.stderr.write(data); // Forward cloudflared logs to console
  
  if (!urlFound) {
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match) {
      const url = match[0];
      urlFound = true;
      console.log(`\n==================================================`);
      console.log(`[tunnel] Captured Quick Tunnel URL: ${url}`);
      console.log(`[tunnel] Saving to ${TUNNEL_URL_FILE}...`);
      console.log(`==================================================\n`);
      fs.writeFileSync(TUNNEL_URL_FILE, url, "utf8");
    }
  }
}

tunnel.stdout.on("data", parseOutput);
tunnel.stderr.on("data", parseOutput);

tunnel.on("error", (err) => {
  if (err.code === "ENOENT") {
    console.error("\n[tunnel] ERROR: 'cloudflared' command not found.");
    console.error("[tunnel] Install it first:");
    console.error("  macOS:   brew install cloudflared");
    console.error("  Windows: winget install --id Cloudflare.cloudflared -e");
    console.error("  Linux:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
    console.error("[tunnel] Or manually run another tunnel and write the URL to backend/tunnel-url.txt");
  } else {
    console.error("[tunnel] Process error:", err);
  }
});

tunnel.on("close", (code) => {
  console.log(`[tunnel] cloudflared exited with code ${code}`);
  if (fs.existsSync(TUNNEL_URL_FILE)) {
    try {
      fs.unlinkSync(TUNNEL_URL_FILE);
      console.log("[tunnel] Cleaned up tunnel-url.txt");
    } catch {}
  }
});

// Clean up on exit
process.on("SIGINT", () => {
  tunnel.kill();
  process.exit();
});
process.on("SIGTERM", () => {
  tunnel.kill();
  process.exit();
});
