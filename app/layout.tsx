import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { Toaster } from 'sonner';
import { APP_NAME, APP_DESCRIPTION } from '@/lib/brand';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: APP_NAME,
  description: APP_DESCRIPTION,
  icons: { icon: '/favicon.ico' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={`${geist.variable} ${geistMono.variable} antialiased`}>
        {children}
        <Toaster
          theme="dark"
          position="top-right"
          toastOptions={{
            style: {
              background: 'hsl(225 16% 9%)',
              border: '1px solid hsl(225 12% 17%)',
              color: 'hsl(220 20% 96%)',
            },
          }}
        />
      </body>
    </html>
  );
}
