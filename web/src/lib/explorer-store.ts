'use client';

import * as React from 'react';

// Per-browser Explorer state (request history, saved requests, pinned
// operations). This is inherently client/local state — it describes how an
// individual developer uses the Explorer, not shared server config — so it
// lives in localStorage rather than the backend.

export interface HistoryEntry {
  id: string;
  ts: number;
  service: string;
  type: string;
  gql: boolean;
  opName: string;
  query?: string;
  method?: string;
  path?: string;
  status: number;
  timeMs: number;
}

export interface SavedEntry extends HistoryEntry {
  label: string;
}

const HISTORY_KEY = 'explorer.history.v1';
const SAVED_KEY = 'explorer.saved.v1';
const PINS_KEY = 'explorer.pins.v1';
const HISTORY_MAX = 25;

export function pinKey(service: string, opName: string) {
  return `${service}::${opName}`;
}

function read<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write<T>(key: string, value: T) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / disabled */
  }
}

export function useExplorerStore() {
  const [history, setHistory] = React.useState<HistoryEntry[]>([]);
  const [saved, setSaved] = React.useState<SavedEntry[]>([]);
  const [pins, setPins] = React.useState<string[]>([]);

  React.useEffect(() => {
    setHistory(read<HistoryEntry[]>(HISTORY_KEY, []));
    setSaved(read<SavedEntry[]>(SAVED_KEY, []));
    setPins(read<string[]>(PINS_KEY, []));
  }, []);

  const addHistory = React.useCallback((entry: Omit<HistoryEntry, 'id' | 'ts'>) => {
    setHistory((prev) => {
      const next = [
        { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: Date.now() },
        ...prev,
      ].slice(0, HISTORY_MAX);
      write(HISTORY_KEY, next);
      return next;
    });
  }, []);

  const clearHistory = React.useCallback(() => {
    setHistory([]);
    write(HISTORY_KEY, []);
  }, []);

  const saveEntry = React.useCallback((entry: Omit<HistoryEntry, 'id' | 'ts'>, label: string) => {
    setSaved((prev) => {
      const next: SavedEntry[] = [
        { ...entry, label, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: Date.now() },
        ...prev,
      ];
      write(SAVED_KEY, next);
      return next;
    });
  }, []);

  const removeSaved = React.useCallback((id: string) => {
    setSaved((prev) => {
      const next = prev.filter((s) => s.id !== id);
      write(SAVED_KEY, next);
      return next;
    });
  }, []);

  const togglePin = React.useCallback((service: string, opName: string) => {
    const key = pinKey(service, opName);
    setPins((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      write(PINS_KEY, next);
      return next;
    });
  }, []);

  const isPinned = React.useCallback((service: string, opName: string) => pins.includes(pinKey(service, opName)), [pins]);

  return { history, saved, pins, addHistory, clearHistory, saveEntry, removeSaved, togglePin, isPinned };
}
