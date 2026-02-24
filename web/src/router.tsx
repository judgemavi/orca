import {
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import App from './App'
import { TasksPage } from './pages/TasksPage'
import { TaskDetailPage } from './pages/TaskDetailPage'
import { ConfigPage } from './pages/ConfigPage'

const rootRoute = createRootRoute({
  component: App,
})

const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: TasksPage,
})

const taskDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks/$taskId',
  component: TaskDetailPage,
})

const configRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/config',
  component: ConfigPage,
})

const routeTree = rootRoute.addChildren([tasksRoute, taskDetailRoute, configRoute])

export const router = createRouter({ routeTree, basepath: '/ui' })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
