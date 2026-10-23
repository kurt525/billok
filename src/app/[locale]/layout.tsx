import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { Providers } from '@/components/providers';
import { Toaster } from '@/components/ui/sonner';
import { routing, rtlLocales } from '@/i18n/routing';
import type { Locale } from '@/i18n/routing';

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jetbrains-mono',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'BillOK',
  description: 'Разделение общего чека и расчёт переводов между участниками',
  applicationName: 'BillOK',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'BillOK',
  },
};

export const viewport: Viewport = {
  themeColor: '#18181b',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!routing.locales.includes(locale as Locale)) {
    notFound();
  }

  setRequestLocale(locale);
  const messages = await getMessages();
  const dir = rtlLocales.includes(locale as Locale) ? 'rtl' : 'ltr';

  return (
    <html
      lang={locale}
      dir={dir}
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable} antialiased`}
    >
      <head>
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
      </head>
      <body className="min-h-dvh">
        <NextIntlClientProvider messages={messages}>
          <Providers>
            {children}
            <Toaster />
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
