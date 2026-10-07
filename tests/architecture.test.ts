/**
 * Architecture tests.
 *
 * The brief's central structural rule — "the Ideno core must never contain
 * provider-specific logic" — is the kind of rule that erodes silently, one
 * convenience import at a time. These tests make it executable instead of
 * aspirational: they read the source and fail when the boundary moves.
 *
 * Files are loaded through Vite's `import.meta.glob` with `?raw`, so the tests
 * need no Node filesystem types and run in the same pipeline as everything else.
 */
import { describe, expect, it } from 'vitest';

const CORE_FILES = import.meta.glob('/src/core/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const AI_FILES = import.meta.glob('/src/ai/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const REASONING_FILES = import.meta.glob('/src/reasoning/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const UI_FILES = import.meta.glob('/src/ui/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const PROVIDER_NAMES = /puter|openai|anthropic|gemini|claude|gpt-/i;

/** Lines that mention a provider, with comments stripped so prose does not count. */
function codeLinesMentioningProvider(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('*') && !line.startsWith('//') && !line.startsWith('/*'))
    .filter((line) => PROVIDER_NAMES.test(line));
}

describe('provider independence', () => {
  it('found enough source files to be meaningful', () => {
    expect(Object.keys(CORE_FILES).length).toBeGreaterThan(8);
    expect(Object.keys(AI_FILES).length).toBeGreaterThan(4);
  });

  it('keeps every provider name out of src/core', () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(CORE_FILES)) {
      for (const line of codeLinesMentioningProvider(source)) {
        offenders.push(`${path}: ${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps provider names out of the reasoning layer too', () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(REASONING_FILES)) {
      for (const line of codeLinesMentioningProvider(source)) {
        offenders.push(`${path}: ${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('confines provider knowledge to src/ai and the settings screen', () => {
    // The UI inevitably names providers, because the user picks one. Everything it
    // knows must come from the AI layer's settings and labels, not be invented
    // inline — so the only permitted UI file is the settings component.
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(UI_FILES)) {
      if (path.endsWith('/components/settings.ts')) continue;
      for (const line of codeLinesMentioningProvider(source)) {
        offenders.push(`${path}: ${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('confines concrete provider imports to the AI layer', () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries({ ...CORE_FILES, ...REASONING_FILES, ...UI_FILES })) {
      const imports = source.match(/^import .*from '.*';$/gm) ?? [];
      for (const statement of imports) {
        if (/providers\/(puter|openai_compatible|scripted)|@heyputer/.test(statement)) {
          offenders.push(`${path}: ${statement}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('loads the Puter SDK dynamically, so it stays out of the main bundle', () => {
    const puter = AI_FILES['/src/ai/providers/puter.ts'];
    expect(puter).toBeDefined();
    expect(puter).toContain("import('@heyputer/puter.js')");
    // A static top-level import would pull the SDK into the app chunk. The pattern
    // spans lines and excludes `import type`, so it catches a value import written
    // across several lines as well as one written on a single line.
    expect(puter).not.toMatch(/^import\s+(?!type\b)[\s\S]{0,400}?from '@heyputer\/puter\.js';/m);
    // The type-only import is what keeps the adapter typed against the real SDK
    // without paying for it at runtime.
    expect(puter).toMatch(/^import type \{[\s\S]*?\} from '@heyputer\/puter\.js';/m);
  });
});

describe('layering', () => {
  /**
   * `core/orchestrator` is the turn loop: by design it is the one place in core
   * that coordinates the AI runtime and the reasoning layer. Everything else in
   * core — schemas, idea state, state manager, versioning — must not know they
   * exist.
   */
  const STATE_CORE = Object.fromEntries(
    Object.entries(CORE_FILES).filter(([path]) => !path.includes('/orchestrator/')),
  );

  it('never lets the core state modules import upward into ai, reasoning or ui', () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(STATE_CORE)) {
      const imports = source.match(/^import .*from '.*';$/gm) ?? [];
      for (const statement of imports) {
        if (/from '(\.\.\/)+(ai|reasoning|ui|plugins|demo)\//.test(statement)) {
          offenders.push(`${path}: ${statement}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the reasoning layer out of the DOM', () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries({ ...REASONING_FILES, ...STATE_CORE })) {
      // Code lines only: prose about a "transcript window" is not a DOM call.
      const usesDom = source
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => !line.startsWith('*') && !line.startsWith('//') && !line.startsWith('/*'))
        .some((line) => /\bdocument\.|\bwindow\./.test(line));
      if (usesDom) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps knowledge of the desktop host inside one module', () => {
    // Ideno ships as a website *and* as a Linux desktop application from the same
    // bundle. That is only true for as long as the host is an implementation detail
    // of one file: the moment `pywebview` appears in the core, the product has two
    // persistence paths and every caller has to know which one it is on.
    // Two files are allowed to know: the bridge itself, and the composition root
    // that decides which store the app runs on. That decision has to be made
    // somewhere, and `app.ts` is already where every other wiring decision lives.
    const ALLOWED = new Set(['/src/ui/desktop_bridge.ts', '/src/ui/app.ts']);
    const offenders: string[] = [];
    for (const [path, source] of Object.entries({ ...CORE_FILES, ...AI_FILES, ...REASONING_FILES, ...UI_FILES })) {
      if (ALLOWED.has(path)) continue;
      for (const line of codeLines(source)) {
        if (/pywebview|desktop_bridge/.test(line)) offenders.push(`${path}: ${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never reaches the network or the filesystem from the core', () => {
    // The core decides what is true about an idea. Fetching, reading a file and
    // opening a socket are all somebody else's job, injected as a `Store`, a
    // `FetchLike` or a `ResearchSource`.
    //
    // `state_manager/store.ts` is exempt and named: it *is* the storage seam, and
    // probing whether `localStorage` exists at all is the thing it was written to
    // do. Everything else in the core receives a `Store` and has no business
    // knowing what is behind it.
    const STORAGE_SEAM = '/src/core/state_manager/store.ts';
    const offenders: string[] = [];
    for (const [path, source] of Object.entries({ ...CORE_FILES, ...REASONING_FILES })) {
      if (path === STORAGE_SEAM) continue;
      for (const line of codeLines(source)) {
        if (/\bfetch\(|XMLHttpRequest|require\(|node:fs|localStorage\.|import\s+.*from\s+'node:/.test(line)) {
          offenders.push(`${path}: ${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('renders no model or user text through innerHTML', () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(UI_FILES)) {
      const lines = source.split('\n').filter((line) => !line.trim().startsWith('*'));
      for (const line of lines) {
        if (/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(line)) offenders.push(`${path}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Source lines that are code, with comments removed.
 *
 * Block comments are tracked rather than matched per line, because a rule that only
 * skips lines starting with `*` also skips a line that starts with a real expression
 * and happens to contain one — and a boundary test that can be defeated by
 * reformatting is not a boundary test.
 */
function codeLines(source: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    let line = raw.trim();
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2).trim();
      inBlock = false;
    }
    while (line.startsWith('/*')) {
      const end = line.indexOf('*/', 2);
      if (end === -1) {
        line = '';
        inBlock = true;
        break;
      }
      line = line.slice(end + 2).trim();
    }
    if (line.startsWith('//') || line.length === 0) continue;
    out.push(line);
  }
  return out;
}
