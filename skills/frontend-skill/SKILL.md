---
name: frontend-skill
description: Frontend UI development skill covering component architecture, WCAG accessibility, responsive design, state management, client-side testing, and styling methodologies. Trigger on: frontend, UI, component, accessibility, styling.
---

# Frontend Skill

## OVERVIEW

Covers all aspects of client-side interface development including component architecture, accessibility compliance (WCAG 2.1+), responsive layout strategies, state management patterns, client-side testing approaches, and styling systems. Scope is bounded to browser-rendered UI layers and their supporting client logic; does not cover server-side rendering configuration, build toolchain setup, or deployment infrastructure.

## CONVENTIONS

- Detect the project's framework (React, Vue, Angular, Svelte, vanilla JS) before applying any patterns. Never assume a framework.
- Components must be single-responsibility, composable, and accept configuration exclusively through props/attributes — no global mutable state leakage.
- All interactive elements must support keyboard navigation (Tab, Enter, Escape, Arrow keys) and carry appropriate ARIA attributes where semantic HTML is insufficient.
- Color contrast ratios must meet WCAG 2.1 AA minimum: 4.5:1 for normal text, 3:1 for large text and UI components.
- Responsive design follows mobile-first breakpoint strategy with breakpoints defined in a centralized token system, not scattered magic numbers.
- State management follows the colocation principle: local component state first, then context/provider lifting, then global store only when data crosses unrelated component tree branches.
- Styling methodology must match the existing project convention (CSS Modules, Tailwind, Styled Components, Sass, vanilla CSS). Never introduce a new methodology unless the project has none.
- All user-facing strings must be externalized into translation-ready resources. No hardcoded literals in templates.

## CHECKLIST

- [ ] Component follows single-responsibility principle with clearly typed prop interface
- [ ] All interactive elements are keyboard-navigable with visible focus indicators
- [ ] ARIA roles, labels, and live regions applied where semantic HTML falls short
- [ ] Color contrast verified against WCAG 2.1 AA thresholds for all text and UI elements
- [ ] Focus management handled for dynamic content (modals, dialogs, route transitions)
- [ ] Responsive layout validated at all defined breakpoints with no horizontal overflow
- [ ] State scoped to the smallest necessary component or context boundary
- [ ] No inline styles unless dynamically computed from props at render time
- [ ] Loading, error, and empty states implemented for every async data consumer
- [ ] Client-side tests cover rendering output, user interactions, and accessibility assertions
- [ ] User-facing strings externalized into i18n resource files
- [ ] Performance: unnecessary re-renders eliminated, memoization applied where profiling confirms benefit
- [ ] No browser API calls (localStorage, sessionStorage, navigator) without graceful degradation fallbacks

## PATTERNS

### Component Composition over Inheritance

Prefer composing smaller components into larger ones rather than deep prop drilling or inheritance chains. Use slots, children props, or render props to allow consumer customization of internals.

```jsx
// Composition pattern — consumer controls internal structure
<Modal>
  <Modal.Header title="Confirm Action" />
  <Modal.Body>{children}</Modal.Body>
  <Modal.Footer>
    <Button variant="primary">Confirm</Button>
    <Button variant="secondary" onClick={onCancel}>
      Cancel
    </Button>
  </Modal.Footer>
</Modal>
```

### Responsive Breakpoint Tokens

Define breakpoints as design tokens consumed by both CSS and JavaScript. Never hardcode pixel values in component logic.

```css
:root {
  --bp-sm: 640px;
  --bp-md: 768px;
  --bp-lg: 1024px;
  --bp-xl: 1280px;
}
```

### State Colocation

Place state in the component that both reads and writes it. Lift state only when multiple sibling components require the same value. Escalate to global store only when data crosses unrelated branches of the component tree.

### Error Boundary Isolation

Wrap feature trees with error boundaries to contain failures. Display a meaningful fallback UI instead of crashing the entire application shell.

### Progressive Enhancement for Browser APIs

Always provide fallbacks for browser-specific APIs. Feature-detect before use, never assume capability.

```js
const storage =
  typeof localStorage !== "undefined"
    ? localStorage
    : { getItem: () => null, setItem: () => {}, removeItem: () => {} };
```

## CONSTRAINTS

- Do not modify build configuration, bundler settings, or CI/CD pipeline files.
- Do not introduce a new styling methodology if one already exists in the project.
- Do not hardcode dimensions; use relative units (rem, em, %, vw/vh) and design tokens exclusively.
- Do not skip accessibility checks for any user-facing element — this is non-negotiable.
- Do not store sensitive data (API keys, auth tokens, PII) in client-side code or localStorage without explicit security review approval.
- Do not create components that directly manipulate the DOM; use the framework's abstraction layer exclusively.
- Do not couple components to specific routing implementations; abstract route transitions behind a navigation service.
