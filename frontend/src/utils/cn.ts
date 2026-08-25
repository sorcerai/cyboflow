import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// tailwind-merge only knows Tailwind's stock scales. Our design tokens add
// custom `fontSize` keys (`text-button`, `text-body`, `text-heading-1`, ...),
// and because none of them look like a t-shirt size, stock tailwind-merge
// files them under the `text-color` group instead. That is not cosmetic: a
// class list like `text-white ... text-button` then resolves to `text-button`
// alone — the color is DROPPED — which is exactly how every `size="md"`
// Button lost its light label and inherited `--ink` from the surrounding
// surface. Declaring the tokens as font sizes puts them back in the group
// they belong to, so size and color stop cancelling each other out.
//
// Keep this list in sync with `theme.extend.fontSize` in tailwind.config.js.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'heading-1',
            'heading-2',
            'heading-3',
            'body',
            'body-sm',
            'button',
            'label',
            'caption',
          ],
        },
      ],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
