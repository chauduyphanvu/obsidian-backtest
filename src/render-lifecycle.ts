// Renders the Continuous Reality Tape header strip: Deployment status (Live vN vs. Draft vN+1), Bootstrap Cone
// live percentile, Implementation Shortfall breakdown (data revisions, slippage drift, execution lag, human overrides),
// and executable `invalidate when` Kill-Switch status banner.

import { h } from './dom.ts';
import { isoDate, minus, pct, signedPct } from './format.ts';
import type { KillSwitchReport } from './killswitch.ts';
import type { DeploymentCommit, RealityTape } from './lifecycle.ts';

export interface LifecyclePanelOptions {
  commit: DeploymentCommit | null;
  tape: RealityTape | null;
  killSwitch: KillSwitchReport | null;
  /** True when the block's current source text differs from the deployed commit's frozenSource. */
  hasDraftChanges: boolean;
  /** True when the strategy declares an `invalidate when` kill-switch rule (surfaces the deploy CTA on card). */
  hasKillSwitchRule?: boolean;
  onDeploy?: () => void | Promise<void>;
  onPromoteDraft?: () => void | Promise<void>;
}

/** Renders the Continuous Lifecycle & Kill-Switch strip on a strategy card (omitted on plain undeployed drafts to keep cards uncluttered). */
export function renderLifecycleStrip(parent: HTMLElement, opts: LifecyclePanelOptions): HTMLElement | null {
  if (!opts.commit && !opts.hasKillSwitchRule) return null;
  const box = h(parent, 'div', 'bt-lifecycle');

  if (opts.killSwitch && (opts.killSwitch.status !== 'healthy' || opts.killSwitch.error)) {
    const ks = h(box, 'div', `bt-ks bt-ks-${opts.killSwitch.status === 'halted' ? 'halted' : 'warning'}`);
    h(
      ks,
      'span',
      'bt-ks-badge',
      opts.killSwitch.error
        ? 'Stop rule error'
        : opts.killSwitch.status === 'halted'
          ? 'Stopped — stop rule tripped'
          : 'Near stop rule',
    );
    h(
      ks,
      'span',
      'bt-ks-detail',
      opts.killSwitch.error
        ? opts.killSwitch.error
        : opts.killSwitch.status === 'halted'
          ? `Tripped: ${opts.killSwitch.trippedClauses.join(' · ')}`
          : 'Within 15% of your stop rule.',
    );
  }

  const wireDeploy = (btn: HTMLButtonElement, fn: () => void | Promise<void>) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      btn.disabled = true;
      void Promise.resolve(fn()).finally(() => {
        btn.disabled = false;
      });
    });
  };
  const bar = h(box, 'div', 'bt-life-bar');
  if (!opts.commit) {
    h(bar, 'span', 'bt-life-status', 'Not tracking live yet');
    if (opts.onDeploy) {
      const btn = h(bar, 'button', 'bt-chip-button bt-life-deploy', 'Start live tracking');
      btn.type = 'button';
      wireDeploy(btn, opts.onDeploy);
    }
    return box;
  }

  const label = opts.hasDraftChanges
    ? `Live v${opts.commit.version} (${isoDate(opts.commit.deployedAt)} @${opts.commit.commitHash}) · edited`
    : `Live v${opts.commit.version} since ${isoDate(opts.commit.deployedAt)} @${opts.commit.commitHash}`;
  h(bar, 'span', `bt-life-status${opts.hasDraftChanges ? ' is-draft' : ' is-live'}`, label);
  if (opts.hasDraftChanges && opts.onPromoteDraft) {
    const btn = h(bar, 'button', 'bt-chip-button bt-life-deploy', `Update live rules → v${opts.commit.version + 1}`);
    btn.type = 'button';
    wireDeploy(btn, opts.onPromoteDraft);
  }

  if (opts.tape) {
    const sf = opts.tape.shortfall;
    const strip = h(box, 'div', 'bt-shortfall');
    const pill = (k: string, v: string, tone?: 'good' | 'warn' | 'bad') => {
      const el = h(strip, 'span', `bt-sf-pill${tone ? ` bt-sf-${tone}` : ''}`);
      h(el, 'span', 'bt-sf-k', k);
      h(el, 'span', 'bt-sf-v', v);
    };
    pill('Live bars', String(sf.liveBars));
    pill(
      'Cone percentile',
      `${Math.round(sf.livePercentile)}th`,
      sf.livePercentile < 10 ? 'bad' : sf.livePercentile < 25 ? 'warn' : 'good',
    );
    pill('Model', signedPct(sf.modelReturn));
    if (sf.realizedReturn !== null) {
      pill('Realized', signedPct(sf.realizedReturn));
      pill('Slippage drift', `${sf.slippageDriftBps >= 0 ? '+' : ''}${minus(sf.slippageDriftBps.toFixed(1))} bps`, sf.slippageDriftBps > 10 ? 'bad' : undefined);
      if (Math.abs(sf.executionLagCost) > 0.0005) pill('Lag cost', signedPct(-sf.executionLagCost), sf.executionLagCost > 0.005 ? 'warn' : undefined);
      if (Math.abs(sf.overrideCost) > 0.0005) pill('Overrides', signedPct(-sf.overrideCost), sf.overrideCost > 0.005 ? 'warn' : undefined);
    } else {
      pill('Live DD', pct(-sf.liveDrawdown));
      pill('60d SR', minus(sf.liveRollingSharpe60.toFixed(2)));
    }
  }
  return box;
}
