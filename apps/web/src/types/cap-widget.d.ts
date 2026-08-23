import type React from 'react';

// JSX typing for the @cap.js/widget custom element (side-effect-free types;
// the script itself is loaded dynamically in the browser only).
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'cap-widget': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        'data-cap-api-endpoint'?: string;
        'data-cap-hidden-field-name'?: string;
      };
    }
  }
}
