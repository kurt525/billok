import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';

// BillOK exposes Russian-only canonical routes without locale prefixes.
export default async function Home() {
  const session = await auth();
  redirect(session?.user ? '/dashboard' : '/login');
}
