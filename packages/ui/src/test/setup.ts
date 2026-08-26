import "@testing-library/jest-dom/vitest";

// jsdom lacks a few APIs that Radix primitives call — polyfill them so
// Dialog/Select/DropdownMenu/Tooltip render and behave in tests.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
