// jsdom + jest-dom matchers wired into Vitest's `expect` (provides
// toBeInTheDocument, toHaveTextContent, … and their type augmentation).
import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement window.scrollTo (it throws "Not implemented"); the app
// calls it when opening a saved/curated design. Stub it so those paths don't error.
window.scrollTo = (() => {}) as typeof window.scrollTo;
