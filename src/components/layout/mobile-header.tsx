'use client';

import { useState } from 'react';
import { Link, usePathname } from '@/i18n/navigation';
import { signOut } from 'next-auth/react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { LayoutDashboard, Users, Receipt, LogOut, Settings, Shield, Menu, Scissors } from 'lucide-react';
import { ThemeToggle } from '@/components/layout/theme-toggle';
import { useTranslations } from 'next-intl';

const navItems = [
  { href: '/dashboard', key: 'dashboard', icon: LayoutDashboard },
  { href: '/groups', key: 'groups', icon: Users },
  { href: '/split', key: 'quickSplit', icon: Receipt },
  { href: '/splits', key: 'mySplits', icon: Scissors },
  { href: '/settings', key: 'settings', icon: Settings },
] as const;

export function MobileHeader({ isAdmin }: { isAdmin?: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const t = useTranslations('common');

  return (
    <header className="sticky top-0 z-50 h-14 border-b border-border/60 bg-background/80 px-4 backdrop-blur-md supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-full w-full max-w-xl items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Receipt className="h-5 w-5 text-primary drop-shadow-sm" />
          <span className="text-lg font-bold tracking-wide">BillOK</span>
        </div>

        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger
            render={<Button variant="ghost" size="icon" className="size-11" aria-label={t('actions.openMenu')} />}
          >
            <Menu className="h-5 w-5" />
          </SheetTrigger>
          <SheetContent side="right" className="w-64 max-w-[calc(100vw-1rem)]">
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2.5">
                <Receipt className="h-5 w-5 text-primary drop-shadow-sm" />
                <span className="tracking-wide">BillOK</span>
              </SheetTitle>
            </SheetHeader>
            <nav className="mt-6 min-h-0 flex-1 space-y-1 overflow-y-auto">
              {navItems.map((item) => {
                const active = pathname === item.href || pathname.startsWith(item.href + '/');
                return (
                  <Link key={item.href} href={item.href} className="block" onClick={() => setOpen(false)}>
                    <span
                      className={cn(
                        'flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-sm leading-snug font-medium whitespace-normal break-words transition-all duration-200',
                        active
                          ? 'border-l-[3px] border-primary bg-primary/10 text-primary shadow-sm'
                          : 'border-l-[3px] border-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground',
                      )}
                    >
                      <item.icon className="h-5 w-5 shrink-0" />
                      {t(`nav.${item.key}`)}
                    </span>
                  </Link>
                );
              })}
              {isAdmin && (
                <Link href="/admin" className="block" onClick={() => setOpen(false)}>
                  <span
                    className={cn(
                      'flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-sm leading-snug font-medium whitespace-normal break-words transition-all duration-200',
                      pathname === '/admin'
                        ? 'border-l-[3px] border-primary bg-primary/10 text-primary shadow-sm'
                        : 'border-l-[3px] border-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground',
                    )}
                  >
                    <Shield className="h-5 w-5 shrink-0" />
                    {t('nav.admin')}
                  </span>
                </Link>
              )}
              <div className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2">
                <button
                  onClick={() => {
                    setOpen(false);
                    signOut({ callbackUrl: '/login' });
                  }}
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left text-sm font-medium text-muted-foreground transition-colors duration-200 hover:text-foreground"
                >
                  <LogOut className="h-5 w-5" />
                  {t('nav.signOut')}
                </button>
                <ThemeToggle className="size-11" />
              </div>
            </nav>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
