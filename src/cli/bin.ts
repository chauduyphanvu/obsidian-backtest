#!/usr/bin/env node
import { cli } from './main.ts';

const stdin = async (): Promise<string> => {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
};

process.exitCode = await cli(process.argv.slice(2), {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  stdin,
  env: process.env,
  cwd: process.cwd(),
});
