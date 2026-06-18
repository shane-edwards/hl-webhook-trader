import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { Sidebar, MobileNav } from '@/components/layout/Sidebar';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <div className="lg:ml-56 flex flex-col min-h-screen">
        <main className="flex-1 overflow-auto pb-20 lg:pb-0">
          {children}
        </main>
      </div>
      <MobileNav />
    </div>
  );
}
