import { createElement } from 'react'
import {
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { RootLayout } from './routes/__root'
import { BoardRoute } from './routes/index'
import { ChatRoute } from './routes/chat'

const rootRoute = createRootRoute({
  component: RootLayout,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: BoardRoute,
})

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'chat',
  component: ChatRoute,
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'settings',
  component: () =>
    createElement(
      'div',
      { className: 'text-red-500' },
      'Settings coming soon.',
    ),
})

const routeTree = rootRoute.addChildren([indexRoute, chatRoute, settingsRoute])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
