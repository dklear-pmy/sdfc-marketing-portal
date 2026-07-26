import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { createBrowserRouter, RouterProvider, Navigate } from "react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { AuthProvider, RequireAuth } from "@/lib/auth"
import AppLayout from "@/routes/AppLayout"
import Login from "@/routes/Login"
import Harness from "@/routes/Harness"
import Customers from "@/routes/Customers"
import Tripwires from "@/routes/Tripwires"
import Admin from "@/routes/Admin"
import "./index.css"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
})

const router = createBrowserRouter([
  { path: "/login", element: <Login /> },
  {
    path: "/",
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Navigate to="/harness" replace /> },
      { path: "harness", element: <Harness /> },
      { path: "customers", element: <Customers /> },
      { path: "tripwires", element: <Tripwires /> },
      { path: "admin", element: <Admin /> },
    ],
  },
])

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AuthProvider>
  </StrictMode>,
)
