/// <reference types="vite/client" />
// Entry point: mount <App/>.
//
// Imports the body + chrome typefaces (iA Writer Duo's fallback is IBM Plex
// Mono; chrome is Inter) and the locked design tokens, then the app stylesheet.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';

import './design/tokens.css';
import './app.css';

import { App } from './App';

const el = document.getElementById('root');
if (!el) throw new Error('Rune: #root element missing from index.html');

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Register the offline service worker. Production builds only (dev has no sw.js
// and HMR does not want a cache in front of it), and only where supported. Any
// failure is a silent no-op — the app works fine without it.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline shell unavailable; app still runs online */
    });
  });
}
