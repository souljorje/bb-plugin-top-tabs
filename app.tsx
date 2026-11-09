// bb-plugin-top-tabs — Browser-style thread tabs across the top of bb.
//
// The strip is an app-wide overlay portaled to document.body. While it is
// mounted it injects a <style> that moves the app shell down by the strip's
// height; unmounting (plugin disabled or reloaded) removes it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp,
  experimental_resolveThreadStatus as resolveThreadStatus,
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_THREAD_ACTION_GROUPS as THREAD_ACTION_GROUPS,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbContext,
  useBbNavigate,
  useSidebarThreadDraft,
  useSidebarThreadRowStatus,
} from "@get-bb/plugin-sdk/app";

type SidebarThread = ReturnType<typeof useSidebarThreads>["threads"][number];

const STORAGE_KEY = "bb-plugin-top-tabs:v1";
const BAR_HEIGHT = 40;
const MIN_WIDTH_PX = 640;

// ---------------------------------------------------------------------------
// Persistence (per window, best effort)

function readStoredTabs(): string[] | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((id): id is string => typeof id === "string").slice(0, 200);
  } catch {
    return null;
  }
}

function writeStoredTabs(ids: readonly string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage blocked or full: tabs still work for this session.
  }
}

function toTime(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isMacDesktop(): boolean {
  const w = window as unknown as { bbDesktop?: unknown };
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
      ?.platform ?? navigator.platform ?? "";
  return typeof w.bbDesktop !== "undefined" && /mac/i.test(platform || navigator.userAgent);
}

type DesktopWindowState = { isFullScreen: boolean };
type DesktopWindowApi = {
  getWindowState?(): Promise<DesktopWindowState>;
  onWindowStateChange?(listener: (state: DesktopWindowState) => void): () => void;
};

// macOS hides the traffic lights in full screen, so the bar no longer needs
// to leave room for them. Older bb builds lack these hooks; assume windowed.
function useFullScreen(enabled: boolean): boolean {
  const [fullScreen, setFullScreen] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const desktop = (window as unknown as { bbDesktop?: DesktopWindowApi }).bbDesktop;
    let alive = true;
    const apply = (state: DesktopWindowState | undefined) => {
      if (alive && state) setFullScreen(state.isFullScreen);
    };
    const unsubscribe = desktop?.onWindowStateChange?.(apply);
    desktop?.getWindowState?.().then(apply, () => {});
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [enabled]);
  return fullScreen;
}

// ---------------------------------------------------------------------------
// Tab list state

function useTabList(activeThreadId: string | null) {
  const { status, threads, projects } = useSidebarThreads();
  const [ids, setIds] = useState<string[]>(() => readStoredTabs() ?? []);
  const seeded = useRef(readStoredTabs() !== null);

  const byId = useMemo(() => {
    const map = new Map<string, SidebarThread>();
    for (const thread of threads) map.set(thread.id, thread);
    return map;
  }, [threads]);

  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) map.set(project.id, project.name);
    return map;
  }, [projects]);

  // First run in this window: start with the open thread and the most
  // recently updated ones, so the strip is not empty.
  useEffect(() => {
    if (seeded.current || status !== "ready") return;
    seeded.current = true;
    const recent = threads
      .filter((t) => !t.isHidden && !t.isArchived)
      .slice()
      .sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt))
      .slice(0, 5)
      .map((t) => t.id);
    const initial = activeThreadId && byId.has(activeThreadId)
      ? [activeThreadId, ...recent.filter((id) => id !== activeThreadId)]
      : recent;
    setIds(initial);
  }, [status, threads, byId, activeThreadId]);

  // Opening a thread adds its tab.
  useEffect(() => {
    if (!activeThreadId || status !== "ready" || !byId.has(activeThreadId)) return;
    setIds((current) => (current.includes(activeThreadId) ? current : [...current, activeThreadId]));
  }, [activeThreadId, status, byId]);

  // Archived or deleted threads lose their tab.
  useEffect(() => {
    if (status !== "ready") return;
    setIds((current) => {
      const next = current.filter((id) => byId.has(id));
      return next.length === current.length ? current : next;
    });
  }, [status, byId]);

  useEffect(() => {
    if (seeded.current) writeStoredTabs(ids);
  }, [ids]);

  const tabs = useMemo(
    () => ids.map((id) => byId.get(id)).filter((t): t is SidebarThread => t !== undefined),
    [ids, byId],
  );

  return { tabs, setIds, projectNames, ready: status === "ready" };
}

// ---------------------------------------------------------------------------
// The strip

function ThreadTabsOverlay() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || typeof document === "undefined") return null;
  return createPortal(<ThreadTabsBar />, document.body);
}

function ThreadTabsBar() {
  const { threadId: activeThreadId } = useBbContext();
  const navigate = useBbNavigate();
  const { tabs, setIds, projectNames } = useTabList(activeThreadId);
  const [mac] = useState(isMacDesktop);
  const fullScreen = useFullScreen(mac);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const showProject = useMemo(() => new Set(tabs.map((t) => t.projectId)).size > 1, [tabs]);

  const close = useCallback(
    (ids: readonly string[]) => {
      const closing = new Set(ids);
      const order = tabs.map((t) => t.id);
      const remaining = order.filter((id) => !closing.has(id));
      setIds((current) => current.filter((id) => !closing.has(id)));
      if (activeThreadId && closing.has(activeThreadId)) {
        const index = order.indexOf(activeThreadId);
        const right = order.slice(index + 1).find((id) => !closing.has(id));
        const left = order.slice(0, index).reverse().find((id) => !closing.has(id));
        const next = right ?? left ?? remaining[0];
        if (next) navigate.toThread(next);
        else navigate.toCompose({ focusPrompt: true });
      }
    },
    [tabs, setIds, activeThreadId, navigate],
  );

  const move = useCallback(
    (id: string, targetId: string, after: boolean) => {
      if (id === targetId) return;
      setIds((current) => {
        const without = current.filter((x) => x !== id);
        const targetIndex = without.indexOf(targetId);
        if (targetIndex < 0) return current;
        without.splice(after ? targetIndex + 1 : targetIndex, 0, id);
        return without;
      });
    },
    [setIds],
  );

  // Ctrl+Tab / Ctrl+Shift+Tab cycle tabs.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.metaKey || event.altKey || event.key !== "Tab") return;
      if (tabs.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const index = activeThreadId ? tabs.findIndex((t) => t.id === activeThreadId) : -1;
      const step = event.shiftKey ? -1 : 1;
      const next = tabs[(index + step + tabs.length) % tabs.length] ?? tabs[0];
      if (next) navigate.toThread(next.id);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [tabs, activeThreadId, navigate]);

  // Keep the active tab in view when the strip scrolls. Scroll the strip
  // itself: scrollIntoView would also scroll the document, which bb resets.
  useEffect(() => {
    const strip = scrollRef.current;
    if (!activeThreadId || !strip) return;
    const el = strip.querySelector<HTMLElement>(
      `[data-thread-tab-id="${CSS.escape(activeThreadId)}"]`,
    );
    if (!el) return;
    const left = el.offsetLeft - strip.offsetLeft;
    const right = left + el.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = left - 10;
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth + 10;
  }, [activeThreadId, tabs.length]);

  const onTabDragOver = (event: DragEvent<HTMLDivElement>, id: string) => {
    if (!dragId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientX > rect.left + rect.width / 2;
    if (dropHint?.id !== id || dropHint.after !== after) setDropHint({ id, after });
  };

  const onTabDrop = (event: DragEvent<HTMLDivElement>, id: string) => {
    event.preventDefault();
    if (dragId && dropHint) move(dragId, id, dropHint.after);
    setDragId(null);
    setDropHint(null);
  };

  return (
    <>
      <style>{shellCss(mac, fullScreen)}</style>
      <div className="btt-bar" data-top-tabs-bar="" data-mac={mac ? "" : undefined}>
        <div className="btt-scroll" ref={scrollRef} role="tablist" aria-label="Open threads">
          {tabs.map((thread, index) => {
            const active = thread.id === activeThreadId;
            const nextActive = tabs[index + 1]?.id === activeThreadId;
            return (
              <ThreadTab
                key={thread.id}
                thread={thread}
                active={active}
                hideSeparator={active || nextActive || index === tabs.length - 1}
                projectName={showProject ? projectNames.get(thread.projectId) ?? null : null}
                dragging={dragId === thread.id}
                dropSide={dropHint?.id === thread.id && dragId !== thread.id ? (dropHint.after ? "after" : "before") : null}
                onActivate={(event) => {
                  navigate.toThread(thread.id, { split: event.metaKey || event.ctrlKey });
                }}
                onClose={() => close([thread.id])}
                onCloseOthers={() => close(tabs.filter((t) => t.id !== thread.id).map((t) => t.id))}
                onCloseRight={() => close(tabs.slice(index + 1).map((t) => t.id))}
                hasTabsToRight={index < tabs.length - 1}
                hasOtherTabs={tabs.length > 1}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", thread.displayTitle || thread.id);
                  setDragId(thread.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDropHint(null);
                }}
                onDragOver={(event) => onTabDragOver(event, thread.id)}
                onDrop={(event) => onTabDrop(event, thread.id)}
              />
            );
          })}
          <button
            type="button"
            className="btt-new"
            aria-label="New thread"
            title="New thread"
            onClick={() => navigate.toCompose({ focusPrompt: true })}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <div className="btt-fill" />
        </div>
      </div>
    </>
  );
}

interface ThreadTabProps {
  thread: SidebarThread;
  active: boolean;
  hideSeparator: boolean;
  projectName: string | null;
  dragging: boolean;
  dropSide: "before" | "after" | null;
  hasTabsToRight: boolean;
  hasOtherTabs: boolean;
  onActivate(event: ReactMouseEvent): void;
  onClose(): void;
  onCloseOthers(): void;
  onCloseRight(): void;
  onDragStart(event: DragEvent<HTMLDivElement>): void;
  onDragEnd(): void;
  onDragOver(event: DragEvent<HTMLDivElement>): void;
  onDrop(event: DragEvent<HTMLDivElement>): void;
}

function ThreadTab(props: ThreadTabProps) {
  const { thread, active } = props;
  const { hasUnsubmittedDraft } = useSidebarThreadDraft(thread.id);
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  const status = resolveThreadStatus({ thread, hiddenThreads: [], hasUnsubmittedDraft, rowStatus });
  const title = thread.displayTitle || thread.titleFallback || "Untitled thread";
  const actionTarget = useMemo(
    () => ({
      id: thread.id,
      projectId: thread.projectId,
      parentThreadId: thread.parentThreadId,
      parentNotifications: thread.parentNotifications,
      archivedAt: thread.archivedAt,
      pinnedAt: thread.pinnedAt,
      sectionId: thread.sectionId,
      isUnread: thread.isUnread,
      status: thread.status,
      environment: thread.environment?.id
        ? { id: thread.environment.id, path: thread.environment.path }
        : null,
    }),
    [thread],
  );
  const tooltip = [title, props.projectName, status.label].filter(Boolean).join(" · ");

  const inline = useMemo(
    () => [
      {
        key: "top-tabs-close",
        group: THREAD_ACTION_GROUPS.open,
        action: { label: "Close tab", icon: "X", run: props.onClose },
      },
      ...(props.hasOtherTabs
        ? [
            {
              key: "top-tabs-close-others",
              group: THREAD_ACTION_GROUPS.open,
              action: { label: "Close other tabs", icon: "X", run: props.onCloseOthers },
            },
          ]
        : []),
      ...(props.hasTabsToRight
        ? [
            {
              key: "top-tabs-close-right",
              group: THREAD_ACTION_GROUPS.open,
              action: { label: "Close tabs to the right", icon: "ArrowRightToLine", run: props.onCloseRight },
            },
          ]
        : []),
    ],
    [props.onClose, props.onCloseOthers, props.onCloseRight, props.hasOtherTabs, props.hasTabsToRight],
  );

  return (
    <ThreadActionsContextMenu thread={actionTarget} inline={inline} dragging={props.dragging}>
      <div
        role="tab"
        tabIndex={active ? 0 : -1}
        aria-selected={active}
        title={tooltip}
        className="btt-tab"
        data-thread-tab-id={thread.id}
        data-active={active ? "" : undefined}
        data-unread={thread.isUnread && !active ? "" : undefined}
        data-dragging={props.dragging ? "" : undefined}
        data-drop={props.dropSide ?? undefined}
        data-no-sep={props.hideSeparator ? "" : undefined}
        draggable
        onDragStart={props.onDragStart}
        onDragEnd={props.onDragEnd}
        onDragOver={props.onDragOver}
        onDrop={props.onDrop}
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault();
        }}
        onAuxClick={(event) => {
          if (event.button === 1) {
            event.preventDefault();
            props.onClose();
          }
        }}
        onClick={(event) => {
          if (event.button === 0) props.onActivate(event);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            props.onActivate(event as unknown as ReactMouseEvent);
          }
        }}
      >
        <span className="btt-glyph" aria-hidden={status.label ? undefined : true}>
          {status.indicator === "none" && !status.rowStatus ? (
            <span className="btt-dot" />
          ) : (
            <ThreadStatusGlyph indicator={status.indicator} rowStatus={status.rowStatus} size="compact" />
          )}
        </span>
        <span className="btt-title">{title}</span>
        <button
          type="button"
          className="btt-close"
          aria-label={`Close ${title}`}
          title="Close tab"
          tabIndex={-1}
          draggable={false}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            props.onClose();
          }}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </ThreadActionsContextMenu>
  );
}

// ---------------------------------------------------------------------------
// Styles. Plain CSS keyed to bb's theme tokens so light, dark and custom
// palettes follow automatically.

function shellCss(mac: boolean, fullScreen: boolean): string {
  const h = `${BAR_HEIGHT}px`;
  // The macOS traffic lights end near 66px. With the strip's own 10px (room
  // for the active tab's curved corner), the first tab sits about one button
  // gap after them. In full screen they are hidden, so no inset is needed.
  const leading = !mac ? "8px" : fullScreen ? "0px" : "60px";
  return `
/* Only #root moves. html and body keep the full window height, because bb
   compares body.clientHeight with visualViewport.height to detect an
   on-screen keyboard; a shorter body makes it rewrite the shell height on
   every focus change (the app jumps and flickers). The transform makes #root
   the containing block for bb's fixed-position sidebar. */
@media (min-width: ${MIN_WIDTH_PX}px) {
  body.bb-app-shell #root {
    --bb-shell-height: calc(100dvh - ${h}) !important;
    height: calc(100% - ${h}) !important;
    transform: translateY(${h});
  }
}
@media (max-width: ${MIN_WIDTH_PX - 1}px) {
  [data-top-tabs-bar] { display: none !important; }
}
[data-top-tabs-bar] {
  --btt-bar: var(--surface-recessed-solid, var(--muted));
  --btt-active: var(--background);
  --btt-ink: var(--foreground);
  --btt-muted: var(--muted-foreground);
  --btt-hover: color-mix(in oklab, var(--foreground) 7%, transparent);
  --btt-sep: color-mix(in oklab, var(--foreground) 16%, transparent);
  position: fixed;
  inset: 0 0 auto 0;
  height: ${h};
  z-index: 40;
  display: flex;
  align-items: stretch;
  padding-left: ${leading};
  padding-right: 8px;
  background: var(--btt-bar);
  font: 500 12px/1 var(--font-sans, Inter, system-ui, sans-serif);
  color: var(--btt-muted);
  user-select: none;
  -webkit-user-select: none;
  app-region: drag;
  -webkit-app-region: drag;
  box-sizing: border-box;
}
[data-top-tabs-bar] *, [data-top-tabs-bar] *::before, [data-top-tabs-bar] *::after { box-sizing: border-box; }
[data-top-tabs-bar] .btt-scroll {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: flex-end;
  gap: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  padding: 0 10px;
}
[data-top-tabs-bar] .btt-scroll::-webkit-scrollbar { display: none; }
[data-top-tabs-bar] .btt-fill { flex: 1 0 12px; align-self: stretch; }
[data-top-tabs-bar] .btt-tab {
  container-type: inline-size;
  position: relative;
  flex: 0 1 220px;
  min-width: 40px;
  height: 32px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 6px 0 11px;
  border-radius: 9px 9px 0 0;
  color: var(--btt-muted);
  cursor: default;
  outline: none;
  app-region: no-drag;
  -webkit-app-region: no-drag;
  transition: background-color 120ms ease, color 120ms ease;
}
[data-top-tabs-bar] .btt-tab::after {
  content: "";
  position: absolute;
  right: 0;
  top: 9px;
  bottom: 9px;
  width: 1px;
  background: var(--btt-sep);
}
[data-top-tabs-bar] .btt-tab[data-no-sep]::after { display: none; }
[data-top-tabs-bar] .btt-tab:not([data-active]):hover {
  color: var(--btt-ink);
}
[data-top-tabs-bar] .btt-tab:not([data-active]):hover::before {
  content: "";
  position: absolute;
  inset: 3px 2px 5px 2px;
  border-radius: 7px;
  background: var(--btt-hover);
  pointer-events: none;
}
[data-top-tabs-bar] .btt-tab[data-active] {
  background: var(--btt-active);
  color: var(--btt-ink);
  z-index: 1;
}
/* Chrome's flared bottom corners on the active tab. */
[data-top-tabs-bar] .btt-tab[data-active]::before,
[data-top-tabs-bar] .btt-tab[data-active]::after {
  content: "";
  display: block;
  position: absolute;
  top: auto;
  bottom: 0;
  width: 10px;
  height: 10px;
  background: radial-gradient(circle at var(--btt-cx) 0, transparent 9.5px, var(--btt-active) 10px);
}
[data-top-tabs-bar] .btt-tab[data-active]::before { left: -10px; --btt-cx: 0; }
[data-top-tabs-bar] .btt-tab[data-active]::after { right: -10px; left: auto; --btt-cx: 100%; }
[data-top-tabs-bar] .btt-tab:focus-visible { box-shadow: inset 0 0 0 2px var(--ring, var(--btt-ink)); }
[data-top-tabs-bar] .btt-tab[data-unread] .btt-title { color: var(--btt-ink); font-weight: 650; }
[data-top-tabs-bar] .btt-tab[data-dragging] { opacity: 0.45; }
[data-top-tabs-bar] .btt-tab[data-drop="before"] { box-shadow: inset 2px 0 0 var(--btt-ink); }
[data-top-tabs-bar] .btt-tab[data-drop="after"] { box-shadow: inset -2px 0 0 var(--btt-ink); }
[data-top-tabs-bar] .btt-glyph {
  position: relative;
  flex: none;
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
[data-top-tabs-bar] .btt-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.35;
}
[data-top-tabs-bar] .btt-title {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 18px), transparent);
  mask-image: linear-gradient(to right, #000 calc(100% - 18px), transparent);
}
[data-top-tabs-bar] .btt-close {
  position: relative;
  flex: none;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  padding: 0;
  opacity: 0;
  cursor: default;
  app-region: no-drag;
  -webkit-app-region: no-drag;
}
[data-top-tabs-bar] .btt-tab:hover .btt-close,
[data-top-tabs-bar] .btt-tab[data-active] .btt-close { opacity: 0.7; }
[data-top-tabs-bar] .btt-close:hover { opacity: 1 !important; background: var(--btt-hover); }
@container (max-width: 76px) {
  .btt-tab:not([data-active]) .btt-close { display: none; }
  .btt-tab .btt-title { display: none; }
}
[data-top-tabs-bar] .btt-new {
  flex: none;
  align-self: center;
  width: 28px;
  height: 28px;
  margin: 0 4px 0 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--btt-muted);
  cursor: default;
  app-region: no-drag;
  -webkit-app-region: no-drag;
}
[data-top-tabs-bar] .btt-new:hover { background: var(--btt-hover); color: var(--btt-ink); }
`;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "top-tabs",
    component: ThreadTabsOverlay,
  });
});
