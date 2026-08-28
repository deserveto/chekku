import { DefaultAgentField } from '@/components/settings/default-agent-field';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {

  return (
    <>
        <header className="studio-page-header">
          <div>
            <p className="studio-eyebrow">Personal workspace</p>
            <h1>Settings</h1>
            <p>Account and workspace preferences for this Chekku installation.</p>
          </div>
        </header>
        <section className="studio-section studio-settings-grid">
          <article className="studio-panel studio-form-panel">
            <div className="studio-panel-heading">
              <span>01</span>
              <div>
                <h2>Account</h2>
                <p>Your session is managed securely through Better Auth.</p>
              </div>
            </div>
            <p className="studio-settings-note">
              Use the account menu in the sidebar to sign out. Profile editing and
              password management will appear here when those server operations are enabled.
            </p>
          </article>
          <article className="studio-panel studio-form-panel">
            <div className="studio-panel-heading">
              <span>02</span>
              <div>
                <h2>Workspace</h2>
                <p>Preferences for this browser profile.</p>
              </div>
            </div>
            <DefaultAgentField />
          </article>
        </section>
    </>
  );
}
