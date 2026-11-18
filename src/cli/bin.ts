#!/usr/bin/env node
import { cli, readText } from './main.ts';

process.exitCode = await cli(process.argv.slice(2), {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  stdin: () => readText(process.stdin),
  env: process.env,
  cwd: process.cwd(),
});
