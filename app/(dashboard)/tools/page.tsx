import { SignOutButton } from '@/components/layout/Sidebar';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { cryptoActivity, cryptoResearch, cryptoSections, stockHref, stockResearch } from '@/components/layout/workspaces';

const groups = [
  { name: 'Trading & accounts', links: [
    { label: 'Stock order ticket', href: stockHref('trade') },
    { label: 'Stock Autopilot', href: stockHref('autopilot') },
    { label: 'eToro connections', href: stockHref('account') },
    ...cryptoSections.filter(item => ['/dashboard', '/autopilot', '/settings'].includes(item.href))
      .map(item => ({ ...item, label: `Crypto ${item.label.toLowerCase()}` })),
    { label: 'Automation Center', href: '/automation' }, ...cryptoActivity,
  ] },
  { name: 'Stocks research', links: [
    { label: 'Strong Buys', href: '/stocks' }, { label: 'Stock entry scanner', href: stockHref('setups') }, ...stockResearch,
  ] },
  { name: 'Crypto research', links: [{ label: 'Market scanner', href: '/markets' }, ...cryptoResearch] },
];

export default function ToolsPage() {
  return <><Header /><div className="mx-auto max-w-6xl p-4 lg:p-8 grid gap-4 md:grid-cols-2">
    <div className="lg:hidden md:col-span-2"><SignOutButton /></div>
    {groups.map(group => <section key={group.name} className="surface p-4 lg:p-5 self-start">
      <h2 className="font-semibold mb-2">{group.name}</h2>
      <ul className="divide-y divide-border">{group.links.map(link => <li key={link.href}>
        <Link href={link.href} className="flex justify-between items-center gap-2 py-3 text-sm hover:text-primary">
          {link.label}<ArrowUpRight size={15} aria-hidden="true" className="text-muted-foreground" />
        </Link>
      </li>)}</ul>
    </section>)}
  </div></>;
}
