// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atoms, createBlock } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { getCommandPaletteItems, runAction } from "@/app/store/keymodel";
import { modalsModel } from "@/app/store/modalmodel";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";

import "./commandpalette.scss";

// formatLabel converts an action identifier like "app:focus-ai" or "my:ncdu"
// into a human-readable label like "Focus AI" or "Ncdu".
function formatLabel(action: string): string {
    // strip namespace prefix (e.g. "app:", "my:")
    const colonIdx = action.indexOf(":");
    const name = colonIdx >= 0 ? action.slice(colonIdx + 1) : action;
    // split on hyphens, capitalise each word
    return name
        .split("-")
        .map((word) => {
            if (word.length === 0) return word;
            // keep known acronyms upper-case
            const upper = word.toUpperCase();
            if (["AI", "URL", "SSH", "GPU", "CPU"].includes(upper)) return upper;
            return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join(" ");
}

// formatKey converts a Wave key string like "Ctrl:Shift:p" into a readable
// badge string like "Ctrl+Shift+P".
function formatKey(key: string): string {
    return key
        .split(":")
        .map((part) => {
            if (part === "Cmd") return "Meta";
            if (part.length === 1) return part.toUpperCase();
            return part;
        })
        .join("+");
}

// fuzzyMatch returns true if all characters of needle appear in haystack in order.
function fuzzyMatch(haystack: string, needle: string): boolean {
    if (needle.length === 0) return true;
    const h = haystack.toLowerCase();
    const n = needle.toLowerCase();
    let hi = 0;
    for (let ni = 0; ni < n.length; ni++) {
        hi = h.indexOf(n[ni], hi);
        if (hi === -1) return false;
        hi++;
    }
    return true;
}

// score returns a numeric score for sorting: lower is better.
// Exact substring match ranks above fuzzy match.
function score(label: string, query: string): number {
    if (query.length === 0) return 0;
    const l = label.toLowerCase();
    const q = query.toLowerCase();
    if (l.startsWith(q)) return 0;
    if (l.includes(q)) return 1;
    return 2; // fuzzy only
}

const ITEM_HEIGHT = 40; // px, must match scss
const MAX_VISIBLE = 8;

export function CommandPaletteModal() {
    const [query, setQuery] = useState("");
    const [selectedIdx, setSelectedIdx] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const allItems = getCommandPaletteItems();
    const filtered = allItems
        .filter((item) => {
            const label = formatLabel(item.action);
            return fuzzyMatch(label, query) || fuzzyMatch(item.action, query);
        })
        .sort((a, b) => {
            const la = formatLabel(a.action);
            const lb = formatLabel(b.action);
            return score(la, query) - score(lb, query) || la.localeCompare(lb);
        });

    // clamp selectedIdx when filter changes
    const clampedIdx = Math.min(selectedIdx, Math.max(0, filtered.length - 1));

    useLayoutEffect(() => {
        inputRef.current?.focus();
    }, []);

    // scroll selected item into view
    useEffect(() => {
        if (listRef.current) {
            const item = listRef.current.children[clampedIdx] as HTMLElement;
            item?.scrollIntoView({ block: "nearest" });
        }
    }, [clampedIdx]);

    function close() {
        modalsModel.popModal();
    }

    function execute(item: (typeof filtered)[0]) {
        close();
        if (item.isCustom) {
            // user-defined blockdef — read blockdef from config and create block
            const fullConfig = globalStore.get(atoms.fullConfigAtom);
            const cfg = fullConfig?.keybindings?.[item.action];
            if (cfg?.blockdef) {
                void createBlock(cfg.blockdef);
            }
        } else {
            runAction(item.action);
        }
    }

    function handleKeyDown(e: React.KeyboardEvent) {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelectedIdx((i) => Math.max(i - 1, 0));
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (filtered[clampedIdx]) execute(filtered[clampedIdx]);
        } else if (e.key === "Escape") {
            e.preventDefault();
            close();
        }
    }

    const palette = (
        <div className="commandpalette-wrapper" onMouseDown={(e) => e.target === e.currentTarget && close()}>
            <div className="commandpalette">
                <div className="commandpalette-input-row">
                    <span className="commandpalette-prompt">❯</span>
                    <input
                        ref={inputRef}
                        className="commandpalette-input"
                        placeholder="Type a command…"
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setSelectedIdx(0);
                        }}
                        onKeyDown={handleKeyDown}
                        spellCheck={false}
                        autoComplete="off"
                    />
                </div>
                <div
                    className="commandpalette-list"
                    ref={listRef}
                    style={{ maxHeight: `${ITEM_HEIGHT * MAX_VISIBLE}px` }}
                >
                    {filtered.length === 0 && <div className="commandpalette-empty">No matching commands</div>}
                    {filtered.map((item, i) => (
                        <div
                            key={item.action}
                            className={"commandpalette-item" + (i === clampedIdx ? " selected" : "")}
                            onMouseEnter={() => setSelectedIdx(i)}
                            onMouseDown={(e) => {
                                e.preventDefault();
                                execute(item);
                            }}
                        >
                            <span className="commandpalette-label">{formatLabel(item.action)}</span>
                            <span className="commandpalette-meta">
                                {item.isCustom && <span className="commandpalette-badge custom">custom</span>}
                                <kbd className="commandpalette-key">{formatKey(item.key)}</kbd>
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );

    return ReactDOM.createPortal(palette, document.getElementById("main")!);
}

CommandPaletteModal.displayName = "CommandPaletteModal";
