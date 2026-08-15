import { nodeConfig } from '@xitter/eslint-config';

// CLI utilities: console output is the interface.
export default nodeConfig.map((config) =>
  'rules' in config && config.rules && 'no-console' in config.rules
    ? { ...config, rules: { ...config.rules, 'no-console': 'off' } }
    : config,
);
