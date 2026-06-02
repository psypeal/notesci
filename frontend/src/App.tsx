import { useEffect } from 'react'
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
} from 'react-router'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ToastProvider } from './components/Toast'
import { applyPrefs, PREFS_KEY } from './lib/prefs'
import { WorkspacePage } from './pages/Workspace'
import { GeneralPage } from './pages/General'
import { McpInstalledPage } from './pages/dashboard/McpInstalled'
import { McpCallsPage } from './pages/dashboard/McpCalls'
import { MarketplacePage } from './pages/dashboard/Marketplace'
import {
  ProfilePage,
  PreferencesPage,
  NotificationsPage,
  SourcesPage,
  ModelsPage,
  CitationsPage,
  LibraryPage,
  ShortcutsPage,
  ChangelogPage,
} from './pages/dashboard/Misc'
import { SkillsPage } from './pages/dashboard/Skills'
import { MemoryPage } from './pages/dashboard/Memory'

function App() {
  // Apply theme + density data-attrs on first paint, then again whenever
  // PreferencesPage broadcasts a change. Synchronous on mount so there's
  // no FOUC.
  if (typeof document !== 'undefined') {
    applyPrefs()
  }
  useEffect(() => {
    const onPrefs = () => applyPrefs()
    window.addEventListener('notesci-prefs-changed', onPrefs)
    const onStorage = (e: StorageEvent) => {
      if (e.key === PREFS_KEY) applyPrefs()
    }
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('notesci-prefs-changed', onPrefs)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return (
    <ErrorBoundary>
      <ToastProvider>
        <BrowserRouter>
          <a href="#main" className="skip-to-content">
            Skip to main content
          </a>
          <Routes>
            {/* General page — first surface on launch. Local-mode backend
                auto-bootstraps a member + session token and injects it
                into localStorage via index.html, so there's no auth UI. */}
            <Route path="/" element={<GeneralPage />} />
            <Route path="/p/:projectId" element={<WorkspacePage />} />

            {/* Dashboard / settings — account/invite/audit pages removed
                for the single-user local-desktop model. */}
            <Route
              path="/settings"
              element={<Navigate to="/settings/preferences" replace />}
            />
            <Route path="/settings/profile" element={<ProfilePage />} />
            <Route path="/settings/preferences" element={<PreferencesPage />} />
            <Route path="/settings/notifications" element={<NotificationsPage />} />
            <Route path="/settings/sources" element={<SourcesPage />} />
            <Route path="/settings/marketplace" element={<MarketplacePage />} />
            <Route
              path="/settings/mcp"
              element={<Navigate to="/settings/marketplace" replace />}
            />
            <Route path="/settings/mcp/installed" element={<McpInstalledPage />} />
            <Route path="/settings/mcp/:id/calls" element={<McpCallsPage />} />
            <Route path="/settings/models" element={<ModelsPage />} />
            <Route path="/settings/skills" element={<SkillsPage />} />
            <Route path="/settings/memory" element={<MemoryPage />} />
            <Route path="/settings/citations" element={<CitationsPage />} />
            {/* Reproducibility section retired — old bookmarks fall back to citations. */}
            <Route
              path="/settings/reproducibility"
              element={<Navigate to="/settings/citations" replace />}
            />
            <Route path="/settings/shortcuts" element={<ShortcutsPage />} />
            <Route path="/settings/changelog" element={<ChangelogPage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route
              path="/drafts"
              element={<Navigate to="/?layout=drafting" replace />}
            />

            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ErrorBoundary>
  )
}

export default App
