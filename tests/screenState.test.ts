import { describe, it, expect, beforeEach } from 'vitest';
import {
  readScreenState,
  writeScreenState,
  clearScreenState,
  clearAllScreenState,
} from '../src/renderer/src/lib/screenState.js';

/* The store is what makes a half-typed item survive a trip to another screen.
   Its two dangerous edges are both about staleness: a draft that outlives the
   person who typed it, and a draft that leaks between two forms. */
describe('screen state store', () => {
  beforeEach(() => clearAllScreenState());

  it('hands back what was written', () => {
    writeScreenState('items.search', 'kangan');
    expect(readScreenState('items.search')).toBe('kangan');
  });

  it('returns undefined for a screen never visited', () => {
    expect(readScreenState('nothing.here')).toBeUndefined();
  });

  it('keeps falsy values rather than treating them as absent', () => {
    // An empty search box and a zero discount are real, restorable values.
    writeScreenState('a', '');
    writeScreenState('b', 0);
    writeScreenState('c', false);
    expect(readScreenState('a')).toBe('');
    expect(readScreenState('b')).toBe(0);
    expect(readScreenState('c')).toBe(false);
  });

  it('keeps separate keys apart', () => {
    // The new-item form and an edit of item 7 must never see each other.
    writeScreenState('items.form.new', { name: 'draft' });
    writeScreenState('items.form.7', { name: 'seven' });
    expect(readScreenState('items.form.new')).toEqual({ name: 'draft' });
    expect(readScreenState('items.form.7')).toEqual({ name: 'seven' });
  });

  it('clears one key without touching the others', () => {
    writeScreenState('pos.cart', [1]);
    writeScreenState('items.search', 'ring');
    clearScreenState('pos.cart');
    expect(readScreenState('pos.cart')).toBeUndefined();
    expect(readScreenState('items.search')).toBe('ring');
  });

  it('drops everything on sign-out', () => {
    // The next person at the counter must not inherit a cart or a draft.
    writeScreenState('pos.cart', [{ id: 1 }]);
    writeScreenState('items.form.new', { name: 'half typed' });
    clearAllScreenState();
    expect(readScreenState('pos.cart')).toBeUndefined();
    expect(readScreenState('items.form.new')).toBeUndefined();
  });

  it('holds nothing on disk', () => {
    // Memory-only is a deliberate choice: closing the app is a clean slate.
    writeScreenState('pos.cart', [{ id: 1 }]);
    expect(typeof localStorage === 'undefined' || localStorage.length === 0).toBe(true);
  });
});
