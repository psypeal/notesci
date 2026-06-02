import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

window.addEventListener('unhandledrejection', (event) => {
  console.error('notesci unhandled promise rejection', event.reason)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
