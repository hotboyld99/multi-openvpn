import { Route } from 'lucide-react';
import { EmptyState, PageHeader } from '../components/ui';

export function Routes() {
  return (
    <div>
      <PageHeader title="Routes" subtitle="Route table with per-VPN ownership" />
      <div className="px-6 pb-8">
        <EmptyState icon={<Route className="h-8 w-8" />} title="Route Inspector arrives in Phase 6">
          Phase 6 adds the OS route table reader, ownership attribution per connection, default-route conflict detection and split
          tunneling.
        </EmptyState>
      </div>
    </div>
  );
}
