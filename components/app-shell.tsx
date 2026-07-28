"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { Bell, Bot, ChevronDown, CircleHelp, Cpu, FolderOpen, Gamepad2, GraduationCap, Home, ListTodo, PlusCircle, Search, Settings2 } from "lucide-react";
import { ReactNode } from "react";

const navigation: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Home", icon: Home },
  { href: "/new-job", label: "New Job", icon: PlusCircle },
  { href: "/jobs", label: "Jobs", icon: ListTodo },
  { href: "/assets", label: "Assets", icon: FolderOpen },
  { href: "/training-policies", label: "Training & Policies", icon: GraduationCap },
  { href: "/simulation", label: "Simulation", icon: Gamepad2 },
  { href: "/compute-costs", label: "Compute & Costs", icon: Cpu },
  { href: "/settings", label: "Settings & Integrations", icon: Settings2 },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="RoboMotion home"><span className="brand__mark"><Bot size={19} strokeWidth={2.1} /></span><span>RoboMotion</span></Link>
        <nav aria-label="Main navigation">
          {navigation.map(({ href, label, icon: Icon }) => {
            const active = href === "/" ? pathname === href : pathname.startsWith(href);
            return <Link className={`nav-link${active ? " nav-link--active" : ""}`} href={href} key={href}><span className="nav-link__icon"><Icon size={17} strokeWidth={active ? 2.25 : 1.8} /></span><span>{label}</span></Link>;
          })}
        </nav>
        <div className="sidebar__bottom">
          <div className="sidebar-user"><span className="avatar avatar--large">AR</span><span><b>Motion Lab</b><small>Administrator</small></span><ChevronDown size={15} /></div>
          <div className="system-status"><span className="availability-dot" /> <span><b>System status</b><small>All systems operational</small></span></div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <button className="topbar-search" aria-label="Search"><Search size={18} /><span>Search workspace</span></button>
          <div className="topbar__actions"><button className="icon-button" aria-label="Help"><CircleHelp size={19} /></button><button className="icon-button notification-button" aria-label="Notifications"><Bell size={19} /><i>3</i></button><button className="avatar" aria-label="Open user menu">AR</button><ChevronDown className="user-chevron" size={15} /></div>
        </header>
        <div className="page-content">{children}</div>
      </main>
    </div>
  );
}
