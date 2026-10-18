import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable]',
  '[tabindex]:not([tabindex^="-"])',
].join(', ');

export interface UseFocusTrapOptions {
  /**
   * Whether the focus trap is currently active.
   * Defaults to true.
   */
  active?: boolean;
  /**
   * Initial element to focus when the trap is activated.
   * Can be 'first-input', 'close-button', 'auto' (first input then close button then first focusable),
   * or a custom selector string or callback returning an HTMLElement.
   */
  initialFocus?: 'auto' | 'first-input' | 'close-button' | string | (() => HTMLElement | null);
  /**
   * Whether to restore focus to the previously active element upon deactivation or unmount.
   * Defaults to true.
   */
  restoreFocus?: boolean;
  /**
   * Callback fired when Escape key is pressed inside the container.
   */
  onEscape?: () => void;
}

/**
 * Returns focusable elements within container that are visible and interactive.
 */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const elements = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  );

  return elements.filter((el) => {
    // Check if element is displayed and not inert or hidden
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.closest('[aria-hidden="true"]') && el.closest('[aria-hidden="true"]') !== container) {
      return false;
    }
    // Element must have dimensions or be part of render tree
    const isVisible = !!(
      el.offsetWidth ||
      el.offsetHeight ||
      el.getClientRects().length ||
      el.tabIndex >= 0
    );
    return isVisible;
  });
}

/**
 * Hook to strictly trap Tab keyboard navigation inside a modal/dialog/drawer container,
 * automatically focus the primary input or close button on open, and restore
 * the triggering element's focus when the dialog closes.
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>({
  active = true,
  initialFocus = 'auto',
  restoreFocus = true,
  onEscape,
}: UseFocusTrapOptions = {}) {
  const containerRef = useRef<T | null>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) {
      return;
    }

    // Capture the element that had focus before opening dialog
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      previousActiveElementRef.current = document.activeElement;
    }

    const container = containerRef.current;
    if (!container) return;

    // Determine initial target element to focus
    const focusInitialElement = () => {
      const focusables = getFocusableElements(container);
      let target: HTMLElement | null = null;

      if (typeof initialFocus === 'function') {
        target = initialFocus();
      } else if (typeof initialFocus === 'string') {
        if (initialFocus === 'first-input') {
          target =
            container.querySelector<HTMLElement>(
              'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])'
            ) || null;
        } else if (initialFocus === 'close-button') {
          target =
            container.querySelector<HTMLElement>(
              'button[aria-label*="close" i], button[aria-label*="cancel" i], [data-testid*="close" i]'
            ) || null;
        } else if (initialFocus === 'auto') {
          // Priority 1: Primary input/textarea/select
          const input = container.querySelector<HTMLElement>(
            'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])'
          );
          // Priority 2: Close or Cancel button
          const closeBtn = container.querySelector<HTMLElement>(
            'button[aria-label*="close" i], button[aria-label*="cancel" i], [data-testid*="close" i]'
          );
          target = input || closeBtn || focusables[0] || null;
        } else {
          // Custom selector
          target = container.querySelector<HTMLElement>(initialFocus);
        }
      }

      if (!target && focusables.length > 0) {
        target = focusables[0];
      }

      if (target && typeof target.focus === 'function') {
        target.focus();
      } else if (container.tabIndex >= 0) {
        container.focus();
      }
    };

    // Use requestAnimationFrame / timeout to ensure DOM children have rendered
    const animId = requestAnimationFrame(() => {
      focusInitialElement();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (onEscape) {
          event.preventDefault();
          onEscape();
        }
        return;
      }

      if (event.key !== 'Tab') return;

      const currentContainer = containerRef.current;
      if (!currentContainer) return;

      const focusables = getFocusableElements(currentContainer);
      if (focusables.length === 0) {
        // No focusables, prevent tabbing outside
        event.preventDefault();
        return;
      }

      const firstElement = focusables[0];
      const lastElement = focusables[focusables.length - 1];
      const activeEl = document.activeElement;

      if (event.shiftKey) {
        // Shift + Tab: if on first element or outside, cycle to last element
        if (activeEl === firstElement || !currentContainer.contains(activeEl)) {
          event.preventDefault();
          lastElement.focus();
        }
      } else {
        // Tab: if on last element or outside, cycle to first element
        if (activeEl === lastElement || !currentContainer.contains(activeEl)) {
          event.preventDefault();
          firstElement.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      cancelAnimationFrame(animId);
      document.removeEventListener('keydown', handleKeyDown);

      if (restoreFocus && previousActiveElementRef.current) {
        try {
          if (typeof previousActiveElementRef.current.focus === 'function') {
            previousActiveElementRef.current.focus();
          }
        } catch {
          // Element might no longer be in document
        }
      }
    };
  }, [active, initialFocus, restoreFocus, onEscape]);

  return containerRef;
}

export default useFocusTrap;
