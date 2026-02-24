import {
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import App from './App'
import { TasksPage } from './pages/TasksPage'
import { TaskDetailPage } from './pages/TaskDetailPage'

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

const routeTree = rootRoute.addChildren([tasksRoute, taskDetailRoute])

export const router = createRouter({ routeTree, basepath: '/ui' })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
