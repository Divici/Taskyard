import '@fontsource-variable/inter'
import './styles/index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import App from './App'
import { ErrorBoundary } from './components/feedback/ErrorBoundary'
import { applyInitialTheme } from './lib/theme'

// Before the first paint: the default theme (Chromium's own OS-theme guess) and glass values,
// so nothing flashes before main has answered and the settings have loaded.
applyInitialTheme(document.documentElement, DEFAULT_SETTINGS)

const container = document.getElementById('root')
if (!container) throw new Error('index.html is missing the #root element')

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
