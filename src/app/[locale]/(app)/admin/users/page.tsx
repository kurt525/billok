import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { db } from '@/server/db';
import { requireOwner } from '@/server/lib/owner-access';
import { OwnerUsersClient } from '@/components/admin/owner-users-client';

export default async function OwnerUsersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect(`/${locale}/login`);
  if ((await cookies()).get('sharetab-impersonate')) notFound();
  try {
    await requireOwner(db, session.user.id);
  } catch {
    notFound();
  }

  return <OwnerUsersClient />;
}
