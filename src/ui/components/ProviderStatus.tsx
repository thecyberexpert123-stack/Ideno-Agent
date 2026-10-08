import { useState } from 'react';
import type { Capabilities } from '../api.js';

/**
 * Provider status.
 *
 * Ideno cannot reason without a provider, so when none is configured the UI
 * says exactly what is missing and how to fix it rather than failing at the
 * first message.
 */
export function ProviderStatus({ capabilities }: { capabilities: Capabilities | null }) {
  const [open, setOpen] = useState(false);

  if (!capabilities) {
    return <span className="provider provider--unknown">checking provider…</span>;
  }

  const { ready, activeProvider, providers } = capabilities.ai;
  const active = providers.find((provider) => provider.id === activeProvider);

  return (
    <div className="provider-wrapper">
      <button
        type="button"
        className={`provider ${ready ? 'provider--ready' : 'provider--missing'}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="provider__dot" aria-hidden="true" />
        {ready ? `${active?.label ?? activeProvider} · ${active?.model ?? 'model'}` : 'no AI provider'}
      </button>

      {open ? (
        <div className="provider__panel" role="dialog" aria-label="AI provider status">
          <h3>AI runtime</h3>
          <p className="muted">
            Ideno Core never talks to a provider directly. Each adapter below implements the same
            runtime interface, so adding one changes nothing upstream.
          </p>
          <ul className="provider__list">
            {providers.map((provider) => (
              <li key={provider.id} className={provider.configured ? 'is-configured' : 'is-missing'}>
                <div className="provider__row">
                  <strong>{provider.label}</strong>
                  <span className="provider__tag">
                    {provider.id === activeProvider ? 'active' : provider.configured ? 'ready' : 'not configured'}
                  </span>
                </div>
                <p className="muted">{provider.detail}</p>
                {provider.docsUrl ? (
                  <a href={provider.docsUrl} target="_blank" rel="noreferrer noopener">
                    Provider documentation
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
          <h3>Plugins</h3>
          <ul className="provider__list">
            {capabilities.plugins.map((plugin) => (
              <li key={plugin.id} className={plugin.available ? 'is-configured' : 'is-missing'}>
                <div className="provider__row">
                  <strong>{plugin.label}</strong>
                  <span className="provider__tag">{plugin.available ? 'available' : 'off'}</span>
                </div>
                <p className="muted">{plugin.detail ?? plugin.description}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
