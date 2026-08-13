"use client";

import { useCallback, useSyncExternalStore } from "react";

const listeners = new Map<string, Set<() => void>>();

function readValue<T>(key: string, initial: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw !== null ? (JSON.parse(raw) as T) : initial;
  } catch {
    return initial;
  }
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
    window.localStorage.setItem(key, JSON.stringify(resolved));
    emit(key);
  }, [key, initial]);

  return [value, setValue] as const;
}
