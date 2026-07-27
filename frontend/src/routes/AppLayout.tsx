import { useEffect, useState, type ReactNode } from "react"
import { NavLink, Outlet, useLocation, useNavigate } from "react-router"
import { useAuth } from "@/lib/auth"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

/* Stroke icon set in the talent-platform style (heroicons outline paths). */
function Icon({ d, className = "size-5" }: { d: string; className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
    </svg>
  )
}

const paths = {
  beaker:
    "M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z",
  users:
    "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z",
  bell:
    "M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9",
  gear:
    "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z",
  menu: "M4 6h16M4 12h16M4 18h16",
  x: "M6 18L18 6M6 6l12 12",
  sun:
    "M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z",
  moon: "M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z",
  logout:
    "M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1",
}

const nav = [
  { to: "/harness", label: "Campaign Tester", icon: paths.beaker },
  { to: "/customers", label: "Customers", icon: paths.users },
  { to: "/tripwires", label: "Tripwires", icon: paths.bell },
]

function Wordmark() {
  return (
    <NavLink to="/harness" className="flex items-center gap-2.5">
      <span className="size-2 rounded-[2px] bg-sdfc-orange" aria-hidden />
      <span className="font-heading text-2xl font-bold tracking-wide text-white">SDFC</span>
      <span className="h-5 w-px bg-sdfc-overlay" aria-hidden />
      <span className="text-sdfc-chrome text-sm font-medium">Marketing Ops</span>
    </NavLink>
  )
}

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (localStorage.getItem("portal-theme") as "light" | "dark") ?? "light",
  )
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark")
    localStorage.setItem("portal-theme", theme)
  }, [theme])
  return { theme, toggle: () => setTheme((t) => (t === "light" ? "dark" : "light")) }
}

function SidebarNav({ children }: { children?: ReactNode }) {
  const { role } = useAuth()
  const items = role === "admin" ? [...nav, { to: "/admin", label: "Admin", icon: paths.gear }] : nav
  return (
    <nav className="mt-4 flex-1 overflow-y-auto">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            cn(
              "flex items-center border-l-2 px-6 py-3 text-sm font-medium transition-colors",
              isActive
                ? "border-sdfc-orange bg-sdfc-orange/10 text-sdfc-orange"
                : "text-sdfc-chrome-shine/85 border-transparent hover:bg-sdfc-elevated hover:text-white",
            )
          }
        >
          <span className="mr-3">
            <Icon d={item.icon} />
          </span>
          {item.label}
        </NavLink>
      ))}
      {children}
    </nav>
  )
}

export default function AppLayout() {
  const { user, role, signOut } = useAuth()
  const { theme, toggle } = useTheme()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => setDrawerOpen(false), [location.pathname])

  const initials = (user?.email ?? "?")
    .split("@")[0]
    .split(/[._-]/)
    .map((p) => p.charAt(0).toUpperCase())
    .slice(0, 2)
    .join("")

  return (
    <div className="flex h-svh flex-col">
      {/* Top bar — always navy, like the talent platform */}
      <header className="bg-sdfc-dark border-sdfc-elevated border-b">
        <div className="flex h-16 items-center justify-between px-4 md:px-6">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setDrawerOpen(true)}
              className="hover:bg-sdfc-elevated flex size-10 items-center justify-center rounded-lg text-white transition-colors md:hidden"
              aria-label="Open menu"
            >
              <Icon d={paths.menu} className="size-6" />
            </button>
            <Wordmark />
          </div>

          <div className="flex items-center gap-1.5 md:gap-3">
            <button
              onClick={toggle}
              className="text-sdfc-chrome hover:bg-sdfc-elevated flex size-10 items-center justify-center rounded-lg transition-colors hover:text-white"
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              <Icon d={theme === "dark" ? paths.sun : paths.moon} />
            </button>

            <DropdownMenu>
              <DropdownMenuTrigger className="hover:bg-sdfc-elevated flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors md:px-3">
                <span className="bg-sdfc-azul-bright flex size-8 items-center justify-center rounded-full text-sm font-medium text-white">
                  {initials}
                </span>
                <span className="text-sdfc-chrome hidden max-w-[200px] truncate text-sm sm:block">
                  {user?.email}
                </span>
                <Icon d="M19 9l-7 7-7-7" className="text-sdfc-chrome size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>
                  <div className="grid gap-1">
                    <span className="truncate text-sm font-medium">{user?.email}</span>
                    <span>
                      <Badge variant="outline">{role ?? "no role"}</Badge>
                    </span>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {role === "admin" && (
                  <DropdownMenuItem
                    onClick={() => navigate("/admin")}
                    className="flex items-center gap-2"
                  >
                    <Icon d={paths.gear} className="size-4" />
                    Admin settings
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => void signOut()} className="flex items-center gap-2">
                  <Icon d={paths.logout} className="size-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Mobile backdrop */}
        {drawerOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50 md:hidden"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
        )}

        {/* Sidebar — navy surface, orange active rail */}
        <aside
          className={cn(
            "bg-sdfc-surface fixed inset-y-0 left-0 z-50 flex w-64 flex-col text-white",
            "transform transition-transform duration-300 ease-in-out",
            "md:static md:translate-x-0",
            drawerOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <div className="border-sdfc-elevated flex items-center justify-between border-b p-4 md:hidden">
            <Wordmark />
            <button
              onClick={() => setDrawerOpen(false)}
              className="hover:bg-sdfc-elevated flex size-10 items-center justify-center rounded-lg transition-colors"
              aria-label="Close menu"
            >
              <Icon d={paths.x} />
            </button>
          </div>
          <SidebarNav />
          <div className="border-sdfc-elevated text-sdfc-chrome-medium border-t px-6 py-4 text-xs">
            San Diego FC · internal
          </div>
        </aside>

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl px-4 py-8 md:px-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
