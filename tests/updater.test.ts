import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isRealFeed } from '../src/main/updater.js';

/**
 * The feed predicate decides whether a shop ever receives an update, and it
 * fails silently in both directions: too strict and nobody is ever updated,
 * too loose and every offline counter logs a failed request on each boot.
 */
describe('isRealFeed', () => {
  it('accepts the GitHub Releases feed the build publishes to', () => {
    expect(isRealFeed('https://github.com/malikHarisawan/jewel-pos/releases/download/v1.2.0')).toBe(
      true,
    );
    expect(isRealFeed('https://api.github.com/repos/malikHarisawan/jewel-pos/releases')).toBe(true);
  });

  it('accepts an ordinary https host', () => {
    expect(isRealFeed('https://updates.example-shop.pk/jewel-pos/')).toBe(true);
  });

  it('rejects the placeholder that shipped before a channel existed', () => {
    // updater.ts must keep treating this as "no channel configured", or an
    // offline shop fires a doomed request on every launch.
    expect(isRealFeed('https://example.com/updates/')).toBe(false);
  });

  it('rejects localhost, so a dev feed never reaches a shop build', () => {
    expect(isRealFeed('https://localhost:8080/updates/')).toBe(false);
  });

  it('rejects plain http — a tamperable installer is worse than none', () => {
    expect(isRealFeed('http://updates.example-shop.pk/jewel-pos/')).toBe(false);
  });

  it('rejects nothing at all', () => {
    expect(isRealFeed(null)).toBe(false);
    expect(isRealFeed(undefined)).toBe(false);
    expect(isRealFeed('')).toBe(false);
  });

  it('rejects an unparseable feed rather than throwing', () => {
    expect(isRealFeed('not a url')).toBe(false);
    expect(isRealFeed('://broken')).toBe(false);
  });
});

describe('the shipped publish config', () => {
  const yml = readFileSync('electron-builder.yml', 'utf8');

  it('points at a real release channel, not the placeholder', () => {
    // The whole point of turning auto-update on. If this regresses, shops stop
    // receiving updates and nothing else in the suite would notice.
    expect(yml).not.toMatch(/example\.com/);
    expect(yml).toMatch(/provider:\s*github/);
  });

  it('names the repository releases are published to', () => {
    expect(yml).toMatch(/owner:\s*malikHarisawan/);
    expect(yml).toMatch(/repo:\s*jewel-pos/);
  });
});
