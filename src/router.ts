import { createRootRoute, createRoute, createRouter } from '@octanejs/tanstack-router'
import { lazyRouteComponent } from './lib/lazy-route'
import App from './App.btsx'

const rootRoute = createRootRoute({
  component: App,
  notFoundComponent: lazyRouteComponent(() => import('./pages/NotFound.btsx'))
})

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: lazyRouteComponent(() => import('./pages/HomePage.btsx'))
})
export const router = createRouter({
  defaultPreload: 'intent',
  routeTree: rootRoute.addChildren([homeRoute])
})
declare module '@octanejs/tanstack-router' {
  interface Register {
    router: typeof router
  }
}
