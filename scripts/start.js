#!/usr/bin/env node
/**
 * Convenience launcher for Vobiz ServiceNow Bridge server.
 */
const { spawn } = require("child_process");
const path = require("path");

const serverScript = path.join(__dirname, "../backend/server.js");

console.log("[scripts/start] Starting Vobiz ServiceNow Calling Bridge...");
const proc = spawn("node", [serverScript], { stdio: "inherit" });

proc.on("close", (code) => {
  process.exit(code || 0);
});
