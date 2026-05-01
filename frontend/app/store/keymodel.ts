// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { WaveAIModel } from "@/app/aipanel/waveai-model";
import { FocusManager } from "@/app/store/focusManager";
import {
    atoms,
    createBlock,
    createBlockSplitHorizontally,
    createBlockSplitVertically,
    createTab,
    getAllBlockComponentModels,
    getApi,
    getBlockComponentModel,
    getFocusedBlockId,
    getSettingsKeyAtom,
    globalStore,
    recordTEvent,
    refocusNode,
    replaceBlock,
    WOS,
} from "@/app/store/global";
import { getActiveTabModel } from "@/app/store/tab-model";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { deleteLayoutModelForTab, getLayoutModelForStaticTab, NavigateDirection } from "@/layout/index";
import * as keyutil from "@/util/keyutil";
import { isWindows } from "@/util/platformutil";
import { CHORD_TIMEOUT } from "@/util/sharedconst";
import { fireAndForget } from "@/util/util";
import * as jotai from "jotai";
import { modalsModel } from "./modalmodel";
import { isBuilderWindow, isTabWindow } from "./windowtype";

type KeyHandler = (event: WaveKeyboardEvent) => boolean;

const simpleControlShiftAtom = jotai.atom(false);
const globalKeyMap = new Map<string, (waveEvent: WaveKeyboardEvent) => boolean>();
const globalChordMap = new Map<string, Map<string, KeyHandler>>();
let globalKeybindingsDisabled = false;

// Named action registry — maps action name to its handler function.
// Actions are registered once in registerActionHandlers(); the key bindings
// (which key triggers which action) are kept separately in defaultKeyBindings
// so that user config can remap them without touching the handler logic.
const actionRegistry = new Map<string, KeyHandler>();

// Default key → action name mappings.  These are the built-in defaults;
// user config in keybindings.json can override them.
const defaultKeyBindings: Array<{ action: string; key: string }> = [];

// track current chord state and timeout (for resetting)
let activeChord: string | null = null;
let chordTimeout: NodeJS.Timeout = null;

function resetChord() {
    activeChord = null;
    if (chordTimeout) {
        clearTimeout(chordTimeout);
        chordTimeout = null;
    }
}

function setActiveChord(activeChordArg: string) {
    getApi().setKeyboardChordMode();
    if (chordTimeout) {
        clearTimeout(chordTimeout);
    }
    activeChord = activeChordArg;
    chordTimeout = setTimeout(() => resetChord(), CHORD_TIMEOUT);
}

export function keyboardMouseDownHandler(e: MouseEvent) {
    if (!e.ctrlKey || !e.shiftKey) {
        unsetControlShift();
    }
}

function getFocusedBlockInStaticTab(): string {
    const layoutModel = getLayoutModelForStaticTab();
    const focusedNode = globalStore.get(layoutModel.focusedNode);
    return focusedNode.data?.blockId;
}

function getSimpleControlShiftAtom() {
    return simpleControlShiftAtom;
}

function setControlShift() {
    globalStore.set(simpleControlShiftAtom, true);
    const disableDisplay = globalStore.get(getSettingsKeyAtom("app:disablectrlshiftdisplay"));
    if (!disableDisplay) {
        setTimeout(() => {
            const simpleState = globalStore.get(simpleControlShiftAtom);
            if (simpleState) {
                globalStore.set(atoms.controlShiftDelayAtom, true);
            }
        }, 400);
    }
}

function unsetControlShift() {
    globalStore.set(simpleControlShiftAtom, false);
    globalStore.set(atoms.controlShiftDelayAtom, false);
}

function disableGlobalKeybindings() {
    globalKeybindingsDisabled = true;
}

function enableGlobalKeybindings() {
    globalKeybindingsDisabled = false;
}

function shouldDispatchToBlock(e: WaveKeyboardEvent): boolean {
    if (globalStore.get(atoms.modalOpen)) {
        return false;
    }
    const activeElem = document.activeElement;
    if (activeElem != null && activeElem instanceof HTMLElement) {
        if (activeElem.tagName == "INPUT" || activeElem.tagName == "TEXTAREA" || activeElem.contentEditable == "true") {
            if (activeElem.classList.contains("dummy-focus") || activeElem.classList.contains("dummy")) {
                return true;
            }
            if (keyutil.isInputEvent(e)) {
                return false;
            }
            return true;
        }
    }
    return true;
}

function getStaticTabBlockCount(): number {
    const tabId = globalStore.get(atoms.staticTabId);
    const tabORef = WOS.makeORef("tab", tabId);
    const tabAtom = WOS.getWaveObjectAtom<Tab>(tabORef);
    const tabData = globalStore.get(tabAtom);
    return tabData?.blockids?.length ?? 0;
}

function simpleCloseStaticTab() {
    const workspaceId = globalStore.get(atoms.workspaceId);
    const tabId = globalStore.get(atoms.staticTabId);
    const confirmClose = globalStore.get(getSettingsKeyAtom("tab:confirmclose")) ?? false;
    getApi()
        .closeTab(workspaceId, tabId, confirmClose)
        .then((didClose) => {
            if (didClose) {
                deleteLayoutModelForTab(tabId);
            }
        })
        .catch((e) => {
            console.log("error closing tab", e);
        });
}

function uxCloseBlock(blockId: string) {
    const workspaceLayoutModel = WorkspaceLayoutModel.getInstance();
    const isAIPanelOpen = workspaceLayoutModel.getAIPanelVisible();
    if (isAIPanelOpen && getStaticTabBlockCount() === 1) {
        const aiModel = WaveAIModel.getInstance();
        const shouldSwitchToAI = !globalStore.get(aiModel.isChatEmptyAtom) || aiModel.hasNonEmptyInput();
        if (shouldSwitchToAI) {
            replaceBlock(blockId, { meta: { view: "launcher" } }, false);
            setTimeout(() => WaveAIModel.getInstance().focusInput(), 50);
            return;
        }
    }

    const blockAtom = WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId));
    const blockData = globalStore.get(blockAtom);
    const isAIFileDiff = blockData?.meta?.view === "aifilediff";

    // If this is the last block, closing it will close the tab — route through simpleCloseStaticTab
    // so the tab:confirmclose setting is respected.
    if (getStaticTabBlockCount() === 1) {
        simpleCloseStaticTab();
        return;
    }

    const layoutModel = getLayoutModelForStaticTab();
    const node = layoutModel.getNodeByBlockId(blockId);
    if (node) {
        fireAndForget(() => layoutModel.closeNode(node.id));

        if (isAIFileDiff && isAIPanelOpen) {
            setTimeout(() => WaveAIModel.getInstance().focusInput(), 50);
        }
    }
}

function genericClose() {
    const focusType = FocusManager.getInstance().getFocusType();
    if (focusType === "waveai") {
        WorkspaceLayoutModel.getInstance().setAIPanelVisible(false);
        return;
    }

    const workspaceLayoutModel = WorkspaceLayoutModel.getInstance();
    const isAIPanelOpen = workspaceLayoutModel.getAIPanelVisible();
    if (isAIPanelOpen && getStaticTabBlockCount() === 1) {
        const aiModel = WaveAIModel.getInstance();
        const shouldSwitchToAI = !globalStore.get(aiModel.isChatEmptyAtom) || aiModel.hasNonEmptyInput();
        if (shouldSwitchToAI) {
            const layoutModel = getLayoutModelForStaticTab();
            const focusedNode = globalStore.get(layoutModel.focusedNode);
            if (focusedNode) {
                replaceBlock(focusedNode.data.blockId, { meta: { view: "launcher" } }, false);
                setTimeout(() => WaveAIModel.getInstance().focusInput(), 50);
                return;
            }
        }
    }
    const blockCount = getStaticTabBlockCount();
    if (blockCount === 0) {
        simpleCloseStaticTab();
        return;
    }

    // If this is the last block, closing it will close the tab — route through simpleCloseStaticTab
    // so the tab:confirmclose setting is respected.
    if (blockCount === 1) {
        simpleCloseStaticTab();
        return;
    }

    const layoutModel = getLayoutModelForStaticTab();
    const focusedNode = globalStore.get(layoutModel.focusedNode);
    const blockId = focusedNode?.data?.blockId;
    const blockAtom = blockId ? WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)) : null;
    const blockData = blockAtom ? globalStore.get(blockAtom) : null;
    const isAIFileDiff = blockData?.meta?.view === "aifilediff";

    fireAndForget(layoutModel.closeFocusedNode.bind(layoutModel));

    if (isAIFileDiff && isAIPanelOpen) {
        setTimeout(() => WaveAIModel.getInstance().focusInput(), 50);
    }
}

function switchBlockByBlockNum(index: number) {
    const layoutModel = getLayoutModelForStaticTab();
    if (!layoutModel) {
        return;
    }
    layoutModel.switchNodeFocusByBlockNum(index);
    setTimeout(() => {
        globalRefocus();
    }, 10);
}

function switchBlockInDirection(direction: NavigateDirection) {
    const layoutModel = getLayoutModelForStaticTab();
    const focusType = FocusManager.getInstance().getFocusType();

    if (direction === NavigateDirection.Left) {
        const numBlocks = globalStore.get(layoutModel.numLeafs);
        if (focusType === "waveai") {
            return;
        }
        if (numBlocks === 1) {
            FocusManager.getInstance().requestWaveAIFocus();
            setTimeout(() => {
                FocusManager.getInstance().refocusNode();
            }, 10);
            return;
        }
    }

    if (direction === NavigateDirection.Right && focusType === "waveai") {
        FocusManager.getInstance().requestNodeFocus();
        return;
    }

    const inWaveAI = focusType === "waveai";
    const navResult = layoutModel.switchNodeFocusInDirection(direction, inWaveAI);
    if (navResult.atLeft) {
        FocusManager.getInstance().requestWaveAIFocus();
        setTimeout(() => {
            FocusManager.getInstance().refocusNode();
        }, 10);
        return;
    }
    setTimeout(() => {
        globalRefocus();
    }, 10);
}

function getAllTabs(ws: Workspace): string[] {
    return ws.tabids ?? [];
}

function switchTabAbs(index: number) {
    console.log("switchTabAbs", index);
    const ws = globalStore.get(atoms.workspace);
    const newTabIdx = index - 1;
    const tabids = getAllTabs(ws);
    if (newTabIdx < 0 || newTabIdx >= tabids.length) {
        return;
    }
    const newActiveTabId = tabids[newTabIdx];
    getApi().setActiveTab(newActiveTabId);
}

function switchTab(offset: number) {
    console.log("switchTab", offset);
    const ws = globalStore.get(atoms.workspace);
    const curTabId = globalStore.get(atoms.staticTabId);
    let tabIdx = -1;
    const tabids = getAllTabs(ws);
    for (let i = 0; i < tabids.length; i++) {
        if (tabids[i] == curTabId) {
            tabIdx = i;
            break;
        }
    }
    if (tabIdx == -1) {
        return;
    }
    const newTabIdx = (tabIdx + offset + tabids.length) % tabids.length;
    const newActiveTabId = tabids[newTabIdx];
    getApi().setActiveTab(newActiveTabId);
}

function handleCmdI() {
    globalRefocus();
}

function globalRefocusWithTimeout(timeoutVal: number) {
    setTimeout(() => {
        globalRefocus();
    }, timeoutVal);
}

function globalRefocus() {
    if (isBuilderWindow()) {
        return;
    }

    const layoutModel = getLayoutModelForStaticTab();
    const focusedNode = globalStore.get(layoutModel.focusedNode);
    if (focusedNode == null) {
        // focus a node
        layoutModel.focusFirstNode();
        return;
    }
    const blockId = focusedNode?.data?.blockId;
    if (blockId == null) {
        return;
    }
    refocusNode(blockId);
}

function getDefaultNewBlockDef(): BlockDef {
    const adnbAtom = getSettingsKeyAtom("app:defaultnewblock");
    const adnb = globalStore.get(adnbAtom) ?? "term";
    if (adnb == "launcher") {
        return {
            meta: {
                view: "launcher",
            },
        };
    }
    // "term", blank, anything else, fall back to terminal
    const termBlockDef: BlockDef = {
        meta: {
            view: "term",
            controller: "shell",
        },
    };
    const layoutModel = getLayoutModelForStaticTab();
    const focusedNode = globalStore.get(layoutModel.focusedNode);
    if (focusedNode != null) {
        const blockAtom = WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", focusedNode.data?.blockId));
        const blockData = globalStore.get(blockAtom);
        if (blockData?.meta?.view == "term") {
            if (blockData?.meta?.["cmd:cwd"] != null) {
                termBlockDef.meta["cmd:cwd"] = blockData.meta["cmd:cwd"];
            }
        }
        if (blockData?.meta?.connection != null) {
            termBlockDef.meta.connection = blockData.meta.connection;
        }
    }
    return termBlockDef;
}

async function handleCmdN() {
    const blockDef = getDefaultNewBlockDef();
    await createBlock(blockDef);
}

async function handleSplitHorizontal(position: "before" | "after") {
    const layoutModel = getLayoutModelForStaticTab();
    const focusedNode = globalStore.get(layoutModel.focusedNode);
    if (focusedNode == null) {
        return;
    }
    const blockDef = getDefaultNewBlockDef();
    await createBlockSplitHorizontally(blockDef, focusedNode.data.blockId, position);
}

async function handleSplitVertical(position: "before" | "after") {
    const layoutModel = getLayoutModelForStaticTab();
    const focusedNode = globalStore.get(layoutModel.focusedNode);
    if (focusedNode == null) {
        return;
    }
    const blockDef = getDefaultNewBlockDef();
    await createBlockSplitVertically(blockDef, focusedNode.data.blockId, position);
}

let lastHandledEvent: KeyboardEvent | null = null;

// returns [keymatch, T]
function checkKeyMap<T>(waveEvent: WaveKeyboardEvent, keyMap: Map<string, T>): [string, T] {
    for (const key of keyMap.keys()) {
        if (keyutil.checkKeyPressed(waveEvent, key)) {
            const val = keyMap.get(key);
            return [key, val];
        }
    }
    return [null, null];
}

function appHandleKeyDown(waveEvent: WaveKeyboardEvent): boolean {
    if (globalKeybindingsDisabled) {
        return false;
    }
    const nativeEvent = (waveEvent as any).nativeEvent;
    if (lastHandledEvent != null && nativeEvent != null && lastHandledEvent === nativeEvent) {
        return false;
    }
    lastHandledEvent = nativeEvent;
    if (activeChord) {
        console.log("handle activeChord", activeChord);
        // If we're in chord mode, look for the second key.
        const chordBindings = globalChordMap.get(activeChord);
        const [, handler] = checkKeyMap(waveEvent, chordBindings);
        if (handler) {
            resetChord();
            return handler(waveEvent);
        } else {
            // invalid chord; reset state and consume key
            resetChord();
            return true;
        }
    }
    const [chordKeyMatch] = checkKeyMap(waveEvent, globalChordMap);
    if (chordKeyMatch) {
        setActiveChord(chordKeyMatch);
        return true;
    }

    const [, globalHandler] = checkKeyMap(waveEvent, globalKeyMap);
    if (globalHandler) {
        const handled = globalHandler(waveEvent);
        if (handled) {
            return true;
        }
    }
    if (isTabWindow()) {
        const layoutModel = getLayoutModelForStaticTab();
        const focusedNode = globalStore.get(layoutModel.focusedNode);
        const blockId = focusedNode?.data?.blockId;
        if (blockId != null && shouldDispatchToBlock(waveEvent)) {
            const bcm = getBlockComponentModel(blockId);
            const viewModel = bcm?.viewModel;
            if (viewModel?.keyDownHandler) {
                const handledByBlock = viewModel.keyDownHandler(waveEvent);
                if (handledByBlock) {
                    return true;
                }
            }
        }
    }
    return false;
}

function registerControlShiftStateUpdateHandler() {
    getApi().onControlShiftStateUpdate((state: boolean) => {
        if (state) {
            setControlShift();
        } else {
            unsetControlShift();
        }
    });
}

function registerElectronReinjectKeyHandler() {
    getApi().onReinjectKey((event: WaveKeyboardEvent) => {
        appHandleKeyDown(event);
    });
}

function tryReinjectKey(event: WaveKeyboardEvent): boolean {
    return appHandleKeyDown(event);
}

function countTermBlocks(): number {
    const allBCMs = getAllBlockComponentModels();
    let count = 0;
    const gsGetBound = globalStore.get.bind(globalStore);
    for (const bcm of allBCMs) {
        const viewModel = bcm.viewModel;
        if (viewModel.viewType == "term" && viewModel.isBasicTerm?.(gsGetBound)) {
            count++;
        }
    }
    return count;
}

// registerActionHandlers populates actionRegistry with all built-in named
// actions and records their default key bindings in defaultKeyBindings.
// This must be called once before applyKeybindingConfig().
function registerActionHandlers() {
    function reg(action: string, key: string, handler: KeyHandler) {
        actionRegistry.set(action, handler);
        defaultKeyBindings.push({ action, key });
    }

    reg("app:switchtab-right", "Cmd:]", () => {
        switchTab(1);
        return true;
    });
    reg("app:switchtab-right-alt", "Shift:Cmd:]", () => {
        switchTab(1);
        return true;
    });
    reg("app:switchtab-left", "Cmd:[", () => {
        switchTab(-1);
        return true;
    });
    reg("app:switchtab-left-alt", "Shift:Cmd:[", () => {
        switchTab(-1);
        return true;
    });
    reg("app:newblock", "Cmd:n", () => {
        handleCmdN();
        return true;
    });
    reg("app:split-horizontal", "Cmd:d", () => {
        handleSplitHorizontal("after");
        return true;
    });
    reg("app:split-vertical", "Shift:Cmd:d", () => {
        handleSplitVertical("after");
        return true;
    });
    reg("app:refocus", "Cmd:i", () => {
        handleCmdI();
        return true;
    });
    reg("app:newtab", "Cmd:t", () => {
        createTab();
        return true;
    });
    reg("app:closeblock", "Cmd:w", () => {
        genericClose();
        return true;
    });
    reg("app:closetab", "Cmd:Shift:w", () => {
        simpleCloseStaticTab();
        return true;
    });
    reg("app:magnify", "Cmd:m", () => {
        const layoutModel = getLayoutModelForStaticTab();
        const focusedNode = globalStore.get(layoutModel.focusedNode);
        if (focusedNode != null) {
            layoutModel.magnifyNodeToggle(focusedNode.id);
        }
        return true;
    });
    reg("app:focusblock-up", "Ctrl:Shift:ArrowUp", () => {
        const disableCtrlShiftArrows = globalStore.get(getSettingsKeyAtom("app:disablectrlshiftarrows"));
        if (disableCtrlShiftArrows) {
            return false;
        }
        switchBlockInDirection(NavigateDirection.Up);
        return true;
    });
    reg("app:focusblock-down", "Ctrl:Shift:ArrowDown", () => {
        const disableCtrlShiftArrows = globalStore.get(getSettingsKeyAtom("app:disablectrlshiftarrows"));
        if (disableCtrlShiftArrows) {
            return false;
        }
        switchBlockInDirection(NavigateDirection.Down);
        return true;
    });
    reg("app:focusblock-left", "Ctrl:Shift:ArrowLeft", () => {
        const disableCtrlShiftArrows = globalStore.get(getSettingsKeyAtom("app:disablectrlshiftarrows"));
        if (disableCtrlShiftArrows) {
            return false;
        }
        switchBlockInDirection(NavigateDirection.Left);
        return true;
    });
    reg("app:focusblock-right", "Ctrl:Shift:ArrowRight", () => {
        const disableCtrlShiftArrows = globalStore.get(getSettingsKeyAtom("app:disablectrlshiftarrows"));
        if (disableCtrlShiftArrows) {
            return false;
        }
        switchBlockInDirection(NavigateDirection.Right);
        return true;
    });
    // Vim-style aliases for block focus navigation.
    reg("app:focusblock-left-vim", "Ctrl:Shift:h", () => {
        const disableCtrlShiftArrows = globalStore.get(getSettingsKeyAtom("app:disablectrlshiftarrows"));
        if (disableCtrlShiftArrows) {
            return false;
        }
        switchBlockInDirection(NavigateDirection.Left);
        return true;
    });
    reg("app:focusblock-down-vim", "Ctrl:Shift:j", () => {
        const disableCtrlShiftArrows = globalStore.get(getSettingsKeyAtom("app:disablectrlshiftarrows"));
        if (disableCtrlShiftArrows) {
            return false;
        }
        switchBlockInDirection(NavigateDirection.Down);
        return true;
    });
    reg("app:focusblock-up-vim", "Ctrl:Shift:k", () => {
        const disableCtrlShiftArrows = globalStore.get(getSettingsKeyAtom("app:disablectrlshiftarrows"));
        if (disableCtrlShiftArrows) {
            return false;
        }
        switchBlockInDirection(NavigateDirection.Up);
        return true;
    });
    reg("app:focusblock-right-vim", "Ctrl:Shift:l", () => {
        const disableCtrlShiftArrows = globalStore.get(getSettingsKeyAtom("app:disablectrlshiftarrows"));
        if (disableCtrlShiftArrows) {
            return false;
        }
        switchBlockInDirection(NavigateDirection.Right);
        return true;
    });
    reg("app:replace-block", "Ctrl:Shift:x", () => {
        const blockId = getFocusedBlockId();
        if (blockId == null) {
            return true;
        }
        replaceBlock(
            blockId,
            {
                meta: {
                    view: "launcher",
                },
            },
            true
        );
        return true;
    });
    reg("app:rename-tab", "F2", () => {
        const tabModel = getActiveTabModel();
        if (tabModel?.startRenameCallback != null) {
            tabModel.startRenameCallback();
            return true;
        }
        return false;
    });
    reg("app:connection-switcher", "Cmd:g", () => {
        const bcm = getBlockComponentModel(getFocusedBlockInStaticTab());
        if (bcm.openSwitchConnection != null) {
            recordTEvent("action:other", { "action:type": "conndropdown", "action:initiator": "keyboard" });
            bcm.openSwitchConnection();
            return true;
        }
        return false;
    });
    reg("app:multiinput-toggle", "Ctrl:Shift:i", () => {
        const tabModel = getActiveTabModel();
        if (tabModel == null) {
            return true;
        }
        const curMI = globalStore.get(tabModel.isTermMultiInput);
        if (!curMI && countTermBlocks() <= 1) {
            return true;
        }
        globalStore.set(tabModel.isTermMultiInput, !curMI);
        return true;
    });
    for (let idx = 1; idx <= 9; idx++) {
        const i = idx;
        reg(`app:switchtab-${i}`, `Cmd:${i}`, () => {
            switchTabAbs(i);
            return true;
        });
        reg(`app:switchblock-${i}`, `Ctrl:Shift:c{Digit${i}}`, () => {
            switchBlockByBlockNum(i);
            return true;
        });
        reg(`app:switchblock-numpad-${i}`, `Ctrl:Shift:c{Numpad${i}}`, () => {
            switchBlockByBlockNum(i);
            return true;
        });
    }
    if (isWindows()) {
        reg("app:focus-ai", "Alt:c{Digit0}", () => {
            WaveAIModel.getInstance().focusInput();
            return true;
        });
        reg("app:focus-ai-numpad", "Alt:c{Numpad0}", () => {
            WaveAIModel.getInstance().focusInput();
            return true;
        });
    } else {
        reg("app:focus-ai", "Ctrl:Shift:c{Digit0}", () => {
            WaveAIModel.getInstance().focusInput();
            return true;
        });
        reg("app:focus-ai-numpad", "Ctrl:Shift:c{Numpad0}", () => {
            WaveAIModel.getInstance().focusInput();
            return true;
        });
    }

    function activateSearch(event: WaveKeyboardEvent): boolean {
        const bcm = getBlockComponentModel(getFocusedBlockInStaticTab());
        if (event.control && bcm.viewModel.viewType == "term") {
            return false;
        }
        if (bcm.viewModel.searchAtoms) {
            if (globalStore.get(bcm.viewModel.searchAtoms.isOpen)) {
                const cur = globalStore.get(bcm.viewModel.searchAtoms.focusInput) as number;
                globalStore.set(bcm.viewModel.searchAtoms.focusInput, cur + 1);
            } else {
                globalStore.set(bcm.viewModel.searchAtoms.isOpen, true);
            }
            return true;
        }
        return false;
    }
    function deactivateSearch(): boolean {
        const bcm = getBlockComponentModel(getFocusedBlockInStaticTab());
        if (bcm.viewModel.searchAtoms && globalStore.get(bcm.viewModel.searchAtoms.isOpen)) {
            globalStore.set(bcm.viewModel.searchAtoms.isOpen, false);
            return true;
        }
        return false;
    }
    reg("app:search-open", "Cmd:f", activateSearch);
    reg("app:escape", "Escape", () => {
        if (modalsModel.hasOpenModals()) {
            modalsModel.popModal();
            return true;
        }
        if (deactivateSearch()) {
            return true;
        }
        return false;
    });
    reg("app:ai-panel-toggle", "Cmd:Shift:a", () => {
        const currentVisible = WorkspaceLayoutModel.getInstance().getAIPanelVisible();
        WorkspaceLayoutModel.getInstance().setAIPanelVisible(!currentVisible);
        return true;
    });
}

// applyKeybindingConfig rebuilds globalKeyMap by taking the defaults from
// defaultKeyBindings and applying any user overrides from keybindings.json.
// Call this at startup (after registerActionHandlers) and whenever the
// keybindings config changes.
function applyKeybindingConfig(keybindings?: { [action: string]: KeybindingConfigType }) {
    globalKeyMap.clear();

    // Build a lookup from action → effective key (or null if disabled)
    const overrideMap = new Map<string, string | null>();
    if (keybindings) {
        for (const [action, cfg] of Object.entries(keybindings)) {
            if (cfg.disabled) {
                overrideMap.set(action, null);
            } else if (cfg.key) {
                overrideMap.set(action, cfg.key);
            }
        }
    }

    for (const { action, key: defaultKey } of defaultKeyBindings) {
        const handler = actionRegistry.get(action);
        if (!handler) continue;

        if (overrideMap.has(action)) {
            const overrideKey = overrideMap.get(action);
            if (overrideKey != null) {
                // remapped to a different key
                globalKeyMap.set(overrideKey, handler);
            }
            // else: disabled — don't register
        } else {
            // use the default key
            globalKeyMap.set(defaultKey, handler);
        }
    }

    // Register user-defined blockdef keybindings. These are purely custom
    // entries (action name is a user label) that open a new block when pressed.
    // A blockdef entry takes precedence over any built-in action with the same key.
    if (keybindings) {
        for (const [, cfg] of Object.entries(keybindings)) {
            if (cfg.blockdef && cfg.key && !cfg.disabled) {
                const blockDef = cfg.blockdef;
                globalKeyMap.set(cfg.key, () => {
                    fireAndForget(() => createBlock(blockDef));
                    return true;
                });
            }
        }
    }

    // The chord map (split-block shortcuts) is independent of the action registry
    // for now; rebuild it with defaults.
    globalChordMap.clear();
    const splitBlockKeys = new Map<string, KeyHandler>();
    splitBlockKeys.set("ArrowUp", () => {
        handleSplitVertical("before");
        return true;
    });
    splitBlockKeys.set("ArrowDown", () => {
        handleSplitVertical("after");
        return true;
    });
    splitBlockKeys.set("ArrowLeft", () => {
        handleSplitHorizontal("before");
        return true;
    });
    splitBlockKeys.set("ArrowRight", () => {
        handleSplitHorizontal("after");
        return true;
    });
    globalChordMap.set("Ctrl:Shift:s", splitBlockKeys);
}

function registerGlobalKeys() {
    registerActionHandlers();
    const fullConfig = globalStore.get(atoms.fullConfigAtom);
    applyKeybindingConfig(fullConfig?.keybindings);

    // Re-apply keybinding config whenever fullConfigAtom changes (e.g. after
    // the user edits keybindings.json and the watcher pushes a new config).
    globalStore.sub(atoms.fullConfigAtom, () => {
        const newConfig = globalStore.get(atoms.fullConfigAtom);
        applyKeybindingConfig(newConfig?.keybindings);
        // Re-register the updated key list with the webview.
        const allKeys = Array.from(globalKeyMap.keys());
        allKeys.push("Cmd:l", "Cmd:r", "Cmd:ArrowRight", "Cmd:ArrowLeft", "Cmd:o");
        getApi().registerGlobalWebviewKeys(allKeys);
    });

    const allKeys = Array.from(globalKeyMap.keys());
    // special case keys, handled by web view
    allKeys.push("Cmd:l", "Cmd:r", "Cmd:ArrowRight", "Cmd:ArrowLeft", "Cmd:o");
    getApi().registerGlobalWebviewKeys(allKeys);
}

function registerBuilderGlobalKeys() {
    globalKeyMap.set("Cmd:w", () => {
        getApi().closeBuilderWindow();
        return true;
    });
    const allKeys = Array.from(globalKeyMap.keys());
    getApi().registerGlobalWebviewKeys(allKeys);
}

function getAllGlobalKeyBindings(): string[] {
    const allKeys = Array.from(globalKeyMap.keys());
    return allKeys;
}

export {
    appHandleKeyDown,
    applyKeybindingConfig,
    disableGlobalKeybindings,
    enableGlobalKeybindings,
    getSimpleControlShiftAtom,
    globalRefocus,
    globalRefocusWithTimeout,
    registerBuilderGlobalKeys,
    registerControlShiftStateUpdateHandler,
    registerElectronReinjectKeyHandler,
    registerGlobalKeys,
    tryReinjectKey,
    unsetControlShift,
    uxCloseBlock,
};
