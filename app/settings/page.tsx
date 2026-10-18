import ThemeTokenEditor from '@/components/settings/ThemeTokenEditor';
import DatabaseSnapshotManager from '@/components/settings/DatabaseSnapshotManager';

export default function SettingsPage() {
  return (
    <div className="space-y-8">
      <ThemeTokenEditor />
      <div className="mx-auto max-w-3xl px-8 pb-12">
        <DatabaseSnapshotManager />
      </div>
    </div>
  );
}
