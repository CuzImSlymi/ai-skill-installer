#!/usr/bin/env node
import { main } from '../src/cli.js';

try { await main(); }
catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
