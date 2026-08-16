#!/usr/bin/env tsx
/**
 * Validate every Mermaid diagram in repo markdown: `npm run docs:diagrams`.
 * Renders each block with mermaid-cli against the Playwright chromium binary
 * (shared with the Playwright suites - no separate puppeteer download).
 * Part of `npm run lint:repo`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { findRepoRoot } from '@xitter/config';

const SKIP_DIRS = new Set([
  '.git',
  '.turbo',
  '.next',
  'node_modules',
  'dist',
  'coverage',
  'report',
  'reports',
  'test-results',
  'openapi',
]);

// fallow-ignore-next-line complexity
function findMarkdown(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) findMarkdown(join(dir, entry.name), acc);
    } else if (extname(entry.name) === '.md') {
      acc.push(join(dir, entry.name));
    }
  }
  return acc;
}

function extractBlocks(files: string[]): { file: string; index: number; code: string }[] {
  const blocks: { file: string; index: number; code: string }[] = [];
  const re = /```mermaid\n([\s\S]*?)```/g;
  for (const file of files) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    let index = 0;
    for (const match of text.matchAll(re)) {
      blocks.push({
        file: file.replace(`${findRepoRoot()}/`, ''),
        index: index++,
        code: match[1]!,
      });
    }
  }
  return blocks;
}

function renderBlock(mmdc: string, puppeteerConfig: string, dir: string, code: string): boolean {
  const mmd = join(dir, 'diagram.mmd');
  writeFileSync(mmd, code);
  try {
    execFileSync(mmdc, ['-p', puppeteerConfig, '-i', mmd, '-o', join(dir, 'out.svg')], {
      stdio: 'pipe',
    });
    return true;
  } catch (err) {
    const stderr = err instanceof Error && 'stderr' in err ? String(err.stderr) : String(err);
    console.error(stderr.split('\n').slice(0, 4).join('\n'));
    return false;
  }
}

// fallow-ignore-next-line complexity
async function main(): Promise<void> {
  const root = findRepoRoot();
  const files = [
    join(root, 'README.md'),
    join(root, 'AGENTS.md'),
    ...findMarkdown(join(root, 'docs')),
  ];
  const blocks = extractBlocks(files);
  if (blocks.length === 0) {
    console.log('diagrams: no mermaid blocks found');
    return;
  }

  const { chromium } = await import('playwright-core');
  const chromiumPath = chromium.executablePath();
  if (!existsSync(chromiumPath)) {
    console.error('diagrams: Playwright chromium not found - run `npm run test:install` first.');
    process.exit(1);
  }

  const dir = mkdtempSync(join(tmpdir(), 'xitter-mermaid-'));
  const puppeteerConfig = join(dir, 'puppeteer.json');
  writeFileSync(
    puppeteerConfig,
    JSON.stringify({ executablePath: chromiumPath, args: ['--no-sandbox'] }),
  );
  const mmdc = join(root, 'node_modules', '.bin', 'mmdc');

  let failed = 0;
  for (const block of blocks) {
    if (renderBlock(mmdc, puppeteerConfig, dir, block.code)) {
      console.log(`✓ ${block.file} #${block.index + 1}`);
    } else {
      failed++;
      console.error(`✗ ${block.file} (diagram #${block.index + 1})`);
    }
  }

  rmSync(dir, { recursive: true, force: true });
  console.log(`diagrams: ${blocks.length - failed}/${blocks.length} valid`);
  if (failed > 0) process.exit(1);
}

void main();
