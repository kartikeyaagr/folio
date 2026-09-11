'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Six destinations, not twenty.
 *
 * The rail is the one fixed point on the screen: navy in both themes, the same six hubs on every
 * page. Which hub is lit is read off the URL, so a page never has to say where it lives.
 *
 * Inside a hub, pages are tabs. Filings live under Desk rather than becoming a hub of their own,
 * because a filing is something that happened — the same question the desk answers, over a longer
 * window.
 *
 * Chat is last, and the order is the order of the working day: what happened, then what is being
 * said about it, then what we own, then the names, then what ran unattended — and last, what you
 * asked. It carries no badge on purpose: a thread you left is not waiting on you.
 */

/**
 * Two numbers, both meaning "what the hub itself would show you": the desk's unacknowledged items
 * and the review queue. Anything else on the rail would be decoration.
 */
export interface RailBadges {
  desk: number;
  agents: number;
}

const HUBS: {
  key: string;
  label: string;
  href: string;
  prefixes: string[];
  icon: ReactNode;
}[] = [
  {
    key: 'desk',
    label: 'Desk',
    href: '/',
    // `/reminders` and `/calendar` were carried over from v2's route list and match nothing —
    // both live on the desk itself. Removed rather than kept as intent: a prefix for a route that
    // does not exist reads, to the next person, as a route that has gone missing.
    prefixes: ['/', '/filings'],
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      </svg>
    ),
  },
  {
    key: 'news',
    label: 'News',
    href: '/news',
    prefixes: ['/news'],
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0v-9a2 2 0 0 1 2-2h2" />
        <path d="M18 14h-8M15 18h-5M10 6h8v4h-8V6Z" />
      </svg>
    ),
  },
  {
    key: 'portfolio',
    label: 'Portfolio',
    href: '/portfolio',
    // Same as the desk's: `/transactions` and `/cash` are panes on `/portfolio`, not routes.
    prefixes: ['/portfolio'],
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
        <path d="M22 12A10 10 0 0 0 12 2v10z" />
      </svg>
    ),
  },
  {
    key: 'companies',
    label: 'Companies',
    href: '/companies',
    prefixes: ['/companies', '/company'],
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
        <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2M10 6h4M10 10h4M10 14h4M10 18h4" />
      </svg>
    ),
  },
  {
    key: 'agents',
    label: 'Agents',
    href: '/agents',
    prefixes: ['/agents', '/review'],
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 8V4H8" />
        <rect width="16" height="12" x="4" y="8" rx="2" />
        <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
      </svg>
    ),
  },
  {
    key: 'chat',
    label: 'Chat',
    // One prefix, because one route exists. A prefix for a route that does not reads, to the next
    // person, as a route that has gone missing — the reason four of them were removed in 676b375.
    href: '/chat',
    prefixes: ['/chat'],
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
];

function activeHub(pathname: string): string | null {
  for (const hub of HUBS) {
    for (const p of hub.prefixes) {
      if (p === '/' ? pathname === '/' : pathname === p || pathname.startsWith(p + '/')) {
        return hub.key;
      }
    }
  }
  return null;
}

export function Rail({
  badges,
  themeToggle,
  menu,
}: {
  badges: RailBadges;
  themeToggle: ReactNode;
  menu: ReactNode;
}) {
  const active = activeHub(usePathname() ?? '/');
  return (
    <nav className="rail" aria-label="Hubs">
      <Link href="/" className="rail-brand" title="Trisula">
        T
      </Link>
      {HUBS.map((hub) => {
        const badge = hub.key === 'desk' ? badges.desk : hub.key === 'agents' ? badges.agents : 0;
        // The badge is a bare numeral, so the title says what it counts rather than leaving a
        // reader to hear "Desk, 22" and guess.
        const title = badge > 0 ? `${hub.label} — ${badge} waiting` : hub.label;
        return (
          <Link
            key={hub.key}
            href={hub.href}
            className="rail-hub"
            aria-current={active === hub.key ? 'page' : undefined}
            title={title}
          >
            {hub.icon}
            <span>{hub.label}</span>
            {badge > 0 && <span className="rail-badge">{badge > 99 ? '99+' : badge}</span>}
          </Link>
        );
      })}
      <div className="rail-spacer" />
      {themeToggle}
      {menu}
    </nav>
  );
}
