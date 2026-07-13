'use client';

import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  clampSidebarWidth,
  resizeSidebarFromKey,
} from '@/lib/sidebar-state';

type StoredPreference = {
  width?: unknown;
  collapsed?: unknown;
};

function readPreference(storageKey: string): {
  width: number;
  collapsed: boolean;
} {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(storageKey) || '{}',
    ) as StoredPreference;
    return {
      width:
        typeof value.width === 'number'
          ? clampSidebarWidth(value.width)
          : SIDEBAR_DEFAULT_WIDTH,
      collapsed: value.collapsed === true,
    };
  } catch {
    return { width: SIDEBAR_DEFAULT_WIDTH, collapsed: false };
  }
}

export function ResizableSidebar({
  id,
  className,
  storageKey,
  label,
  children,
}: {
  id: string;
  className: string;
  storageKey: string;
  label: string;
  children: (collapsed: boolean, toggleCollapsed: () => void) => ReactNode;
}) {
  const [width, setWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [collapsed, setCollapsed] = useState(false);
  const lastExpandedWidth = useRef(SIDEBAR_DEFAULT_WIDTH);
  const preferencesReady = useRef(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const preference = readPreference(storageKey);
      lastExpandedWidth.current = preference.width;
      setWidth(preference.width);
      setCollapsed(preference.collapsed);
      preferencesReady.current = true;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [storageKey]);

  useEffect(() => {
    if (!preferencesReady.current) return;
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ width, collapsed }),
    );
  }, [collapsed, storageKey, width]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      if (!current) lastExpandedWidth.current = width;
      return !current;
    });
  }, [width]);

  const resizeTo = useCallback((nextWidth: number) => {
    const clamped = clampSidebarWidth(nextWidth);
    lastExpandedWidth.current = clamped;
    setWidth(clamped);
    setCollapsed(false);
  }, []);

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = collapsed ? lastExpandedWidth.current : width;
    resizeTo(startWidth);

    const move = (next: globalThis.PointerEvent) => {
      resizeTo(startWidth + next.clientX - startX);
    };

    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.body.classList.remove('studio-sidebar-resizing');
    };

    document.body.classList.add('studio-sidebar-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
  };

  const resizeFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      toggleCollapsed();
      return;
    }

    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return;
    }

    event.preventDefault();
    resizeTo(
      resizeSidebarFromKey(
        collapsed ? lastExpandedWidth.current : width,
        event.key,
      ),
    );
  };

  const renderedWidth = collapsed
    ? SIDEBAR_COLLAPSED_WIDTH
    : width;
  const style = { width: `${renderedWidth}px` } as CSSProperties;

  return (
    <aside
      id={id}
      className={`${className} studio-resizable-sidebar ${
        collapsed ? 'is-collapsed' : ''
      }`}
      style={style}
      aria-label={label}
    >
      {children(collapsed, toggleCollapsed)}

      <div
        className="studio-sidebar-separator"
        role="separator"
        tabIndex={0}
        aria-label={`Resize ${label}`}
        aria-controls={id}
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_COLLAPSED_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={renderedWidth}
        onPointerDown={beginResize}
        onKeyDown={resizeFromKeyboard}
      />
    </aside>
  );
}
