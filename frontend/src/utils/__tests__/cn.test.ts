import { describe, it, expect } from 'vitest';
import { cn } from '../cn';

describe('cn', () => {
  // Regression: the design-token font sizes (`text-button`, `text-body`, ...)
  // do not look like Tailwind t-shirt sizes, so stock tailwind-merge filed
  // them under `text-color` and dropped the variant's text color that came
  // before them. Every `size="md"` Button rendered its label in the inherited
  // surface color instead of the on-interactive color.
  it('keeps a text color when a token font size follows it', () => {
    expect(cn('bg-interactive text-text-on-interactive', 'text-button'))
      .toContain('text-text-on-interactive');
    expect(cn('bg-status-error text-text-on-status-error', 'text-button'))
      .toContain('text-text-on-status-error');
  });

  it('still lets a later font size replace an earlier one', () => {
    expect(cn('text-button', 'text-sm')).toBe('text-sm');
    expect(cn('text-sm', 'text-heading-1')).toBe('text-heading-1');
  });

  it('still lets a later text color replace an earlier one', () => {
    expect(cn('text-text-on-interactive', 'text-status-error')).toBe('text-status-error');
  });
});
