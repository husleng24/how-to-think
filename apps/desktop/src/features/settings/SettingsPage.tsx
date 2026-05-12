import type { ThemeName } from '../../components/layout/types';

interface SettingsPageProps {
  theme: ThemeName;
  onThemeChange(theme: ThemeName): void;
}

export function SettingsPage({ theme, onThemeChange }: SettingsPageProps) {
  return (
    <section className="settings-page page-surface" aria-label="Settings">
      <div className="page-heading">
        <span>Preferences</span>
        <h2>Settings</h2>
        <p>Local interface preferences for this desktop session.</p>
      </div>

      <section className="page-section">
        <h3>Appearance</h3>
        <div className="segmented-control" role="group" aria-label="Theme">
          <label>
            <input
              type="radio"
              name="theme"
              checked={theme === 'light'}
              onChange={() => onThemeChange('light')}
            />
            <span>Light</span>
          </label>
          <label>
            <input
              type="radio"
              name="theme"
              checked={theme === 'dark'}
              onChange={() => onThemeChange('dark')}
            />
            <span>Dark</span>
          </label>
        </div>
      </section>

      <section className="page-section">
        <h3>Native integrations</h3>
        <p className="empty-state">
          Workspace, Markdown, Git, export, and AI commands are exposed through feature APIs.
        </p>
      </section>
    </section>
  );
}
