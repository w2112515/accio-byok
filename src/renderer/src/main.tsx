import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { App } from './App.tsx'
import { TooltipProvider } from './components/ui.tsx'
import { StoreProvider } from './lib/store.tsx'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <TooltipProvider>
        <App />
        <Toaster
          position="top-center"
          theme="system"
          offset={56}
          toastOptions={{
            classNames: {
              toast: '!rounded-xl !border !border-border !bg-surface-2 !text-fg !shadow-pop !backdrop-blur-2xl !font-sans',
              description: '!text-muted',
            },
          }}
        />
      </TooltipProvider>
    </StoreProvider>
  </StrictMode>,
)
