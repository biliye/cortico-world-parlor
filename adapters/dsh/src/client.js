import en from '../locale/en.json';
import zh from '../locale/zh.json';

const packageName = 'cortico-parlor-dsh';
const slot = 'plugins.detail.actions';

window.__ModuleLoader__.load({
  id: packageName,
  factory(require) {
    const { createElement: h, useEffect, useRef, useState } = require('react');
    const { Button } = require('@deepseek-ai/dsh-client-ui-primitives');

    function ParentButton({ t }) {
      const [pending, setPending] = useState(false);
      const [failure, setFailure] = useState('');
      const [link, setLink] = useState('');
      const request = useRef();
      useEffect(() => () => request.current?.abort(), []);

      async function openParent() {
        const controller = new AbortController();
        request.current = controller;
        setPending(true);
        setFailure('');
        try {
          const response = await fetch('/api/cortico-parlor-dsh.parent', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            signal: controller.signal,
          });
          if (response.status === 409) {
            setFailure('parentKeyMissing');
            return;
          }
          if (!response.ok) throw new Error();
          const { url } = await response.json();
          const target = new URL(url);
          if (!['https:', 'http:'].includes(target.protocol) || target.pathname !== '/parent') throw new Error();
          if (controller.signal.aborted) return;
          if ('userActivation' in navigator && !navigator.userActivation.isActive) {
            setLink(target.href);
          } else {
            window.open(target.href, '_blank', 'noopener,noreferrer');
          }
        } catch {
          if (!controller.signal.aborted) setFailure('parentUnavailable');
        } finally {
          if (!controller.signal.aborted) setPending(false);
        }
      }

      return h('span', null,
        link
          ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer', onClick: () => setTimeout(() => setLink('')) },
            t('openInBrowser'))
          : h(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: pending, onClick: openParent },
            t(pending ? 'openingParent' : 'openParent')),
        failure && h('span', { role: 'status' }, t(failure)),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(packageName, { en, zh }), 'parlor: translations');
        ctx.slots.inject(slot, () => ctx.slots.register({
          name: slot, id: packageName, locale: packageName,
        }, ({ subject, t }) => subject.kind === 'bundle' && subject.pkg.name === packageName
          ? h(ParentButton, { t }) : null));
      },
    };
  },
});
