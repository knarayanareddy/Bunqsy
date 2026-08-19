import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App.js';
import { applyTheme, resolveInitialTheme } from './theme.js';

// Belt-and-braces: index.html sets this pre-paint, this covers any host that
// strips inline scripts (strict CSP).
applyTheme(resolveInitialTheme());

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
