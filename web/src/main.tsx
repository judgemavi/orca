import { StrictMode } from 'react'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import './styles/global.css'
import '@tiny-bits/react-dialog/styles.css'
import ReactDOM from 'react-dom/client'
// Import the generated route tree
import { routeTree } from './routeTree.gen'

// Create a new router instance
export const router = createRouter({ routeTree, basepath: '/ui' })

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// Render the app
const rootElement = document.getElementById('root')!
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  root.render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  )
}
