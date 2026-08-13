import { useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router';

type Primitive = string | number | boolean;

function parse(raw: string, def: Primitive): Primitive {
  if (typeof def === 'boolean') return raw === 'true' || raw === '1';
  if (typeof def === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : def;
  }
  return raw;
}

/**
 * Filter state that lives in the query string, so every view is a shareable
 * link and survives a reload or a back-button.
 *
 * `defaults` doubles as the shape, the types, and the omit-list: a value equal
 * to its default is deleted from the URL rather than written, so a pristine
 * view stays at a clean path and links carry only what was actually changed.
 *
 * The setter takes a PATCH and applies it through `setSearchParams`' functional
 * form. That matters: the common case is "a filter changed, so reset paging",
 * which touches two keys at once. Two separate setter calls would each close
 * over the same stale `searchParams` and the second would silently drop the
 * first — hence one patch, one write.
 *
 * Writes use `replace` by default, so dialling a filter in doesn't bury the
 * previous page under a dozen history entries. Keys named in `pushKeys` are
 * the exception: those are navigation (a selection, a tab, a drilldown), and
 * a patch that CHANGES one of them pushes a real history entry — that's what
 * makes the browser back button walk back through the app instead of leaving
 * it. Text inputs and paging must never be push keys, or every keystroke
 * becomes a history entry.
 */
/** A default of `false` or `0` would otherwise infer as the literal type, so
    the state could never be set to anything else. */
type Widen<T> = {
  [K in keyof T]: T[K] extends boolean ? boolean : T[K] extends number ? number : T[K];
};

export function useUrlFilters<T extends Record<string, Primitive>>(
  defaults: T,
  pushKeys?: readonly Extract<keyof T, string>[]
): [Widen<T>, (patch: Partial<Widen<T>>) => void] {
  const [params, setParams] = useSearchParams();

  // Read through a ref so the setter identity doesn't depend on the caller
  // passing a stable `defaults` object (same for `pushKeys`).
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  const pushKeysRef = useRef(pushKeys);
  pushKeysRef.current = pushKeys;
  // The current params, for deciding push-vs-replace before the functional
  // update runs. A ref, not the closure, so a memoized setter still sees
  // the latest URL.
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const values = {} as Record<string, Primitive>;
  for (const key of Object.keys(defaults)) {
    const raw = params.get(key);
    values[key] = raw === null ? defaults[key] : parse(raw, defaults[key]);
  }

  const set = useCallback(
    (patch: Partial<Widen<T>>) => {
      const push = (pushKeysRef.current ?? []).some((key) => {
        const value = patch[key];
        if (value === undefined) return false;
        const raw = paramsRef.current.get(key);
        const current =
          raw === null ? defaultsRef.current[key] : parse(raw, defaultsRef.current[key]);
        return value !== current;
      });
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) continue;
            if (value === defaultsRef.current[key]) next.delete(key);
            else next.set(key, String(value));
          }
          return next;
        },
        { replace: !push }
      );
    },
    [setParams]
  );

  return [values as Widen<T>, set];
}

/**
 * Clamp a URL-supplied value to a known set. Query strings are user-editable,
 * so anything that indexes into a lookup or drives a switch must be validated
 * before use or a hand-typed link renders a blank view.
 */
export function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
