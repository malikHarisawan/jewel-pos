import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './i18n/index.js';
import { applyTheme, storedTheme } from './app/uiPrefs.js';

// Stamp the saved theme before the first paint, so the app never flashes the
// warm palette on its way to the light one.
applyTheme(storedTheme());
import { App } from './app/App.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
