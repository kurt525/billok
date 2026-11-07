import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { MobileHeader } from '@/components/layout/mobile-header';
import { AnnouncementBanner } from '@/components/layout/announcement-banner';
import { ImpersonationBanner } from '@/components/layout/impersonation-banner';

export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect(`/${locale}/login`);
  }

  const isAdmin = !!process.env.ADMIN_EMAIL && session.user.email === process.env.ADMIN_EMAIL;

  return (
    <div className="min-h-dvh min-w-0">
      <MobileHeader isAdmin={isAdmin} />
      <main className="@container min-w-0">
        <ImpersonationBanner />
        <AnnouncementBanner />
        <div className="mx-auto w-full min-w-0 max-w-xl px-4 py-4 md:py-6">{children}</div>
      </main>
    </div>
  );
}
