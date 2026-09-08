'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';

/**
 * Dirty-state gate shared by every studio navigation surface (sidebar
 * links, New Chat, Settings, ⌘K palette): return false to block the
 * navigation. Pages with unsaved work (agent builder) register their
 * guard for as long as they are mounted.
 */
export type NavigationGuard = (href: string) => boolean;

type StudioNavigationValue = {
  registerGuard: (guard: NavigationGuard) => () => void;
  canNavigate: (href: string) => boolean;
};

const StudioNavigationContext = createContext<StudioNavigationValue | null>(
  null,
);

export function StudioNavigationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const guardRef = useRef<NavigationGuard | null>(null);
  const registerGuard = useCallback((guard: NavigationGuard) => {
    guardRef.current = guard;
    return () => {
      if (guardRef.current === guard) guardRef.current = null;
    };
  }, []);
  // No registered guard = allowed. Registered guard: true = allowed,
  // false = blocked.
  const canNavigate = useCallback((href: string) => {
    const guard = guardRef.current;
    return guard ? guard(href) : true;
  }, []);
  const value = useMemo(
    () => ({ registerGuard, canNavigate }),
    [registerGuard, canNavigate],
  );
  return (
    <StudioNavigationContext.Provider value={value}>
      {children}
    </StudioNavigationContext.Provider>
  );
}

export function useStudioNavigation(): StudioNavigationValue {
  const value = useContext(StudioNavigationContext);
  if (!value) throw new Error('useStudioNavigation requires StudioNavigationProvider');
  return value;
}
