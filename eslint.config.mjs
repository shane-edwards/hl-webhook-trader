import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const config = [
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Pages load their data in an effect and store it in state. That is the
      // pattern this rule forbids, but it is how every page here works and the
      // alternative (a data-fetching library) is a larger change than a lint fix.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'scripts/dev-mock/out/**'] },
];

export default config;
