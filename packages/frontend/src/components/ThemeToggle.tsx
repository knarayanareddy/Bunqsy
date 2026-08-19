import React from 'react';
import { useTheme } from '../theme.js';

/**
 * 🌙 / ☀️ theme switch — bunq-style pill with a gradient knob.
 * Keyboard operable (it is a real <button role="switch">) and announces state
 * to screen readers via aria-checked.
 */
export function ThemeToggle(): React.JSX.Element {
  const { theme, toggle } = useTheme();
  const isLight = theme === 'light';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isLight}
      aria-label={isLight ? 'Switch to dark theme' : 'Switch to light theme'}
      title={isLight ? 'Dark mode' : 'Light mode'}
      onClick={toggle}
      className="theme-toggle"
    >
      <span className="theme-toggle__track" aria-hidden="true">
        <span>🌙</span>
        <span>☀️</span>
      </span>
      <span className="theme-toggle__knob" aria-hidden="true">
        {isLight ? '☀️' : '🌙'}
      </span>
    </button>
  );
}
