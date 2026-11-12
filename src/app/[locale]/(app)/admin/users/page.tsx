import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { db } from '@/server/db';
import { OwnerUsersClient } from '@/components/admin/owner-users-client';

export default async function OwnerUsersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect(`/${locale}/login`);
  if ((await cookies()).get('sharetab-impersonate')) notFound();
  const [bootstrap, owner] = await Promise.all([
    db.ownerBootstrap.findUnique({ where: { id: 1 }, select: { userId: true, completedAt: true } }),
    db.user.findUnique({
      where: { id: session.user.id },
      select: { emailVerified: true, suspendedAt: true, isPlaceholder: true },
    }),
  ]);
  if (
    !bootstrap?.completedAt ||
    bootstrap.userId !== session.user.id ||
    !owner?.emailVerified ||
    owner.suspendedAt ||
    owner.isPlaceholder
  )
    notFound();
  return <OwnerUsersClient />;
}
