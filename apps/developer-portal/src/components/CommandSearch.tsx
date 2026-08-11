"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type SearchEntry, searchIndex } from "@/lib/search";

// One command-search component is mounted in the shared
// header, so search works identically on landing, docs, and the API reference.
// Cmd/Ctrl+K opens it and focus moves to the input (the keyboard-focus contract
// the tests assert).
export function CommandSearch() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly SearchEntry[]>([]);

  const open = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
      // Move focus to the input so a keyboard user can type immediately.
      inputRef.current?.focus();
    }
  }, []);

  const close = useCallback(() => {
    dialogRef.current?.close();
    setQuery("");
    setResults([]);
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        open();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  function onQueryChange(value: string) {
    setQuery(value);
    setResults(searchIndex(value));
  }

  return (
    <>
      <button type="button" className="search-trigger" onClick={open} aria-label="Open search">
        <span>Search</span>
        <kbd>⌘K</kbd>
      </button>
      <dialog ref={dialogRef} className="search-dialog" aria-label="Site search" onClose={close}>
        <input
          ref={inputRef}
          className="search-dialog__input"
          type="search"
          placeholder="Search docs and API operations"
          aria-label="Search docs and API operations"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {query.trim().length > 0 && results.length === 0 ? (
          <p className="search-empty">No results for “{query}”.</p>
        ) : (
          <ul className="search-results">
            {results.map((entry) => (
              <li key={entry.id}>
                <a href={entry.href} onClick={close}>
                  <span>{entry.title}</span>
                  <span className="search-results__badge">{entry.badge}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </dialog>
    </>
  );
}
