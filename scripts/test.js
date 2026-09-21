#!/usr/bin/env node
/**
 * Runs the automated test suite for the Vobiz ServiceNow Bridge.
 */
const { spawn } = require("child_process");
const path = require("path");

const testScript = path.join(__dirname, "../backend/test-harness.js");

console.log("[scripts/test] Executing test harness...");
const proc = spawn("node", [testScript], { stdio: "inherit" });

proc.on("close", (code) => {
  process.exit(code || 0);
});
