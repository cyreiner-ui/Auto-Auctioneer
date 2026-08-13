"use client";

import { useCallback, useSyncExternalStore } from "react";

const listeners = new Map<string, Set<() => void>>();

// Caches the parsed value per key, alongside the raw string it came from, so
// getSnapshot returns the SAME object reference when localStorage hasn't
// actually changed. useSyncExternalStore requires that — returning a freshly
// parsed array/object on every call (even with identical contents) makes it
// look like the store changes on every render, which triggers React's
// tearing-check to re-render in an infinite loop.
const cache = new Map<string, { raw: string | null; value: unknown }>();

function readValue<T>(key: string, initial: T): T {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return initial;
  }
  const cached = cache.get(key);
  if (cached && cached.raw === raw) return cached.value as T;
  let value = initial;
  if (raw !== null) { try { value = JSON.parse(raw) as T; } catch { value = initial; } }
  cache.set(key, { raw, value });
  return value;
}

function writeValue<T>(key: string, value: T) {
  const raw = JSON.stringify(value);
  window.localStorage.setItem(key, raw);
  cache.set(key, { raw, value });
}

function emit(key: string) {
  listeners.get(key)?.forEach((listener) => listener());
}

export function usePersistedState<T>(key: string, initial: T) {
  const subscribe = useCallback((onStoreChange: () => void) => {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key)!.add(onStoreChange);
    return () => listeners.get(key)?.delete(onStoreChange);
  }, [key]);

  const getSnapshot = useCallback(() => readValue(key, initial), [key, initial]);
  const getServerSnapshot = useCallback(() => initial, [initial]);

  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setValue = useCallback((next: T | ((current: T) => T)) => {
    const resolved = typeof next === "function" ? (next as (current: T) => T)(readValue(key, initial)) : next;
    writeValue(key, resolved);
    emit(key);
  }, [key, initial]);

  return [value, setValue] as const;
}
