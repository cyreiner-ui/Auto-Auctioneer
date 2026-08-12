// The repo's tsconfig.json uses moduleResolution:"bundler", so source files import each
// other without file extensions (e.g. `from "./finder-core"`) and via the `@/*` root alias
// (e.g. `from "@/lib/finder-service"`). Next.js's bundler resolves both fine, but plain Node
// ESM understands neither. This hook makes the test runner tolerate the same import styles
// the app already uses, by rewriting `@/` to the project root and retrying a failed bare or
// extensionless specifier with ".ts" then ".js" appended (the latter covers subpath package
// exports like "next/server", which Node's own resolver only recognizes with ".js" attached).
// Test-only — no production file is touched or aware this exists.

const projectRoot = new URL("../../", import.meta.url);
const RETRYABLE_CODES = new Set(["ERR_MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED"]);
const hasExtension = (specifier) => /\.[a-zA-Z0-9]+$/.test(specifier);

export async function resolve(specifier, context, nextResolve) {
  const target = specifier.startsWith("@/") ? new URL(specifier.slice(2), projectRoot).href : specifier;
  try {
    return await nextResolve(target, context);
  } catch (error) {
    if (!RETRYABLE_CODES.has(error?.code) || hasExtension(target)) throw error;
    for (const ext of [".ts", ".js"]) {
      try { return await nextResolve(`${target}${ext}`, context); } catch { /* try the next extension */ }
    }
    throw error;
  }
}
